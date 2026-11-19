#!/usr/bin/env python3
"""로컬 개발용 서버: www/nmm를 서빙하고 /ubus 요청을 처리한다.

두 가지 방식이 있다.
  python3 dev.py 192.168.1.1 8080     /ubus를 실제 공유기로 전달 (프록시)
  python3 dev.py --mock               공유기 없이 가짜 ubus로 응답 (tools/fakeubus.py)

가짜 모드 옵션
  --port 8080            로컬 포트
  --password admin       root 로그인 비밀번호. --password= 이면 비밀번호 미설정 공유기처럼 아무 비밀번호나 통과
  --apply-delay 3        설정 적용 후 연결이 끊기는 시간(초). 0이면 끊기지 않는다
  --session-timeout N    세션 유효 시간 상한(초). 만료 처리를 빨리 확인할 때 쓴다
  --acl 파일.json        rootfs의 ACL에 더해 읽을 ACL (여러 번 쓸 수 있다)
  --no-packages          ddns-scripts, sqm-scripts가 설치되지 않은 공유기처럼 동작
  --profile 종류         mt3000(기본) | mt6000(LAN 5포트+eth1) | dsa4(LAN 4포트+wan, 6GHz) | swconfig(스위치 칩) | single(포트 하나, 브리지 없음)
가짜 cgi-io: /cgi-bin/cgi-upload(파일 올리기), /cgi-bin/cgi-backup(백업 받기).
가짜 LuCI: /cgi-bin/luci/... (로그인 쿠키 + 머리글/메뉴가 있는 서비스 화면. --no-packages면 서비스 메뉴 없음).
가짜 펌웨어는 내용이 'NMMWRT-TEST-FW'로 시작하는 파일이면 '이 모델에 맞음'으로 검사된다.

파일을 고치고 새로고침만 하면 되므로 매번 공유기에 올릴 필요가 없다.
가짜 모드의 상태는 메모리에만 있어서 서버를 다시 켜면 처음 설정으로 돌아간다.
"""
import argparse
import email.parser
import email.policy
import hashlib
import http.server
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(BASE, "www", "nmm")
sys.path.insert(0, os.path.join(BASE, "tools"))


def parse_args():
    p = argparse.ArgumentParser(description="easyui 로컬 개발 서버")
    p.add_argument("router", nargs="?", default="192.168.1.1", help="공유기 IP (프록시 모드)")
    p.add_argument("port", nargs="?", type=int, default=8080, help="로컬 포트")
    p.add_argument("--port", dest="port_opt", type=int, help="로컬 포트 (--mock과 함께 쓸 때 편하다)")
    p.add_argument("--mock", action="store_true", help="공유기 없이 가짜 ubus 사용")
    p.add_argument("--password", default="admin")
    p.add_argument("--apply-delay", type=float, default=3.0)
    p.add_argument("--session-timeout", type=int, default=None)
    p.add_argument("--acl", action="append", default=[])
    p.add_argument("--no-packages", action="store_true", help="ddns-scripts/sqm-scripts가 없는 공유기처럼")
    p.add_argument("--profile", default="mt3000", choices=["mt3000", "mt6000", "dsa4", "swconfig", "single"],
                   help="흉내 낼 공유기 종류 (포트 구성/스위치 방식)")
    args = p.parse_args()
    if args.port_opt:
        args.port = args.port_opt
    return args


class Handler(http.server.SimpleHTTPRequestHandler):
    router = None  # 프록시 모드
    fake = None    # 가짜 모드

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def _drop_if_down(self):
        # 적용 직후 공유기 네트워크가 재시작되는 상황: 응답 없이 연결을 끊는다.
        if self.fake is not None and self.fake.is_down():
            self.close_connection = True
            return True
        return False

    def do_GET(self):
        if self._drop_if_down():
            return
        if self.fake is not None and self.path.startswith("/cgi-bin/luci"):
            self._fake_luci(b"")
            return
        super().do_GET()

    luci_tokens = set()  # 가짜 LuCI 로그인 쿠키

    def _fake_luci(self, body):
        """LuCI 흉내 (추가 기능 화면 확인용): 로그인(sysauth 쿠키), 로그아웃, 머리글/메뉴가 있는 서비스 화면."""
        import secrets
        cookies = dict(c.strip().split("=", 1) for c in self.headers.get("Cookie", "").split(";") if "=" in c)
        token = cookies.get("sysauth_http", "")
        path = urllib.parse.urlparse(self.path).path
        if body:
            form = urllib.parse.parse_qs(body.decode("utf-8", "replace"), keep_blank_values=True)
            pw = form.get("luci_password", [""])[0]
            if form.get("luci_username", [""])[0] == "root" and (self.fake.password == "" or pw == self.fake.password):
                token = secrets.token_hex(16)
                self.luci_tokens.add(token)
                self.send_response(302)
                self.send_header("Set-Cookie", f"sysauth_http={token}; path=/cgi-bin/luci/; SameSite=Strict; HttpOnly")
                self.send_header("Location", self.path)
                self.end_headers()
                return
        if path.rstrip("/").endswith("/admin/logout"):
            self.luci_tokens.discard(token)
            token = ""
        if token in self.luci_tokens:
            name = path.rstrip("/").split("/")[-1]
            content = (f"<h2 name='content'>{name}</h2><div class='cbi-map'><p>가짜 LuCI 서비스 화면: {name}</p>"
                       "<div class='cbi-section'><label>Enable <input type='checkbox' checked></label></div></div>")
        else:
            content = ("<form method='post'><h2>Authorization Required</h2><input name='luci_username' value='root'>"
                       "<input type='password' name='luci_password'><button>Login</button></form>")
        html = ("<!doctype html><html><head><meta charset='utf-8'><title>LuCI</title></head><body>"
                "<header style='background:#333;color:#fff;padding:12px'>OpenWrt | LuCI 머리글</header>"
                "<ul id='topmenu'><li>Status</li><li>System</li><li>Services</li></ul>"
                f"<div id='maincontent' class='container'>{content}</div><footer>Powered by LuCI</footer></body></html>").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.end_headers()
        self.wfile.write(html)

    def end_headers(self):
        # 고친 파일이 새로고침만으로 바로 반영되도록 캐시하지 않게 한다.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        if self._drop_if_down():
            return
        if self.fake is not None and self.path in ("/cgi-bin/cgi-upload", "/cgi-bin/cgi-backup"):
            self._fake_cgi_io(body)
            return
        if self.fake is not None and self.path.startswith("/cgi-bin/luci"):
            self._fake_luci(body or b" ")
            return
        if self.path != "/ubus":
            self.send_error(404)
            return
        if self.fake is not None:
            out = json.dumps(self.fake.handle(body), ensure_ascii=False).encode("utf-8")
            self._reply(200, out)
            return
        req = urllib.request.Request(
            f"http://{self.router}/ubus", data=body,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                out, status = res.read(), res.status
        except urllib.error.HTTPError as err:
            out, status = err.read(), err.code
        except Exception as err:  # 공유기에 닿지 않는 경우
            self.send_error(502, str(err))
            return
        self._reply(status, out)

    def _fake_cgi_io(self, body):
        """cgi-io(파일 올리기/백업 받기) 흉내. 실제처럼 세션 ACL을 검사한다."""
        if self.path.endswith("cgi-backup"):
            sid = urllib.parse.parse_qs(body.decode("utf-8", "replace")).get("sessionid", [""])[0]
            if not self.fake.check(sid, "cgi-io", "backup", "read"):
                self.send_response(403)  # 실제 cgi-io: 403 text/plain "Backup permission denied"
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"Backup permission denied\n")
                return
            data = self.fake.make_backup()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-targz")
            self.send_header("Content-Disposition", 'attachment; filename="backup.tar.gz"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
            b"Content-Type: " + self.headers.get("Content-Type", "").encode() + b"\r\n\r\n" + body)
        fields = {}
        for part in msg.iter_parts():
            fields[part.get_param("name", header="content-disposition")] = part.get_payload(decode=True)
        sid = (fields.get("sessionid") or b"").decode()
        path = (fields.get("filename") or b"").decode()
        data = fields.get("filedata") or b""
        # 실제 cgi-io처럼 거부도 HTTP 200 + {"message", "failure"}로 답한다
        if not self.fake.check(sid, "cgi-io", "upload", "write"):
            self._reply(200, b'{"message": "Upload permission denied", "failure": [1, "Operation not permitted"]}')
            return
        if not self.fake.check(sid, "file", path, "write"):
            self._reply(200, b'{"message": "Access to path denied by ACL", "failure": [0, "No error information"]}')
            return
        self.fake.files[path] = data
        out = json.dumps({"size": len(data), "checksum": hashlib.md5(data).hexdigest(),
                          "sha256sum": hashlib.sha256(data).hexdigest()}).encode()
        self._reply(200, out)

    def _reply(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if self.fake is None:
            super().log_message(fmt, *args)  # 가짜 모드에서는 5초마다 찍히는 폴링 로그를 숨긴다


def main():
    args = parse_args()
    if args.mock:
        import fakeubus
        acl_files = fakeubus.default_acl_files(BASE) + args.acl
        Handler.fake = fakeubus.FakeUbus(
            acl_files=acl_files, password=args.password, apply_delay=args.apply_delay,
            max_session_timeout=args.session_timeout, packages=not args.no_packages, profile=args.profile,
        )

        def ticker():  # 요청이 없어도 롤백 타이머와 세션 만료가 돌게 한다
            while True:
                time.sleep(1)
                Handler.fake.tick()

        threading.Thread(target=ticker, daemon=True).start()
        print(f"http://127.0.0.1:{args.port}/  ->  가짜 ubus '{args.profile}' (root / {args.password or '<비밀번호 없음>'})")
        print("ACL: " + ", ".join(os.path.relpath(f, BASE) for f in acl_files))
    else:
        Handler.router = args.router
        print(f"http://127.0.0.1:{args.port}/  ->  /ubus는 {args.router}로 전달")
    # 127.0.0.1에만 바인딩해서 같은 네트워크의 다른 기기가 접근하지 못하게 한다.
    http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
