#!/usr/bin/env python3
"""Real loopback sockets verify separate viewer limits and released capacity."""
import argparse
from pathlib import Path
import shutil
import time
from types import SimpleNamespace

from bench import Bench, Socket


def check(binaries):
    test = Bench(SimpleNamespace(bin_dir=binaries))
    viewers = []
    try:
        test.hub.start()
        with test.request('/api/auth/login', {'username': 'admin', 'password': test.hub.password()}):
            pass
        with test.request('/api/settings', {'public_page': 'on'}, method='PUT'):
            pass
        cookie = '; '.join(f'{c.name}={c.value}' for c in test.cookies)
        def connect(cookie=''):
            return Socket('127.0.0.1', test.hub.port, '', '/api/ws', cookie)
        def refused(cookie=''):
            try:
                extra = connect(cookie)
            except AssertionError as error:
                assert '503' in str(error), error
            else:
                extra.close()
                raise AssertionError('viewer admission exceeded its limit')
        viewers.extend(connect() for _ in range(64))
        refused()
        viewers.extend(connect(cookie) for _ in range(32))
        refused(cookie)
        viewers.pop().close()
        deadline = time.monotonic() + 8
        while True:
            try:
                viewers.append(connect(cookie))
                break
            except AssertionError:
                assert time.monotonic() < deadline, 'closed viewer did not release its slot'
                time.sleep(0.1)
        print('PASS: 64 public + 32 reserved admin viewers; overflow refused and closed slots reused')
    finally:
        for viewer in viewers:
            viewer.close()
        test.hub.stop()
        test.hub.log.close()
        shutil.rmtree(test.work)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin-dir', type=Path, required=True)
    args = parser.parse_args()
    check(args.bin_dir.resolve())
