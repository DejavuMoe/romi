#!/usr/bin/env python3
"""Build and verify local romi snapshot archives; no network or signing keys."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / 'target/release'
RECEIPT = RELEASE / 'romi-build.json'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def source_state():
    names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT)
    files = {}
    for name in sorted(set(names.decode().strip('\0').split('\0'))):
        path = ROOT / name
        if path.is_file():
            files[name] = {'sha256': sha(path.read_bytes()), 'executable': bool(path.stat().st_mode & 0o111)}
    return {'sha256': sha(encoded(files)), 'files': files}


def binaries():
    return {name: sha((RELEASE / name).read_bytes()) for name in ['romi-hub', 'romi-agent']}


def generated():
    files = {}
    for directory in ['admin/dist', 'web/dist', 'server/target/theme']:
        for path in sorted((ROOT / directory).rglob('*')):
            if path.is_file():
                files[path.relative_to(ROOT).as_posix()] = sha(path.read_bytes())
    return files


def record():
    receipt = {'source': source_state(), 'binaries': binaries(), 'generated': generated(),
               'rustc': subprocess.check_output(['rustc', '-vV'], cwd=ROOT, text=True).strip(),
               'node': subprocess.check_output(['node', '--version'], text=True).strip(),
               'pnpm': subprocess.check_output(['pnpm', '--version'], text=True).strip(),
               'python': subprocess.check_output(['python3', '--version'], text=True).strip()}
    RECEIPT.write_bytes(encoded(receipt))


def package():
    receipt = json.loads(RECEIPT.read_bytes())
    if receipt['source'] != source_state() or receipt['binaries'] != binaries() or receipt['generated'] != generated():
        raise ValueError('source, binaries or generated assets changed since build; run make package')
    host = next(line.removeprefix('host: ') for line in receipt['rustc'].splitlines() if line.startswith('host: '))
    name = f"romi-{receipt['source']['sha256'][:12]}-{host}.tar.gz"
    payload = {f'bin/{n}': (RELEASE / n).read_bytes() for n in receipt['binaries']}
    for item in ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'upstream.lock.json', 'docs/local-release.md', 'docs/storage.md', 'docs/bench.md',
                 'server/LICENSE', 'agent/LICENSE', 'admin/LICENSE', 'web/LICENSE',
                 'server/Cargo.lock', 'agent/Cargo.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
                 'package.json', 'admin/package.json', 'web/package.json', 'mise.toml', 'rust-toolchain.toml',
                 'web/theme.json', 'web/preview.png']:
        payload[item] = (ROOT / item).read_bytes()
    for path in sorted((ROOT / 'web/dist').rglob('*')):
        if path.is_file():
            payload[path.relative_to(ROOT).as_posix()] = path.read_bytes()
    for n, digest in receipt['generated'].items():
        if n.startswith('web/dist/') and sha(payload[n]) != digest:
            raise ValueError('generated payload changed while packaging')
    manifest = {'format': 1, 'project': 'romi', 'kind': 'local-snapshot', 'target': host,
                'build': receipt, 'files': {n: sha(data) for n, data in payload.items()},
                'signed': False}
    payload['manifest.json'] = encoded(manifest)
    output = ROOT / 'dist' / name
    output.parent.mkdir(exist_ok=True)
    # Temporary file plus rename never publishes a partly written archive.
    with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with tarfile.open(temporary_path, 'w:gz') as archive:
            for path, data in sorted(payload.items()):
                entry = tarfile.TarInfo(path)
                entry.size = len(data)
                entry.mode = 0o755 if path.startswith('bin/') else 0o644
                archive.addfile(entry, io.BytesIO(data))
        digest = sha(temporary_path.read_bytes())
        verify(temporary_path, digest)
        temporary_path.replace(output)
        output.with_name(output.name + '.sha256').write_text(f'{digest}  {output.name}\n')
    finally:
        temporary_path.unlink(missing_ok=True)
    print(output)
    print(f'SHA256 {digest}')


def verify(path, expected):
    # The expected digest must come from an independently trusted source.
    if path.stat().st_size > 256 * 1024 * 1024:
        raise ValueError("archive exceeds size limit")
    data = path.read_bytes()
    if len(expected) != 64 or sha(data) != expected.lower():
        raise ValueError('archive SHA-256 mismatch')
    contents = {}
    expanded = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for entry in archive:
            name = PurePosixPath(entry.name)
            if not entry.isfile() or name.is_absolute() or '..' in name.parts or str(name) != entry.name or entry.name in contents:
                raise ValueError('archive has an unsafe or duplicate member')
            expanded += entry.size
            if expanded > 256 * 1024 * 1024 or entry.size > 128 * 1024 * 1024 or len(contents) >= 5000:
                raise ValueError('archive member limit exceeded')
            contents[entry.name] = archive.extractfile(entry).read()
    manifest = json.loads(contents.pop('manifest.json'))
    if manifest.get('format') != 1 or manifest.get('project') != 'romi':
        raise ValueError('unsupported manifest')
    if manifest['files'] != {name: sha(value) for name, value in contents.items()}:
        raise ValueError('manifest file hashes mismatch')
    for name in ['romi-hub', 'romi-agent']:
        if sha(contents[f'bin/{name}']) != manifest['build']['binaries'][name]:
            raise ValueError('binary differs from build receipt')
    for name, digest in manifest['build']['generated'].items():
        if name.startswith('web/dist/') and sha(contents[name]) != digest:
            raise ValueError('generated payload differs from build receipt')
    if sha(encoded(manifest['build']['source']['files'])) != manifest['build']['source']['sha256']:
        raise ValueError('source receipt mismatch')
    return manifest


def self_check():
    global ROOT, RELEASE, RECEIPT
    # Exercise refusal before extraction; a checksum beside an archive is not a signature.
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'bad.tar.gz'
        path.write_bytes(b'changed archive')
        try:
            verify(path, '0' * 64)
        except ValueError:
            pass
        else:
            raise AssertionError('tampering was accepted')
        with tarfile.open(path, 'w:gz') as archive:
            entry = tarfile.TarInfo('../outside')
            entry.size = 1
            archive.addfile(entry, io.BytesIO(b'x'))
        try:
            verify(path, sha(path.read_bytes()))
        except ValueError:
            pass
        else:
            raise AssertionError('unsafe archive path was accepted')
    original = ROOT, RELEASE, RECEIPT
    try:
        with tempfile.TemporaryDirectory() as directory:
            ROOT = Path(directory)
            RELEASE = ROOT / 'target/release'
            RECEIPT = RELEASE / 'romi-build.json'
            subprocess.run(['git', 'init', '-q', str(ROOT)], check=True)
            (ROOT / '.gitignore').write_text('target/\nweb/dist/\n')
            RELEASE.mkdir(parents=True)
            for name in ['romi-hub', 'romi-agent']:
                (RELEASE / name).write_bytes(b'fixture')
            (ROOT / 'web/dist').mkdir(parents=True)
            page = ROOT / 'web/dist/index.html'
            page.write_text('built')
            RECEIPT.write_bytes(encoded({'source': source_state(), 'binaries': binaries(), 'generated': generated()}))
            page.write_text('changed after build')
            try:
                package()
            except ValueError as error:
                assert 'generated assets changed' in str(error)
            else:
                raise AssertionError('changed generated asset was accepted')
    finally:
        ROOT, RELEASE, RECEIPT = original
    print('PASS: modified archive, unsafe members and changed generated assets rejected')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['record', 'build', 'verify', 'check'])
    parser.add_argument('archive', nargs='?', type=Path)
    parser.add_argument('--sha256')
    args = parser.parse_args()
    if args.action == 'record':
        record()
    elif args.action == 'build':
        package()
    elif args.action == 'check':
        self_check()
    else:
        if args.archive is None or args.sha256 is None:
            parser.error('verify requires an archive and --sha256 from a trusted source')
        verify(args.archive, args.sha256)
        print('PASS: archive digest, member safety and manifest hashes')
