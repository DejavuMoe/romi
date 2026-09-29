#!/usr/bin/env python3
"""A coalesced upgrade/frame and split TCP headers must not corrupt measurements."""
import socket
import threading
import time

from bench import Socket


def check():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        received = []
        done = threading.Event()
        def serve():
            peer, _ = listener.accept()
            with peer:
                headers = b''
                while b'\r\n\r\n' not in headers:
                    headers += peer.recv(4096)
                peer.sendall(b'HTTP/1.1 101 Switching Protocols\r\n\r\n\x81')
                time.sleep(0.01)
                peer.sendall(b'\x03one\x81')
                time.sleep(0.01)
                peer.sendall(b'\x03two')
                done.wait(2)
        thread = threading.Thread(target=serve)
        thread.start()
        client = Socket('127.0.0.1', listener.getsockname()[1], 'dummy', on_text=received.append)
        deadline = time.monotonic() + 2
        while len(received) < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert received == [b'one', b'two'], received
        assert client.bytes_received == 6 and client.text_frames == 2
        done.set()
        client.close()
        thread.join(timeout=2)
    print('PASS: WebSocket benchmark consumes upgrade leftovers and fragmented TCP frames')


if __name__ == '__main__':
    check()
