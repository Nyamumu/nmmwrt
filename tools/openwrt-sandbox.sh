#!/usr/bin/env bash
# 실제 OpenWrt(공식 x86-64 rootfs)를 root 권한 없이 리눅스(WSL 포함)에서 띄운다.
# 도커/QEMU/sudo 없이 사용자 네임스페이스(unshare -r)만 쓴다.
#
# 사용법 (프로젝트 폴더에서):
#   tools/openwrt-sandbox.sh start [옵션]   켜기 (Ctrl+C로 끈다)
#   tools/openwrt-sandbox.sh sh [명령...]   켜져 있는 샌드박스 안에서 명령 실행 (예: sh logread)
#   tools/openwrt-sandbox.sh stop           끄기
#
# start 옵션
#   --version 25.12.6    OpenWrt 버전
#   --port 8081          호스트에서 접속할 포트 -> http://127.0.0.1:8081/nmm/
#   --password admin     root 비밀번호. --password '' 이면 순정처럼 비밀번호 없음
#   --keep-luci-acl      LuCI ACL을 남긴다 (기본은 치워서 'LuCI를 지운 공유기'와 같은 조건으로 만든다)
#   --acl 파일.json      ACL 추가 (예: tests/acl-uci-test.json 으로 uci 쓰기 시험)
#   --fresh              rootfs를 새로 풀어서 처음 부팅 상태로 시작
#
# 안에서 도는 것: procd(init), ubusd, rpcd, uhttpd, netifd, dnsmasq 등 순정 서비스.
# 샌드박스는 자기만의 네트워크 네임스페이스를 갖고 가짜 랜카드 eth0(LAN), eth1(WAN)이 있다.
# WAN 쪽에는 DHCP 서버가 없으므로 인터넷은 '연결 중'으로 보이는 것이 정상이다.
# 무선 하드웨어가 없으므로 무선 상태는 비어 있다.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/easyui-sandbox"
VERSION=25.12.6
PORT=8081
PASSWORD=admin
KEEP_LUCI=0
FRESH=0
EXTRA_ACL=()

state_dir() { echo "$CACHE/$VERSION"; }
die() { echo "오류: $*" >&2; exit 1; }

ns_pid() {
  # 실행 중인 샌드박스의 init(procd) 프로세스 번호 (호스트 기준)
  local f="$CACHE/running.pid"
  [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null || die "샌드박스가 켜져 있지 않습니다."
  cat "$f"
}

cmd_sh() {
  local pid root
  pid="$(ns_pid)"
  root="$(cat "$CACHE/running.root")"
  if [ $# -eq 0 ]; then set -- /bin/ash -l; fi
  exec nsenter -t "$pid" -U -m -n -p --preserve-credentials -- chroot "$root" /usr/bin/env -i \
    PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root TERM="${TERM:-xterm}" "$@"
}

cmd_stop() {
  local f="$CACHE/running.pid"
  if [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null; then
    kill -KILL "$(cat "$f")"  # 네임스페이스의 init이 죽으면 안의 프로세스가 모두 끝난다
    echo "껐습니다."
  else
    echo "켜져 있지 않습니다."
  fi
  rm -f "$f"
}

download() {
  local dir="$1" base="https://downloads.openwrt.org/releases/$VERSION/targets/x86/64"
  local name="openwrt-$VERSION-x86-64-rootfs.tar.gz"
  mkdir -p "$dir"
  if [ ! -f "$dir/$name" ]; then
    echo "받는 중: $base/$name" >&2
    # curl/wget이 없는 환경도 있어서 파이썬으로 받는다. 공식 sha256sums로 검증한다.
    python3 -I - "$base" "$name" "$dir" >&2 <<'PY'
import hashlib, sys, urllib.request, os
base, name, out = sys.argv[1:4]
sums = urllib.request.urlopen(base + "/sha256sums", timeout=30).read().decode()
want = next((l.split()[0] for l in sums.splitlines() if l.endswith("*" + name) or l.endswith(" " + name)), None)
if not want:
    sys.exit("sha256sums에 " + name + " 이 없습니다")
data = urllib.request.urlopen(base + "/" + name, timeout=300).read()
if hashlib.sha256(data).hexdigest() != want:
    sys.exit("sha256 불일치: " + name)
tmp = os.path.join(out, name + ".part")
with open(tmp, "wb") as f:
    f.write(data)
os.replace(tmp, os.path.join(out, name))
print("검증 완료 (%d bytes)" % len(data))
PY
  fi
  echo "$dir/$name"
}

prepare() {
  local st root tarball
  st="$(state_dir)"
  root="$st/rootfs"
  tarball="$(download "$st" | tail -1)"
  if [ "$FRESH" = 1 ] && [ -d "$root" ]; then
    chmod -R u+w "$root" 2>/dev/null || true
    rm -rf "$root"
  fi
  if [ ! -d "$root" ]; then
    echo "rootfs 푸는 중: $root" >&2
    mkdir -p "$root"
    # 장치 파일은 만들 수 없으므로 뺀다 (실행할 때 호스트의 /dev/null 등을 연결한다)
    unshare -r tar -xzf "$tarball" -C "$root" --exclude='./dev/*'
  fi

  # 이 프로젝트의 UI와 ACL을 올린다 (deploy.sh와 같은 위치)
  rm -rf "$root/www/nmm"
  cp -r "$HERE/www/nmm" "$root/www/nmm"
  sed -i "s/__V__/$(date +%Y%m%d%H%M%S)/g" "$root/www/nmm/index.html"  # deploy.sh와 같은 캐시 무효화
  cp "$HERE/rootfs/usr/share/rpcd/acl.d/easyui.json" "$root/usr/share/rpcd/acl.d/"
  rm -f "$root"/usr/share/rpcd/acl.d/zz-extra-*.json
  local n=0 f
  for f in "${EXTRA_ACL[@]+"${EXTRA_ACL[@]}"}"; do
    n=$((n + 1))
    cp "$f" "$root/usr/share/rpcd/acl.d/zz-extra-$n.json"
  done

  local parked="$st/luci-acl-parked"
  mkdir -p "$parked"
  if [ "$KEEP_LUCI" = 1 ]; then
    find "$parked" -name '*.json' -exec mv -t "$root/usr/share/rpcd/acl.d/" {} +
  else
    find "$root/usr/share/rpcd/acl.d" -name 'luci-*.json' -exec mv -t "$parked/" {} +
  fi

  # unshare -r은 uid 0 하나만 매핑하므로 ubusd(ubus), logd 같은 서비스 계정으로 바꾸는 데 실패한다.
  # 샌드박스 안에서만 모든 계정의 uid/gid를 0으로 바꿔 둔다. (권한 분리는 실제와 다르다)
  sed -i -E 's/^([^:]*:[^:]*):[0-9]+:[0-9]+:/\1:0:0:/' "$root/etc/passwd"
  sed -i -E 's/^([^:]*:[^:]*):[0-9]+:/\1:0:/' "$root/etc/group"

  # root 비밀번호는 OpenWrt 자신의 passwd로 정한다
  if [ -z "$PASSWORD" ]; then
    unshare -r chroot "$root" /bin/busybox passwd -d root >/dev/null
  else
    printf '%s\n%s\n' "$PASSWORD" "$PASSWORD" | unshare -r chroot "$root" /bin/busybox passwd root >/dev/null 2>&1
  fi
  echo "$root"
}

# 새 네임스페이스 안에서 도는 부분 (가짜 root)
inner() {
  local root="$1" sock="$2"
  mount --make-rprivate / 2>/dev/null || true
  mount -t proc proc "$root/proc"
  mount -t tmpfs -o mode=1777 tmpfs "$root/tmp"
  mount -t sysfs sysfs "$root/sys" 2>/dev/null || true
  mount -t tmpfs -o mode=755 tmpfs "$root/dev"
  for d in null zero full random urandom tty; do
    touch "$root/dev/$d"
    mount --bind "/dev/$d" "$root/dev/$d" 2>/dev/null || rm -f "$root/dev/$d"
  done
  mkdir -p "$root/dev/pts" "$root/dev/shm"
  # 사용자 네임스페이스에서는 OpenWrt의 /proc/sys/kernel/hostname 쓰기가 막히므로 시작할 때 설정값으로 정해 둔다
  # (화면에서 이름을 바꾸면 샌드박스를 다시 켜야 반영된다)
  local hn=""
  # 처음 부팅 전(--fresh)에는 설정 파일이 아직 없다
  if [ -f "$root/etc/config/system" ]; then
    hn="$(sed -n "s/^[[:space:]]*option hostname '\(.*\)'/\1/p" "$root/etc/config/system" | head -1)"
  fi
  hostname "${hn:-OpenWrt}" 2>/dev/null || true
  ip link set lo up
  ip link add eth0 type dummy
  ip link add eth1 type dummy
  # 호스트와 이어 주는 포워더: 유닉스 소켓 -> 샌드박스 안 uhttpd(80)
  python3 -I "$HERE/tools/sandbox_fwd.py" unix-to-tcp "$sock" 127.0.0.1:80 &
  # procd는 container 환경 변수가 있으면 컨테이너로 보고 장치/마운트 초기화를 건너뛴다
  exec chroot "$root" /usr/bin/env -i container=easyui-sandbox PATH=/usr/sbin:/usr/bin:/sbin:/bin /sbin/init
}

cmd_start() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) VERSION="$2"; shift 2 ;;
      --port) PORT="$2"; shift 2 ;;
      --password) PASSWORD="$2"; shift 2 ;;
      --password=*) PASSWORD="${1#*=}"; shift ;;  # --password= (빈 값을 넘기기 어려운 셸용)
      --keep-luci-acl) KEEP_LUCI=1; shift ;;
      --acl) EXTRA_ACL+=("$(realpath "$2")"); shift 2 ;;
      --fresh) FRESH=1; shift ;;
      *) die "알 수 없는 옵션: $1" ;;
    esac
  done
  if [ -f "$CACHE/running.pid" ] && kill -0 "$(cat "$CACHE/running.pid")" 2>/dev/null; then
    die "이미 켜져 있습니다. 먼저 '$0 stop'"
  fi

  local root st sock
  root="$(prepare | tail -1)"
  st="$(state_dir)"
  sock="$st/fwd.sock"
  rm -f "$sock"

  # trap에서 쓰므로 전역 변수로 둔다
  FWD_PID=""
  CHILD_PID=""
  trap 'kill $FWD_PID 2>/dev/null; [ -n "$CHILD_PID" ] && kill -KILL "$CHILD_PID" 2>/dev/null; rm -f "$CACHE/running.pid"' EXIT INT TERM

  python3 -I "$HERE/tools/sandbox_fwd.py" tcp-to-unix "127.0.0.1:$PORT" "$sock" &
  FWD_PID=$!

  # -u: 호스트 이름도 따로 (안 그러면 OpenWrt가 PC의 이름을 보고, 이름 변경이 PC에 영향을 줄 수 있다)
  unshare -r -m -n -p -u -f -- bash "$0" __inner "$root" "$sock" &
  local un=$!
  # unshare가 만든 자식(= 네임스페이스의 init)의 번호를 기록한다
  for _ in $(seq 50); do
    CHILD_PID="$(pgrep -P "$un" | head -1 || true)"
    [ -n "$CHILD_PID" ] && break
    sleep 0.1
  done
  echo "$CHILD_PID" > "$CACHE/running.pid"
  echo "$root" > "$CACHE/running.root"

  echo "OpenWrt $VERSION 샌드박스 시작 (root / ${PASSWORD:-<비밀번호 없음>})"
  echo "  새 UI:  http://127.0.0.1:$PORT/nmm/"
  echo "  셸:     $0 sh        로그: $0 sh logread"
  wait "$un" || true
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  sh) shift; cmd_sh "$@" ;;
  stop) cmd_stop ;;
  __inner) shift; inner "$@" ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
