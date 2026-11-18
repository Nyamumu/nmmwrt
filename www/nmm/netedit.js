// 인터페이스 목록의 수정 창: 인터페이스(network의 interface 섹션)와 장치(network의 device 섹션).
//   이 창이 다루지 않는 옵션은 그대로 둔다. 적용은 항상 자동 되돌림과 함께 한다 (runApply).
//   다른 메뉴가 구조를 관리하는 값은 잠근다: VLAN 장치와 VLAN 브리지의 포트(VLAN 설정), 게스트 장치(게스트 네트워크), wan6(IPv6 설정).

const NET_EDIT_TIMEOUT = 120; // 네트워크를 다시 구성하면 잠깐 끊길 수 있다
const IFACE_PROTOS = [['static', '고정 IP'], ['dhcp', '자동 IP (DHCP)'], ['pppoe', 'PPPoE'], ['none', '주소 없음']];

// 인터페이스에 연결할 수 있는 장치 이름. 무선과 터널처럼 자동으로 생기는 장치는 뺀다.
function netDevChoices(ctx, devices) {
  const names = [...Object.keys(devices || {}), ...ctx.devs.map((d) => d.name).filter(Boolean)];
  return [...new Set(names)].filter((n) => n !== 'lo' && !/^(phy\d|wlan|pppoe-|ifb|sit|gre|ip6|teql|dummy)/.test(n)).sort();
}

const dnsOk = (t) => isIPv4(t) || (t.includes(':') && !t.includes('/') && okIp(t));

function netEditFailed(title, e) {
  handleDenied(e).then((r) => { if (r !== 'expired') infoModal(title, '설정을 불러오지 못했습니다.', true); });
}

/* ---------- 인터페이스 수정 ---------- */

async function editInterface(n, devices, done) {
  let ctx;
  try {
    ctx = await makeNetCtx();
  } catch (e) {
    netEditFailed('인터페이스 수정', e);
    return;
  }
  const cfg = ctx.ifaces.find((i) => i['.name'] === n);
  if (!cfg) { infoModal('인터페이스 수정', '공유기가 자동으로 만든 인터페이스라 수정할 수 없습니다.'); return; }

  const curProto = cfg.proto || 'none';
  const curDev = ifaceDev(cfg);
  const cur = readAddr(cfg);
  const dhcpServer = ctx.dhcp.some((d) => d['.type'] === 'dhcp' && d.interface === n && d.ignore !== '1');
  const known = IFACE_PROTOS.some(([p]) => p === curProto);
  const isLan = n === 'lan';
  const protoHint = n === 'wan6' ? 'IPv6 설정 메뉴에서 바꿉니다'
    : !known ? '이 연결 방식은 여기서 바꿀 수 없습니다'
      : isLan || dhcpServer ? 'DHCP 서버를 쓰는 네트워크는 고정 IP만 쓸 수 있습니다' : '';
  const devHint = isLan ? '내부 네트워크 장치는 VLAN 설정에서 바꿉니다'
    : n === 'wan6' || curDev.startsWith('@') ? '인터넷 인터페이스를 따라갑니다'
      : MANAGED_NETS.includes(n) ? '게스트 네트워크 메뉴에서 관리합니다'
        : /\.\d+$/.test(curDev) ? 'VLAN 장치는 VLAN 설정에서 바꿉니다' : '';

  const text = (v, attrs) => h('input', { type: 'text', value: v || '', spellcheck: 'false', autocomplete: 'off', ...attrs });
  const proto = selectEl(IFACE_PROTOS, curProto);
  proto.disabled = !!protoHint;
  const device = selectEl([['', '선택 안 함'], ...netDevChoices(ctx, devices).map((d) => [d, portLabel(d) === d ? d : `${portLabel(d)} (${d})`])], curDev);
  device.disabled = !!devHint;
  const ip = text(cur.ip, { inputmode: 'decimal', placeholder: '예: 192.168.50.1' });
  const mask = text(cur.mask || '255.255.255.0', { inputmode: 'decimal' });
  const gateway = text(cfg.gateway, { inputmode: 'decimal', placeholder: n === 'wan' ? '예: 203.0.113.1' : '없으면 비워 두세요' });
  const dns = text(asList(cfg.dns).join(' '), { placeholder: '예: 1.1.1.1 8.8.8.8' });
  const username = text(cfg.username);
  const password = h('input', { type: 'password', value: cfg.password || '', autocomplete: 'new-password', spellcheck: 'false' });
  const metric = text(cfg.metric, { inputmode: 'numeric', placeholder: '비우면 기본값' });
  const auto = toggleEl(cfg.auto !== '0', '공유기가 켜질 때 자동으로 연결');
  const defaultRoute = toggleEl(cfg.defaultroute !== '0', '이 연결을 기본 경로로 사용');
  const f = {
    proto: formField('연결 방식', proto, protoHint),
    device: formField('장치', device, devHint),
    ip: formField('IP 주소', ip),
    mask: formField('서브넷 마스크', mask),
    gateway: formField('게이트웨이', gateway),
    dns: formField('DNS 서버', dns, '여러 개는 띄어 쓰기. 비우면 자동으로 받은 DNS를 씁니다'),
    username: formField('아이디', username),
    password: formField('비밀번호', password),
    metric: formField('경로 우선순위 (metric)', metric, '숫자가 작을수록 먼저 씁니다'),
  };
  const staticBox = h('div', { class: 'fieldset' }, f.ip.el, f.mask.el, f.gateway.el);
  const pppoeBox = h('div', { class: 'fieldset' }, f.username.el, f.password.el);
  const dnsBox = h('div', null, f.dns.el);
  const routeBox = h('div', null, defaultRoute.el);
  const managed = n !== 'wan6' && known;
  const sync = () => {
    const p = proto.value;
    staticBox.hidden = !managed || p !== 'static';
    pppoeBox.hidden = !managed || p !== 'pppoe';
    dnsBox.hidden = !managed || p === 'none';
    routeBox.hidden = !managed || (p !== 'dhcp' && p !== 'pppoe');
  };
  proto.addEventListener('change', sync);
  sync();

  const save = h('button', { class: 'btn', type: 'button' }, '적용');
  const cancel = h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal }, '취소');
  save.addEventListener('click', async () => {
    Object.values(f).forEach((x) => x.setError(null));
    let bad = false;
    const p = proto.value;
    const want = {};
    const dnsList = dns.value.trim().split(/\s+/).filter(Boolean);
    const a = ip.value.trim();
    const mm = mask.value.trim();
    const gw = gateway.value.trim();
    let addrChanged = false;

    if (managed) {
      if (!protoHint) want.proto = p;
      Object.assign(want, { gateway: '', username: '', password: '', dns: '', peerdns: '', defaultroute: '' });
      if (p !== 'none' && dnsList.some((t) => !dnsOk(t))) { f.dns.setError('DNS 주소 형식이 올바르지 않습니다'); bad = true; }
      if (p === 'static') {
        const err = subnetError(ctx, a, mm, n);
        if (err) { (err.field === 'mask' ? f.mask : f.ip).setError(err.text); bad = true; }
        if (!gw && n === 'wan') { f.gateway.setError('인터넷 연결에는 게이트웨이가 필요합니다'); bad = true; }
        if (gw && !isIPv4(gw)) { f.gateway.setError('게이트웨이 형식이 올바르지 않습니다'); bad = true; }
        else if (gw && !err && (gw === a || !sameSubnet(a, gw, mm))) { f.gateway.setError('IP 주소와 다르고 같은 대역에 있는 주소를 입력해 주세요'); bad = true; }
        addrChanged = curProto !== 'static' || a !== cur.ip || mm !== cur.mask;
        if (addrChanged) {
          const cidr = `${a}/${maskBits(mm)}`;
          want.ipaddr = Array.isArray(cfg.ipaddr) ? [cidr, ...cfg.ipaddr.slice(1)] : cidr;
          want.netmask = '';
        }
        Object.assign(want, { gateway: gw, dns: dnsList.length ? dnsList : '' });
      } else {
        Object.assign(want, { ipaddr: '', netmask: '' });
        if (p !== 'none' && dnsList.length) Object.assign(want, { dns: dnsList, peerdns: '0' });
        if (p !== 'none') want.defaultroute = defaultRoute.input.checked ? '' : '0';
      }
      if (p === 'pppoe') {
        if (!username.value.trim()) { f.username.setError('아이디를 입력해 주세요'); bad = true; }
        if (!password.value) { f.password.setError('비밀번호를 입력해 주세요'); bad = true; }
        Object.assign(want, { username: username.value.trim(), password: password.value });
      }
    }

    const newDev = device.value;
    if (!devHint) {
      const other = ctx.ifaces.find((i) => i['.name'] !== n && !(n === 'wan' && i['.name'] === 'wan6') && newDev && ifaceDev(i) === newDev);
      const inBridge = ctx.devs.find((d) => d.type === 'bridge' && asList(d.ports).includes(newDev));
      if (!newDev && p !== 'none') { f.device.setError('장치를 골라 주세요'); bad = true; }
      else if (newDev !== curDev && other) { f.device.setError(`'${other['.name']}' 인터페이스가 쓰는 장치입니다`); bad = true; }
      else if (newDev !== curDev && inBridge) { f.device.setError(`'${inBridge.name}' 브리지의 포트입니다`); bad = true; }
      want.device = newDev;
    }
    const m = metric.value.trim();
    if (m && !/^\d{1,5}$/.test(m)) { f.metric.setError('0~99999 사이의 숫자를 입력해 주세요'); bad = true; }
    want.metric = m;
    if (!isLan) want.auto = auto.input.checked ? '' : '0';
    if (bad) return;

    const changed = {};
    for (const [k, v] of Object.entries(want)) {
      const old = k === 'auto' ? (cfg.auto === '0' ? '0' : '') : k === 'defaultroute' ? (cfg.defaultroute === '0' ? '0' : '') : asList(cfg[k]).join(' ');
      if ((Array.isArray(v) ? v.join(' ') : v) !== old) changed[k] = v;
    }
    const ops = Object.keys(changed).length ? [{ op: 'set', config: 'network', section: n, values: changed }] : [];
    // 인터넷 장치를 바꾸면 같은 장치를 쓰던 IPv6 인터페이스도 따라간다
    const wan6 = ctx.ifaces.find((i) => i['.name'] === 'wan6');
    if (n === 'wan' && changed.device && wan6 && ifaceDev(wan6) === curDev) {
      ops.push({ op: 'set', config: 'network', section: 'wan6', values: { device: newDev } });
    }
    if (!ops.length) { closeModal(); infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }

    const lanMoved = isLan && addrChanged;
    if (lanMoved && !await confirmDialog('내부 네트워크 주소 변경', [
      `공유기 주소가 ${a} 로 바뀝니다. 브라우저는 새 주소로 자동으로 이동합니다.`,
      h('p', { class: 'msg warn-msg' }, `${NET_EDIT_TIMEOUT}초 안에 새 주소로 접속하지 못하면 이전 설정으로 자동으로 되돌아갑니다.`),
    ], '변경')) return;
    closeModal();
    const r = await runApply(ops, { timeout: NET_EDIT_TIMEOUT, ...(lanMoved ? { newHost: a } : {}) });
    if (r === 'applied' || r === 'rolledback') done();
  });

  showModal(h('h3', null, `인터페이스 수정: ${IFACE_LABEL[n] || n}`),
    h('div', { class: 'fieldset' }, f.proto.el, f.device.el),
    staticBox, pppoeBox, dnsBox,
    f.metric.el,
    routeBox,
    isLan ? null : auto.el,
    h('div', { class: 'actions' }, cancel, save));
}

/* ---------- 장치 수정 ---------- */

// 브리지 포트로 고를 수 있는 장치: 지금 포트 + 공유기의 실제 포트 중 다른 곳에서 쓰지 않는 것
function bridgePortChoices(ctx, name, curPorts) {
  const net = (ctx.board && ctx.board.network) || {};
  const boardPorts = Object.values(net).flatMap((x) => [...asList(x.ports), ...(x.device ? [x.device] : [])]);
  const free = boardPorts.filter((p) => !/\.\d+$/.test(p)
    && !ctx.devs.some((d) => d.type === 'bridge' && d.name !== name && asList(d.ports).includes(p))
    && !ctx.ifaces.some((i) => ifaceDev(i) === p));
  return [...new Set([...curPorts, ...free])];
}

async function editDevice(name, status, done) {
  let ctx;
  try {
    ctx = await makeNetCtx();
  } catch (e) {
    netEditFailed('장치 수정', e);
    return;
  }
  const sec = ctx.devs.find((d) => d.name === name) || null;
  const isBridge = sec ? sec.type === 'bridge' : status.type === 'bridge' || status.devtype === 'bridge';
  const isVlanSec = !!sec && (sec.type === '8021q' || sec.type === '8021ad');
  if (isBridge && !sec) { infoModal('장치 수정', '설정 파일에 없는 브리지라 수정할 수 없습니다.'); return; }
  if (!sec && (/\.\d+$/.test(name) || status.devtype === 'vlan')) {
    infoModal('장치 수정', 'VLAN 설정 메뉴가 관리하는 장치입니다. 포트 구성은 VLAN 설정에서 바꿔 주세요.');
    return;
  }

  const cfg = sec || {};
  const text = (v, attrs) => h('input', { type: 'text', value: v || '', spellcheck: 'false', autocomplete: 'off', ...attrs });
  const mac = text(cfg.macaddr, { placeholder: status.macaddr || '00:11:22:33:44:55' });
  const mtu = text(cfg.mtu, { inputmode: 'numeric', placeholder: String(status.mtu || 1500) });
  const ipv6 = toggleEl(cfg.ipv6 !== '0', '이 장치에서 IPv6 사용');
  const f = {
    mac: formField('MAC 주소', mac, '비우면 장치의 원래 주소를 씁니다'),
    mtu: formField('MTU', mtu, '비우면 기본값. 576~9216'),
  };

  const curPorts = asList(cfg.ports);
  const hasVlans = ctx.net.some((v) => v['.type'] === 'bridge-vlan' && v.device === name);
  const portsLocked = hasVlans || cfg.bridge_empty === '1';
  const portOpts = isBridge ? bridgePortChoices(ctx, name, curPorts).map((p) => [p, portLabel(p)]) : [];
  const ports = isBridge && !portsLocked ? multiSelect('구성 포트', portOpts, curPorts,
    { chip: (v) => h('span', { class: 'ms-chip' }, portLabel(v)), empty: '포트 없음', hint: '접속에 쓰는 포트를 빼면 연결이 끊길 수 있습니다' }) : null;
  const stp = toggleEl(cfg.stp === '1', '루프 방지 (STP)');
  const igmp = toggleEl(cfg.igmp_snooping === '1', 'IGMP 스누핑 (멀티캐스트를 필요한 포트로만 전달)');

  const save = h('button', { class: 'btn', type: 'button' }, '적용');
  const cancel = h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal }, '취소');
  save.addEventListener('click', async () => {
    Object.values(f).forEach((x) => x.setError(null));
    if (ports) ports.setError(null);
    let bad = false;
    const macVal = mac.value.trim().toLowerCase();
    const macOk = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(macVal) && !(parseInt(macVal.slice(0, 2), 16) & 1) && macVal !== '00:00:00:00:00:00';
    if (macVal && !macOk) { f.mac.setError('예: 00:11:22:33:44:55 (멀티캐스트 주소는 쓸 수 없습니다)'); bad = true; }
    const mtuVal = mtu.value.trim();
    if (mtuVal && (!/^\d+$/.test(mtuVal) || +mtuVal < 576 || +mtuVal > 9216)) { f.mtu.setError('576~9216 사이의 숫자를 입력해 주세요'); bad = true; }
    const portVals = ports ? ports.values() : curPorts;
    if (ports && !portVals.length) { ports.setError('포트를 하나 이상 골라 주세요'); bad = true; }
    if (bad) return;

    const want = { macaddr: macVal, mtu: mtuVal, ipv6: ipv6.input.checked ? '' : '0' };
    if (isBridge) Object.assign(want, { stp: stp.input.checked ? '1' : '', igmp_snooping: igmp.input.checked ? '1' : '' });
    if (ports) want.ports = portVals;
    const changed = {};
    for (const [k, v] of Object.entries(want)) {
      let old = asList(cfg[k]).join(' ');
      if (k === 'ipv6') old = cfg.ipv6 === '0' ? '0' : '';
      if (k === 'stp' || k === 'igmp_snooping') old = cfg[k] === '1' ? '1' : '';
      if (k === 'macaddr') old = old.toLowerCase();
      if ((Array.isArray(v) ? v.join(' ') : v) !== old) changed[k] = v;
    }
    if (!Object.keys(changed).length) { closeModal(); infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
    const ops = sec
      ? [{ op: 'set', config: 'network', section: sec['.name'], values: changed }]
      : [{ op: 'add', config: 'network', type: 'device', values: { name, ...Object.fromEntries(Object.entries(changed).filter(([, v]) => v !== '')) } }];
    closeModal();
    const r = await runApply(ops, { timeout: NET_EDIT_TIMEOUT });
    if (r === 'applied' || r === 'rolledback') done();
  });

  showModal(h('h3', null, `장치 수정: ${portLabel(name)}${portLabel(name) !== name ? ` (${name})` : ''}`),
    isVlanSec ? h('p', { class: 'muted' }, `${portLabel(cfg.ifname || '-')}의 VLAN ${cfg.vid || '-'} 장치입니다. VLAN 번호는 VLAN 설정에서 바꿉니다.`) : null,
    h('div', { class: 'fieldset' }, f.mac.el, f.mtu.el),
    ports ? ports.el : null,
    isBridge && portsLocked ? h('p', { class: 'muted' }, hasVlans
      ? `구성 포트: ${curPorts.map(portLabel).join(', ') || '없음'}. VLAN을 쓰는 브리지의 포트는 VLAN 설정에서 바꿉니다.`
      : '무선 전용 브리지라 유선 포트가 없습니다.') : null,
    isBridge ? stp.el : null,
    isBridge ? igmp.el : null,
    ipv6.el,
    h('div', { class: 'actions' }, cancel, save));
}
