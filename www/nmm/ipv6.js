// IPv6 설정 (네트워크 관리)
//   인터넷 IPv6 = network의 wan6 인터페이스: 자동(proto dhcpv6, reqaddress/reqprefix) / 고정(proto static, ip6addr/ip6gw/ip6prefix) / 사용 안 함(disabled 1)
//   내부 네트워크 IPv6 = lan의 ip6assign + dhcp lan의 ra/dhcpv6/ndp (odhcpd)
//     자동: 공유기가 받은 프리픽스를 나눠 준다 (ra server, dhcpv6 server, ip6assign)
//     릴레이: 윗단이 /64 하나만 주고 프리픽스를 나눠 주지 않을 때. lan과 wan6 양쪽 dhcp 섹션에 ra/dhcpv6/ndp relay, wan6에는 master 1
//     사용 안 함: ra/dhcpv6 disabled, ip6assign 없음
//   ULA 프리픽스 = network globals의 ula_prefix (fdxx::/48, 인터넷과 상관없이 내부에서 쓰는 IPv6)

const IP6_APPLY_TIMEOUT = 120;
const WAN6_MODES = [['dhcpv6', '자동 (DHCPv6 / SLAAC)'], ['static', '고정 IPv6'], ['off', '사용 안 함']];
const LAN6_MODES = [['server', '자동 (받은 프리픽스를 나눠 주기, 권장)'], ['relay', '릴레이 (윗단의 IPv6를 그대로 전달)'], ['off', '사용 안 함']];
const REQ_ADDRESS = [['try', '받을 수 있으면 받기 (기본)'], ['force', '꼭 받기'], ['none', '받지 않기']];
const REQ_PREFIX = [['auto', '자동 (기본)'], ['48', '/48'], ['56', '/56'], ['60', '/60'], ['64', '/64'], ['no', '요청 안 함']];
const IP6_ASSIGN = [['64', '/64 (기본 크기)'], ['60', '/60'], ['56', '/56']];

function isIPv6(s) {
  const t = String(s || '');
  if (!/^[0-9A-Fa-f:]+$/.test(t) || !t.includes(':')) return false;
  const dbl = (t.match(/::/g) || []).length;
  if (dbl > 1) return false;
  const parts = t.split(':').filter((x, i, arr) => !(x === '' && (i === 0 || i === arr.length - 1 || dbl)));
  return parts.every((x) => x.length <= 4) && (dbl ? parts.length < 8 : parts.length === 8);
}

function isIPv6Cidr(s, maxLen = 128) {
  const [a, m, more] = String(s || '').split('/');
  return more === undefined && isIPv6(a) && /^\d{1,3}$/.test(m || '') && +m <= maxLen;
}

function ipv6Page(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('IPv6 설정'), body);
  let alive = true;
  const reload = () => { if (alive) load(); };

  async function load() {
    let net, dhcp, dump, fw;
    try {
      [net, dhcp, dump, fw] = await Promise.all([uciSections('network'), uciSections('dhcp'), ubus('network.interface', 'dump'), uciSections('firewall')]);
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (!alive) return;
    const ifaces = (net || []).filter((s) => s['.type'] === 'interface');
    const ctx = {
      net: net || [],
      dhcp: dhcp || [],
      fw: fw || [],
      live: dump.interface || [],
      globals: (net || []).find((s) => s['.type'] === 'globals') || null,
      lan: ifaces.find((s) => s['.name'] === 'lan'),
      wan: ifaces.find((s) => s['.name'] === 'wan'),
      wan6: ifaces.find((s) => s['.name'] === 'wan6'),
    };
    ctx.dlan = ctx.dhcp.find((s) => s['.type'] === 'dhcp' && s.interface === 'lan') || null;
    ctx.dwan6 = ctx.dhcp.find((s) => s['.type'] === 'dhcp' && s.interface === 'wan6') || null;
    if (!ctx.lan) { body.replaceChildren(messageCard('내부 네트워크(lan) 인터페이스가 없습니다.')); return; }
    body.replaceChildren(statusCard(ctx), wanCard(ctx), lanCard(ctx));
  }

  async function apply(ops, btn) {
    if (!ops.length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
    if (btn) btn.disabled = true;
    const r = await runApply(ops, { timeout: IP6_APPLY_TIMEOUT });
    if (btn) btn.disabled = false;
    if (r === 'applied' || r === 'rolledback') reload();
  }

  /* ---------- 상태 ---------- */

  function statusCard(ctx) {
    const live = (n) => ctx.live.find((i) => i.interface === n);
    const w6 = live('wan6');
    const l = live('lan');
    const addrs = (i, key) => ((i && i[key]) || []).map((a) => `${a.address}/${a.mask}`);
    const assigned = ((l && l['ipv6-prefix-assignment']) || []).map((a) => `${a.address}/${a.mask}`);
    const [text, tone] = ipv6Summary(ctx.live);
    const rows = [
      ['인터넷 IPv6', h('span', { class: 'pill ' + (tone || 'off') }, text)],
      ['인터넷 쪽 주소', addrs(w6, 'ipv6-address').join(', ') || '-'],
      ['받은 프리픽스', addrs(w6, 'ipv6-prefix').join(', ') || '-'],
      ['내부 네트워크에 나눠 준 프리픽스', assigned.join(', ') || '-'],
      ['ULA (내부 전용 IPv6)', (ctx.globals && ctx.globals.ula_prefix) || '사용 안 함'],
    ];
    const pending = w6 && w6.pending && !w6.up;
    return h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, '지금 상태')),
      h('dl', { class: 'kv kv-wide' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      pending ? h('p', { class: 'msg warn-msg' },
        '인터넷 쪽에서 IPv6 응답이 없습니다. 윗단 공유기나 통신사가 IPv6를 주지 않으면 여기 설정만으로는 IPv6 인터넷을 쓸 수 없습니다. '
        + '윗단 공유기에서 IPv6를 켜거나, 통신사의 IPv6 지원 여부를 확인해 주세요. 윗단이 /64 하나만 준다면 아래 내부 네트워크를 "릴레이"로 바꿔 보세요.') : null);
  }

  /* ---------- 인터넷 IPv6 (wan6) ---------- */

  function wanCard(ctx) {
    const w6 = ctx.wan6;
    const curMode = !w6 || w6.disabled === '1' ? 'off' : (w6.proto === 'static' ? 'static' : (w6.proto === 'dhcpv6' ? 'dhcpv6' : w6.proto));
    const mode = selectEl(WAN6_MODES, curMode);
    const reqAddr = selectEl(REQ_ADDRESS, (w6 && w6.reqaddress) || 'try');
    const reqPfx = selectEl(REQ_PREFIX, (w6 && w6.reqprefix) || 'auto');
    const text = (v, ph) => h('input', { type: 'text', value: v || '', spellcheck: 'false', placeholder: ph });
    const ip6addr = text(w6 && asList(w6.ip6addr)[0], '예: 2001:db8:1::2/64');
    const ip6gw = text(w6 && w6.ip6gw, '예: 2001:db8:1::1');
    const ip6prefix = text(w6 && asList(w6.ip6prefix)[0], '예: 2001:db8:100::/56 (없으면 비우기)');
    const f = {
      mode: formField('연결 방식', mode, curMode !== 'off' && !['dhcpv6', 'static'].includes(curMode) ? `지금은 '${curMode}' 방식입니다. 이 화면에서 바꾸면 덮어씁니다.` : ''),
      reqAddr: formField('주소 받기', reqAddr),
      reqPfx: formField('프리픽스 요청 크기', reqPfx, '내부 네트워크에 나눠 줄 주소 묶음. 통신사가 정해 준 크기가 있으면 맞추세요'),
      ip6addr: formField('IPv6 주소', ip6addr),
      ip6gw: formField('게이트웨이', ip6gw),
      ip6prefix: formField('내부로 나눠 줄 프리픽스', ip6prefix),
    };
    const autoBox = h('div', { class: 'fieldset' }, f.reqAddr.el, f.reqPfx.el);
    const staticBox = h('div', null, h('div', { class: 'fieldset' }, f.ip6addr.el, f.ip6gw.el), f.ip6prefix.el);
    const sync = () => { autoBox.hidden = mode.value !== 'dhcpv6'; staticBox.hidden = mode.value !== 'static'; };
    mode.addEventListener('change', sync);
    sync();

    const btn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    btn.addEventListener('click', () => {
      Object.values(f).forEach((x) => x.setError(null));
      const m = mode.value;
      const ops = [];
      if (m === 'off') {
        if (w6 && w6.disabled !== '1') ops.push({ op: 'set', config: 'network', section: 'wan6', values: { disabled: '1' } });
        apply(ops, btn);
        return;
      }
      let v;
      if (m === 'dhcpv6') {
        v = { proto: 'dhcpv6', reqaddress: reqAddr.value === 'try' ? '' : reqAddr.value, reqprefix: reqPfx.value === 'auto' ? '' : reqPfx.value,
          ip6addr: '', ip6gw: '', ip6prefix: '' };
      } else {
        let bad = false;
        if (!isIPv6Cidr(ip6addr.value.trim())) { f.ip6addr.setError('주소/길이 형식으로 입력해 주세요 (예: 2001:db8::2/64)'); bad = true; }
        if (!isIPv6(ip6gw.value.trim())) { f.ip6gw.setError('IPv6 주소 형식이 올바르지 않습니다'); bad = true; }
        if (ip6prefix.value.trim() && !isIPv6Cidr(ip6prefix.value.trim(), 64)) { f.ip6prefix.setError('예: 2001:db8:100::/56'); bad = true; }
        if (bad) return;
        v = { proto: 'static', ip6addr: ip6addr.value.trim(), ip6gw: ip6gw.value.trim(), ip6prefix: ip6prefix.value.trim(), reqaddress: '', reqprefix: '' };
      }
      if (!w6) {
        // wan6가 없으면 인터넷(wan)과 같은 장치로 만든다 ('@wan'은 wan이 쓰는 장치를 따라간다)
        ops.push({ op: 'add', config: 'network', type: 'interface', name: 'wan6', values: { device: '@wan', ...dropEmpty(v) } });
        ops.push(...wan6ZoneOps(ctx));
      } else {
        const changed = {};
        for (const [k, val] of Object.entries(v)) if ((asList(w6[k]).join(' ') || '') !== val) changed[k] = val;
        if (w6.disabled === '1') changed.disabled = '';
        if (Object.keys(changed).length) ops.push({ op: 'set', config: 'network', section: 'wan6', values: changed });
      }
      apply(ops, btn);
    });
    return h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, '인터넷 IPv6')),
      h('p', { class: 'muted' }, '대부분의 통신사는 "자동"으로 됩니다. 고정 IPv6는 통신사나 터널 서비스가 주소를 정해 준 경우에만 쓰세요.'),
      h('div', { class: 'fieldset' }, f.mode.el), autoBox, staticBox,
      h('div', { class: 'actions' }, btn));
  }

  // 새로 만든 wan6를 방화벽 wan 영역에 넣는다 (OpenWrt 기본 설정은 이미 들어 있다)
  function wan6ZoneOps(ctx) {
    const z = (ctx.fw || []).find((s) => s['.type'] === 'zone' && asList(s.network).includes('wan'));
    if (!z || asList(z.network).includes('wan6')) return [];
    return [{ op: 'set', config: 'firewall', section: z['.name'], values: { network: [...asList(z.network), 'wan6'] } }];
  }

  /* ---------- 내부 네트워크 IPv6 (lan + dhcp) ---------- */

  function lanCard(ctx) {
    const d = ctx.dlan || {};
    const curMode = d.ra === 'relay' || d.dhcpv6 === 'relay' ? 'relay'
      : ((d.ra === 'disabled' || !d.ra) && (d.dhcpv6 === 'disabled' || !d.dhcpv6) && !ctx.lan.ip6assign ? 'off' : 'server');
    const mode = selectEl(LAN6_MODES, curMode);
    const assign = selectEl(IP6_ASSIGN, ctx.lan.ip6assign || '60');
    const ulaCur = (ctx.globals && ctx.globals.ula_prefix) || '';
    const ula = h('input', { type: 'text', value: ulaCur, spellcheck: 'false', placeholder: '예: fd12:3456:789a::/48 (비우면 사용 안 함)' });
    const fAssign = formField('나눠 줄 크기', assign, '보통 /64면 충분합니다. 내부에 네트워크를 더 나누려면 더 큰 크기(/60)');
    const fUla = formField('ULA 프리픽스 (내부 전용 IPv6)', ula, '인터넷 IPv6가 없어도 내부 기기끼리 IPv6로 통신할 수 있게 합니다');
    const serverBox = h('div', { class: 'fieldset' }, fAssign.el);
    const relayNote = h('p', { class: 'muted' }, '릴레이는 윗단 공유기가 IPv6 주소(/64)를 주지만 프리픽스를 나눠 주지 않을 때 씁니다. 내부 기기가 윗단에서 직접 IPv6 주소를 받습니다.');
    const sync = () => { serverBox.hidden = mode.value !== 'server'; relayNote.hidden = mode.value !== 'relay'; };
    mode.addEventListener('change', sync);
    sync();

    const btn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    btn.addEventListener('click', async () => {
      fUla.setError(null);
      const m = mode.value;
      const ulaVal = ula.value.trim();
      if (ulaVal && !(isIPv6Cidr(ulaVal, 64) && /^f[cd]/i.test(ulaVal))) { fUla.setError('fc00::/7 안의 주소로 입력해 주세요 (예: fd12:3456:789a::/48)'); return; }
      if (m === 'relay' && !ctx.wan6) { infoModal('IPv6 설정', '릴레이를 쓰려면 먼저 인터넷 IPv6를 "자동"으로 켜 주세요.', true); return; }
      const ops = [];
      const setIf = (section, cur, want, config) => {
        const changed = {};
        for (const [k, v] of Object.entries(want)) if ((asList(cur[k]).join(' ') || '') !== (Array.isArray(v) ? v.join(' ') : v)) changed[k] = v;
        if (Object.keys(changed).length) ops.push({ op: 'set', config, section, values: changed });
      };
      // lan 인터페이스
      setIf('lan', ctx.lan, { ip6assign: m === 'server' ? assign.value : '' }, 'network');
      // dhcp lan
      const lanWant = {
        server: { ra: 'server', dhcpv6: 'server', ndp: '' },
        relay: { ra: 'relay', dhcpv6: 'relay', ndp: 'relay' },
        off: { ra: 'disabled', dhcpv6: 'disabled', ndp: '' },
      }[m];
      if (ctx.dlan) setIf(ctx.dlan['.name'], ctx.dlan, lanWant, 'dhcp');
      else ops.push({ op: 'add', config: 'dhcp', type: 'dhcp', name: 'lan', values: { interface: 'lan', ...dropEmpty(lanWant) } });
      // dhcp wan6 (릴레이의 윗단 쪽)
      if (m === 'relay') {
        const w = { master: '1', ra: 'relay', dhcpv6: 'relay', ndp: 'relay' };
        if (ctx.dwan6) setIf(ctx.dwan6['.name'], ctx.dwan6, w, 'dhcp');
        else ops.push({ op: 'add', config: 'dhcp', type: 'dhcp', name: 'wan6', values: { interface: 'wan6', ...w } });
      } else if (ctx.dwan6) {
        setIf(ctx.dwan6['.name'], ctx.dwan6, { master: '', ra: '', dhcpv6: '', ndp: '' }, 'dhcp');
      }
      // ULA
      if (ulaVal !== ulaCur) {
        if (ctx.globals) ops.push({ op: 'set', config: 'network', section: ctx.globals['.name'], values: { ula_prefix: ulaVal } });
        else if (ulaVal) ops.push({ op: 'add', config: 'network', type: 'globals', name: 'globals', values: { ula_prefix: ulaVal } });
      }
      if (ops.length && !await confirmDialog('내부 네트워크 IPv6', [
        '내부 기기의 IPv6 주소가 바뀌어 잠시 연결이 끊길 수 있습니다.',
        h('p', { class: 'msg warn-msg' }, `${IP6_APPLY_TIMEOUT}초 안에 다시 연결되지 않으면 자동으로 되돌아갑니다.`),
      ], '적용')) return;
      apply(ops, btn);
    });
    return h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, '내부 네트워크 IPv6')),
      h('p', { class: 'muted' }, '내부 기기에 IPv6 주소를 나눠 주는 방식입니다.'),
      h('div', { class: 'fieldset' }, formField('방식', mode).el), serverBox, relayNote, fUla.el,
      h('div', { class: 'actions' }, btn));
  }

  load();
  return () => { alive = false; };
}

PAGES['/ipv6'] = ipv6Page;
