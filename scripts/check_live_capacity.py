#!/usr/bin/env python3
"""Real loopback sockets verify separate viewer limits and released capacity."""
import argparse
from pathlib import Path
import shutil
import time
from types import SimpleNamespace

from bench import Bench, Socket

# Anonymous streams one client address may hold; api::VIEWERS_PER_CLIENT.
PER_CLIENT = 4


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

        def connect(cookie='', client=None):
            return Socket('127.0.0.1', test.hub.port, '', '/api/ws', cookie, forwarded_for=client)

        def refused(status, cookie='', client=None):
            try:
                extra = connect(cookie, client)
            except AssertionError as error:
                assert status in str(error), error
            else:
                extra.close()
                raise AssertionError(f'viewer admission exceeded its limit (expected {status})')

        # One address: its own allowance, then refused before the pool is touched.
        viewers.extend(connect(client='198.51.100.1') for _ in range(PER_CLIENT))
        refused('429', client='198.51.100.1')

        # The public pool, filled by distinct clients -- as many different
        # visitors behind the proxy would -- and refused once it is full.
        clients = (f'198.51.100.{n}' for n in range(2, 254))
        viewers.extend(connect(client=next(clients)) for _ in range(64 - PER_CLIENT))
        refused('503', client=next(clients))

        # The operator's reserve is separate, and not counted per address.
        viewers.extend(connect(cookie, client='198.51.100.1') for _ in range(32))
        refused('503', cookie)

        viewers.pop().close()
        deadline = time.monotonic() + 8
        while True:
            try:
                viewers.append(connect(cookie))
                break
            except AssertionError:
                assert time.monotonic() < deadline, 'closed viewer did not release its slot'
                time.sleep(0.1)
        print(f'PASS: {PER_CLIENT} per address, 64 public + 32 reserved admin viewers; '
              'overflow refused and closed slots reused')
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
