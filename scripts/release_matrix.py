#!/usr/bin/env python3
"""Assemble, verify and reuse the exact native/Docker artifacts accepted by CI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

import release
import release_gate
import rehearse_release

ROOT = Path(__file__).resolve().parents[1]
ARCHES = ('x86_64', 'aarch64')


def sha(path):
    with Path(path).open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def workflow_run(repo, commit, workflow, event, job):
    runs = release_gate.api_pages(
        f'repos/{repo}/actions/workflows/{workflow}/runs?head_sha={commit}&event={event}&per_page=100', 'workflow_runs')
    selected = release_gate.latest_run(runs, repo, commit, workflow, event)
    jobs = release_gate.api_pages(
        f"repos/{repo}/actions/runs/{selected['id']}/attempts/{selected['run_attempt']}/jobs?per_page=100", 'jobs')
    release_gate.require_job(jobs, selected, job)
    return selected


def download(repo, run_id, names, destination):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise release.ReleaseError(f'artifact destination must be empty: {destination}')
    command = ['gh', 'run', 'download', str(run_id), '--repo', repo, '--dir', str(destination)]
    for name in names:
        command.extend(['--name', name])
    subprocess.run(command, check=True, timeout=300)


def target_files(version, kind):
    return [release.artifact_filename(c, version) for c in release.COMPONENTS] + [
        release.manifest_filename(kind, version), release.checksum_filename()]


def native_identity(directory, target, identity):
    metadata = json.loads((directory / 'build.json').read_text())
    expected = (identity.commit, identity.version, target, 'success')
    actual = tuple(metadata.get(k) for k in ('source_commit', 'version', 'target', 'smoke'))
    if actual != expected or metadata.get('native_machine') != target.split('-')[0]:
        raise release.ReleaseError(f'{target}: mismatched or unverified native build')
    if target.endswith('musl') and metadata.get('openrc') != 'success':
        raise release.ReleaseError(f'{target}: real OpenRC acceptance is missing')
    for name in ('romi-hub', 'romi-agent'):
        if metadata.get('binaries', {}).get(name) != sha(directory / name):
            raise release.ReleaseError(f'{target}/{name}: binary digest mismatch')
    return metadata


def package(inputs, output, identity, root=ROOT):
    inputs, output = Path(inputs), Path(output)
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise release.ReleaseError('matrix package output must be empty')
    for target in release.TARGETS:
        native_identity(inputs / ('platform-' + target), target, identity)
    original = release.TARGET
    try:
        with tempfile.TemporaryDirectory(prefix='romi-matrix-') as work:
            work = Path(work)
            for target in release.TARGETS:
                release.TARGET = target
                binary_dir = work / target / 'bin'
                binary_dir.mkdir(parents=True)
                source = inputs / ('platform-' + target)
                for name in ('romi-hub', 'romi-agent', 'build.json'):
                    shutil.copyfile(source / name, binary_dir / name)
                for other in release.TARGETS:
                    if other == target:
                        continue
                    destination = binary_dir / 'agents' / other / 'romi-agent'
                    destination.parent.mkdir(parents=True)
                    shutil.copyfile(inputs / ('platform-' + other) / 'romi-agent', destination)
                staged = work / target / 'package'
                release.build_release(binary_dir, staged, identity, root=root)
                release.verify_release_dir(staged, root=root, tag=identity.tag, commit=identity.commit)
                for name in target_files(identity.version, identity.kind):
                    shutil.copyfile(staged / name, output / name)
            for arch in ARCHES:
                source = inputs / ('container-' + arch)
                for name in (f'romi-agent-v{identity.version}-docker-{arch}.tar.gz', f'container-{arch}.json'):
                    shutil.copyfile(source / name, output / name)
        files = sorted(p.name for p in output.iterdir())
        (output / 'SHA256SUMS').write_text(''.join(f'{sha(output/name)}  {name}\n' for name in files), encoding='utf-8', newline='\n')
        verify(output, identity.tag, identity.commit, root=root)
    finally:
        release.TARGET = original


def verify(directory, tag, commit, root=ROOT):
    directory = Path(directory)
    version = release.checked_version(root, tag)
    kind = release.PUBLIC_KIND if tag else release.CANDIDATE_KIND
    expected = {'SHA256SUMS'}
    original = release.TARGET
    try:
        with tempfile.TemporaryDirectory(prefix='romi-verify-matrix-') as work:
            work = Path(work)
            agent_hashes = {}
            for target in release.TARGETS:
                release.TARGET = target
                selected = work / target
                selected.mkdir()
                for name in target_files(version, kind):
                    expected.add(name)
                    shutil.copyfile(directory / name, selected / name)
                release.verify_release_dir(selected, root=root, tag=tag, commit=commit)
                hub = release.read_archive(selected / release.artifact_filename('hub', version))
                metadata = json.loads(hub['release.json']['data'])
                if metadata['agent_targets'] != sorted(release.TARGETS):
                    raise release.ReleaseError(f'{target}: Hub must distribute all four Agent targets')
                agent = release.read_archive(selected / release.artifact_filename('agent', version))
                agent_hashes[target] = release.sha256(agent['bin/romi-agent']['data'])
            # The copies inside every Hub must be the same verified Agent bytes.
            for target in release.TARGETS:
                release.TARGET = target
                hub = release.read_archive(directory / release.artifact_filename('hub', version))
                for other in release.TARGETS:
                    member = 'bin/romi-agent' if other == target else f'agents/{other}/romi-agent'
                    if release.sha256(hub[member]['data']) != agent_hashes[other]:
                        raise release.ReleaseError(f'{target}: inconsistent bundled Agent {other}')
            for arch in ARCHES:
                image_name = f'romi-agent-v{version}-docker-{arch}.tar.gz'
                receipt_name = f'container-{arch}.json'
                expected.update((image_name, receipt_name))
                receipt = json.loads((directory / receipt_name).read_text())
                if (receipt.get('source_commit'), receipt.get('version'), receipt.get('architecture'),
                    receipt.get('host_fields_match'), receipt.get('restart')) != (commit, version, arch, True, 'success'):
                    raise release.ReleaseError(f'{arch}: Docker acceptance does not match this candidate')
                if receipt.get('archive') != image_name or receipt.get('image') != 'romi-agent:' + version:
                    raise release.ReleaseError(f'{arch}: Docker image identity mismatch')
                if receipt.get('sha256') != sha(directory / image_name) or receipt.get('binary_sha256') != agent_hashes[arch + '-unknown-linux-musl']:
                    raise release.ReleaseError(f'{arch}: Docker image or Agent digest mismatch')
        actual = {p.name for p in directory.iterdir() if p.is_file()}
        if actual != expected or any(not p.is_file() for p in directory.iterdir()):
            raise release.ReleaseError('release matrix has missing or unexpected files')
        sums = release.read_sha256sums(directory / 'SHA256SUMS')
        if set(sums) != expected - {'SHA256SUMS'}:
            raise release.ReleaseError('matrix SHA256SUMS covers the wrong files')
        for name, digest in sums.items():
            if sha(directory / name) != digest:
                raise release.ReleaseError(f'matrix digest mismatch: {name}')
    finally:
        release.TARGET = original
    return sha(directory / 'SHA256SUMS')


def extract_target(directory, destination, target, tag, commit):
    release.TARGET = target
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise release.ReleaseError('target output must be empty')
    version = release.checked_version(ROOT, tag)
    for name in target_files(version, release.PUBLIC_KIND):
        shutil.copyfile(Path(directory) / name, destination / name)
    release.verify_release_dir(destination, tag=tag, commit=commit)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['fetch-native', 'prepare', 'fetch-release', 'verify', 'extract-target', 'require-rehearsal'])
    parser.add_argument('--repo', default=os.environ.get('GITHUB_REPOSITORY', 'DejavuMoe/romi'))
    parser.add_argument('--commit', default=os.environ.get('GITHUB_SHA'), required=not os.environ.get('GITHUB_SHA'))
    parser.add_argument('--directory', type=Path, default=Path('dist/release'))
    parser.add_argument('--inputs', type=Path, default=Path('dist/platform-inputs'))
    parser.add_argument('--output', type=Path)
    parser.add_argument('--target', choices=release.TARGETS)
    args = parser.parse_args()
    tag = 'v' + release.checked_version(ROOT)
    if args.action == 'fetch-native':
        selected = workflow_run(args.repo, args.commit, 'platforms.yml', 'push', 'Platform acceptance')
        download(args.repo, selected['id'], [*['platform-'+t for t in release.TARGETS], *['container-'+a for a in ARCHES]], args.inputs)
    elif args.action == 'prepare':
        # A public-shaped, non-publishing candidate. Only this temporary local
        # tag exists; formal publication later reuses these exact archives.
        release.ensure_clean(ROOT)
        if rehearse_release.remote_tag_exists('origin', tag, ROOT):
            raise release.ReleaseError('refusing to rebuild an already tagged release')
        rehearse_release.create_local_tag(tag, args.commit, ROOT)
        try:
            identity = release.resolve_identity(ROOT, tag, args.commit, False)
            package(args.inputs, args.directory, identity)
        finally:
            rehearse_release.delete_local_tag(tag, ROOT)
    elif args.action == 'fetch-release':
        selected = workflow_run(args.repo, args.commit, 'release.yml', 'workflow_dispatch', 'Build and verify artifacts')
        download(args.repo, selected['id'], ['romi-release-' + args.commit], args.directory)
        digest = verify(args.directory, tag, args.commit)
        receipt = dict(source_commit=args.commit, release_run_id=selected['id'], matrix_sha256=digest)
        (args.directory.parent / 'release-input.json').write_text(json.dumps(receipt, indent=2) + '\n')
    elif args.action == 'extract-target':
        if not args.output or not args.target:
            parser.error('extract-target requires --output and --target')
        extract_target(args.directory, args.output, args.target, tag, args.commit)
    elif args.action == 'require-rehearsal':
        digest = verify(args.directory, tag, args.commit)
        selected = workflow_run(args.repo, args.commit, 'release-rehearsal.yml', 'workflow_dispatch', 'Public shape and real systemd rehearsal')
        with tempfile.TemporaryDirectory(prefix='romi-rehearsal-proof-') as work:
            download(args.repo, selected['id'], ['rehearsal-evidence-' + args.commit], work)
            proof = json.loads((Path(work) / 'acceptance.json').read_text())
        if proof.get('source_commit') != args.commit or proof.get('matrix_sha256') != digest or proof.get('architectures') != list(ARCHES):
            raise release.ReleaseError('rehearsal did not accept these exact release artifacts on both native CPUs')
        print('PASS: rehearsal is bound to this exact release matrix', digest)
    else:
        print('PASS: release matrix', verify(args.directory, tag, args.commit))


if __name__ == '__main__':
    main()
