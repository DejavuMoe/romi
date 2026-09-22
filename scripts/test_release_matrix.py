#!/usr/bin/env python3
"""Offline multi-target identity/integrity checks; no compiler, Docker or network."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import release
import release_matrix as matrix


class MatrixTests(unittest.TestCase):
    def test_all_targets_share_verified_agents_and_tampering_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            release.fixture_release_inputs(root)
            identity = release.Identity('0.1.0', 'v0.1.0', 'a' * 40, release.PUBLIC_KIND)
            inputs = root / 'inputs'
            hashes = {}
            for target in release.TARGETS:
                directory = inputs / ('platform-' + target)
                directory.mkdir(parents=True)
                binaries = {}
                for name in ('romi-hub', 'romi-agent'):
                    data = (name + target).encode()
                    (directory / name).write_bytes(data)
                    binaries[name] = hashlib.sha256(data).hexdigest()
                hashes[target] = binaries
                (directory / 'build.json').write_text(json.dumps(dict(
                    format=1, target=target, version=identity.version, source_commit=identity.commit,
                    rustc='rustc fixture', rustc_host=target, binaries=binaries,
                    image=release.IMAGES[target], native_machine=target.split('-')[0],
                    smoke='success', openrc='success' if target.endswith('musl') else 'not-applicable')))
            for arch in matrix.ARCHES:
                directory = inputs / ('container-' + arch)
                directory.mkdir()
                name = f'romi-agent-v{identity.version}-docker-{arch}.tar.gz'
                data = ('image-' + arch).encode()
                (directory / name).write_bytes(data)
                (directory / f'container-{arch}.json').write_text(json.dumps(dict(
                    format=1, source_commit=identity.commit, version=identity.version, architecture=arch,
                    archive=name, image='romi-agent:' + identity.version,
                    sha256=hashlib.sha256(data).hexdigest(), binary_sha256=hashes[arch+'-unknown-linux-musl']['romi-agent'],
                    host_fields_match=True, restart='success')))
            output = root / 'matrix'
            matrix.package(inputs, output, identity, root=root)
            digest = matrix.verify(output, identity.tag, identity.commit, root=root)
            self.assertEqual(len(digest), 64)
            image = output / 'romi-agent-v0.1.0-docker-aarch64.tar.gz'
            image.write_bytes(image.read_bytes() + b'corruption')
            with self.assertRaisesRegex(release.ReleaseError, 'digest mismatch'):
                matrix.verify(output, identity.tag, identity.commit, root=root)
            meta_path = inputs / ('platform-' + release.TARGETS[0]) / 'build.json'
            meta = json.loads(meta_path.read_text())
            meta['source_commit'] = 'b' * 40
            meta_path.write_text(json.dumps(meta))
            with self.assertRaisesRegex(release.ReleaseError, 'mismatched'):
                matrix.package(inputs, root / 'wrong-source', identity, root=root)


if __name__ == '__main__':
    unittest.main()
