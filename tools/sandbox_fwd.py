#!/usr/bin/env python3
"""TCP <-> 유닉스 소켓 포워더. openwrt-sandbox.sh가 쓴다.

샌드박스 OpenWrt는 자기만의 네트워크 네임스페이스에 있어서 호스트에서 TCP로 바로 닿지 않는다.
파일 시스템은 공유되므로 유닉스 소켓을 다리로 쓴다.
  호스트:        tcp-to-unix 127.0.0.1:8081 /경로/fwd.sock
  샌드박스 안:   unix-to-tcp /경로/fwd.sock 127.0.0.1:80
"""
import os
import socket
import sys
import threading


def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def serve(listener, connect):
    while True:
        client, _ = listener.accept()
        try:
            upstream = connect()
        except OSError:
            client.close()
            continue
        threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
        threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()


def hostport(text):
    host, _, port = text.rpartition(":")
    return host, int(port)


def main():
    mode, a, b = sys.argv[1:4]
    if mode == "tcp-to-unix":
        lis = socket.create_server(hostport(a))
        serve(lis, lambda: _unix(b))
    elif mode == "unix-to-tcp":
        if os.path.exists(a):
            os.unlink(a)
        lis = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        lis.bind(a)
        lis.listen(64)
        serve(lis, lambda: _tcp(hostport(b)))
    else:
        sys.exit("모드: tcp-to-unix | unix-to-tcp")


def _tcp(addr):
    s = socket.create_connection(addr, timeout=10)
    s.settimeout(None)  # 연결 시도에만 시간 제한을 둔다
    return s


def _unix(path):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(path)
    return s


if __name__ == "__main__":
    main()
