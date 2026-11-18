// 라우팅 규칙 (NAT/라우터 관리): network의 route, route6(고정 경로)와 rule, rule6(정책 규칙).
//   경로: 어떤 대상으로 가는 패킷을 어느 인터페이스와 게이트웨이로 보낼지 정한다.
//   규칙: 출발 주소나 인터페이스 같은 조건에 따라 어떤 라우팅 테이블을 쓸지 정한다.
//   이 화면이 다루지 않는 옵션(source, tos, ipproto, uidrange 등)은 그대로 둔다.

const ROUTING_APPLY_TIMEOUT = 120;
const ROUTING_TABS = [
  ['route', 'IPv4 고정 경로', '정해진 대상으로 가는 IPv4 패킷의 경로를 지정합니다.'],
  ['route6', 'IPv6 고정 경로', '정해진 대상으로 가는 IPv6 패킷의 경로를 지정합니다.'],
  ['rule', 'IPv4 규칙', '출발 주소나 인터페이스 같은 조건에 따라 사용할 IPv4 라우팅 테이블을 정합니다.'],
  ['rule6', 'IPv6 규칙', '출발 주소나 인터페이스 같은 조건에 따라 사용할 IPv6 라우팅 테이블을 정합니다.'],
];
const ROUTE_TYPES = [
  ['', '일반 경로'], ['blackhole', '버림 (응답 없음)'], ['unreachable', '도달 불가 응답'],
  ['prohibit', '금지 응답'], ['throw', '다음 규칙으로 넘김'], ['local', '공유기 자신에게 전달'],
];
const RULE_ACTIONS = [
  ['lookup', '라우팅 테이블 사용'], ['goto', '다른 규칙으로 건너뛰기'], ['blackhole', '버림 (응답 없음)'],
  ['unreachable', '도달 불가 응답'], ['prohibit', '금지 응답'],
];
const ROUTE_TABLE_RE = /^[A-Za-z0-9_-]{1,31}$/;

const routeIfaceText = (n) => (n ? IFACE_LABEL[n] || n : '-');
const routeInt = (s, max) => /^\d{1,10}$/.test(s) && +s <= max;

// IPv4 대상은 target + netmask로 저장되어 있을 수 있다
function routeTarget(s) {
  const t = String(s.target || '');
  return s.netmask && !t.includes('/') && isNetmask(s.netmask) ? `${t}/${maskBits(s.netmask)}` : t;
}

// 주소 또는 주소/프리픽스 검사. wide = false면 주소 하나만
function routeAddrOk(t, v6, wide) {
  if (!t || t.startsWith('!') || !okIp(t)) return false;
  const [addr, bits] = t.split('/');
  if (isIPv4(addr) === v6) return false;
  if (bits === undefined) return true;
  return wide && /^\d+$/.test(bits);
}

function routingPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('라우팅 규칙'), body);
  let alive = true;
  let tab = 'route';
  const reload = () => { if (alive) load(); };

  async function load() {
    let net;
    try {
      net = await uciSections('network');
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (!alive) return;
    if (!net) { body.replaceChildren(messageCard('네트워크 설정을 찾을 수 없습니다.')); return; }
    render({ net, ifaces: net.filter((s) => s['.type'] === 'interface' && s['.name'] !== 'loopback').map((s) => s['.name']) });
  }

  async function apply(ops) {
    if (!ops.length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
    const r = await runApply(ops, { timeout: ROUTING_APPLY_TIMEOUT });
    if (r === 'applied' || r === 'rolledback') reload();
  }

  // 새 섹션이면 추가, 있으면 바뀐 옵션만 고친다
  function saveOps(type, s, want) {
    if (!s) return [{ op: 'add', config: 'network', type, values: Object.fromEntries(Object.entries(want).filter(([, v]) => v !== '')) }];
    const changed = Object.fromEntries(Object.entries(want).filter(([k, v]) => v !== asList(s[k]).join(' ')));
    return Object.keys(changed).length ? [{ op: 'set', config: 'network', section: s['.name'], values: changed }] : [];
  }

  const actionButtons = (s, edit, what) => {
    const on = s.disabled !== '1';
    return h('td', { class: 'actions-cell' },
      h('button', { class: 'btn btn-ghost btn-small', type: 'button',
        onclick: () => apply([{ op: 'set', config: 'network', section: s['.name'], values: { disabled: on ? '1' : '' } }]) }, on ? '중지' : '사용'),
      h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: edit }, '수정'),
      h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: async () => {
        if (await confirmDialog(`${what} 삭제`, `이 ${what}를 삭제합니다.`, '삭제', true)) apply([{ op: 'delete', config: 'network', section: s['.name'] }]);
      } }, '삭제'));
  };
  const statePill = (s) => h('td', null, h('span', { class: 'pill ' + (s.disabled === '1' ? 'off' : 'ok') }, s.disabled === '1' ? '꺼짐' : '사용'));

  function render(ctx) {
    const [type, , desc] = ROUTING_TABS.find(([k]) => k === tab);
    const isRoute = type.startsWith('route');
    const list = ctx.net.filter((s) => s['.type'] === type);
    const heads = isRoute ? ['인터페이스', '대상', '게이트웨이', 'Metric', '테이블', '상태', ''] : ['우선순위', '조건', '동작', '상태', ''];
    const rows = list.map((s) => (isRoute ? routeRow(ctx, type, s) : ruleRow(ctx, type, s)));
    const addBtn = h('button', { class: 'btn btn-inline', type: 'button',
      onclick: () => (isRoute ? editRoute(ctx, type, null) : editRule(ctx, type, null)) }, isRoute ? '경로 추가' : '규칙 추가');
    body.replaceChildren(h('section', { class: 'card', style: 'max-width:none' },
      h('div', { class: 'seg' }, ROUTING_TABS.map(([k, label]) => h('button', {
        type: 'button', class: 'seg-btn' + (k === tab ? ' on' : ''), onclick: () => { tab = k; render(ctx); },
      }, label))),
      h('p', { class: 'muted', style: 'margin-top:12px' }, desc),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ...heads.map((x) => h('th', null, x)))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: heads.length, class: 'muted' }, isRoute ? '등록된 경로가 없습니다.' : '등록된 규칙이 없습니다.'))))),
      h('div', { class: 'actions' }, addBtn)));
  }

  /* ---------- 고정 경로 ---------- */

  function routeRow(ctx, type, s) {
    const kind = ROUTE_TYPES.find(([k]) => k === s.type && k);
    return h('tr', { class: s.disabled === '1' ? 'row-off' : '' },
      h('td', null, h('b', null, routeIfaceText(s.interface)), IFACE_LABEL[s.interface] ? h('div', { class: 'muted' }, s.interface) : null),
      h('td', null, routeTarget(s) || '-', kind ? h('div', { class: 'muted' }, kind[1]) : null),
      h('td', null, s.gateway || '-'),
      h('td', null, s.metric || '-'),
      h('td', null, s.table || 'main'),
      statePill(s),
      actionButtons(s, () => editRoute(ctx, type, s), '경로'));
  }

  function editRoute(ctx, type, s) {
    const v6 = type === 'route6';
    const cur = s || {};
    const text = (v, ph) => h('input', { type: 'text', value: v || '', spellcheck: 'false', placeholder: ph || '' });
    const iface = selectEl([['', '-'], ...ctx.ifaces.map((n) => [n, routeIfaceText(n) === n ? n : `${routeIfaceText(n)} (${n})`])], cur.interface || '');
    const kind = selectEl(ROUTE_TYPES, cur.type === 'unicast' ? '' : cur.type || '');
    const target = text(routeTarget(cur), v6 ? '예: 2001:db8:1::/48' : '예: 192.168.50.0/24');
    const gateway = text(cur.gateway, v6 ? '예: fe80::1' : '예: 192.168.1.2');
    const metric = text(cur.metric, '비우면 기본값');
    const table = text(cur.table, '비우면 main');
    const mtu = text(cur.mtu, '비우면 기본값');
    const onlink = toggleEl(cur.onlink === '1', '게이트웨이가 다른 대역이어도 바로 연결된 것으로 처리 (onlink)');
    const enabled = toggleEl(cur.disabled !== '1', '이 경로 사용');
    const f = {
      iface: formField('인터페이스', iface),
      kind: formField('경로 종류', kind),
      target: formField('대상', target, '주소 또는 대역. 모든 대상은 ' + (v6 ? '::/0' : '0.0.0.0/0')),
      gateway: formField('게이트웨이', gateway, '직접 연결된 대역이면 비워 두세요'),
      metric: formField('Metric', metric, '숫자가 작을수록 먼저 씁니다'),
      table: formField('라우팅 테이블', table, '테이블 번호 또는 이름'),
      mtu: formField('MTU', mtu),
    };
    const gwBox = h('div', null, f.gateway.el, onlink.el);
    const sync = () => { gwBox.hidden = !!kind.value; };
    kind.addEventListener('change', sync);
    sync();

    const save = h('button', { class: 'btn', type: 'button' }, '적용');
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal }, '취소');
    save.addEventListener('click', () => {
      Object.values(f).forEach((x) => x.setError(null));
      let bad = false;
      const t = target.value.trim();
      const gw = kind.value ? '' : gateway.value.trim();
      const [m, tb, mt] = [metric.value.trim(), table.value.trim(), mtu.value.trim()];
      if (!iface.value) { f.iface.setError('인터페이스를 골라 주세요'); bad = true; }
      if (!routeAddrOk(t, v6, true)) { f.target.setError(`${v6 ? 'IPv6' : 'IPv4'} 주소 또는 대역을 입력해 주세요`); bad = true; }
      if (gw && !routeAddrOk(gw, v6, false)) { f.gateway.setError(`${v6 ? 'IPv6' : 'IPv4'} 주소를 입력해 주세요`); bad = true; }
      if (m && !routeInt(m, 4294967295)) { f.metric.setError('숫자를 입력해 주세요'); bad = true; }
      if (tb && !ROUTE_TABLE_RE.test(tb)) { f.table.setError('영문, 숫자, _ - 로 입력해 주세요'); bad = true; }
      if (mt && (!routeInt(mt, 65535) || +mt < (v6 ? 1280 : 68))) { f.mtu.setError(`${v6 ? 1280 : 68}~65535 사이의 숫자를 입력해 주세요`); bad = true; }
      if (bad) return;
      const want = {
        interface: iface.value, gateway: gw, metric: m, table: tb, mtu: mt,
        onlink: !kind.value && onlink.input.checked ? '1' : '',
        disabled: enabled.input.checked ? '' : '1',
      };
      if (!s || t !== routeTarget(s)) Object.assign(want, { target: t }, v6 ? {} : { netmask: '' });
      if (kind.value || (cur.type && cur.type !== 'unicast')) want.type = kind.value;
      closeModal();
      apply(saveOps(type, s, want));
    });

    showModal(h('h3', null, `${v6 ? 'IPv6' : 'IPv4'} 경로 ${s ? '수정' : '추가'}`),
      h('div', { class: 'fieldset' }, f.iface.el, f.kind.el),
      f.target.el, gwBox,
      h('div', { class: 'fieldset' }, f.metric.el, f.table.el, f.mtu.el),
      enabled.el,
      h('div', { class: 'actions' }, cancel, save));
  }

  /* ---------- 정책 규칙 ---------- */

  function ruleConditions(s) {
    const parts = [['출발', s.src], ['도착', s.dest], ['들어오는 인터페이스', s.in && routeIfaceText(s.in)],
      ['나가는 인터페이스', s.out && routeIfaceText(s.out)], ['표시값', s.mark]].filter(([, v]) => v);
    if (!parts.length) return h('span', { class: 'muted' }, '모든 패킷');
    return h('div', { class: 'rule-match' }, parts.map(([k, v]) => h('div', null, `${k} ${v}`)),
      s.invert === '1' ? h('div', { class: 'muted' }, '위 조건에 맞지 않는 패킷에 적용') : null);
  }

  const ruleActionOf = (s) => s.action || (s.goto ? 'goto' : 'lookup');

  function ruleRow(ctx, type, s) {
    const a = ruleActionOf(s);
    const text = a === 'lookup' ? `테이블 ${s.lookup || '-'}` : a === 'goto' ? `우선순위 ${s.goto}로 건너뜀`
      : (RULE_ACTIONS.find(([k]) => k === a) || [a, a])[1];
    return h('tr', { class: s.disabled === '1' ? 'row-off' : '' },
      h('td', null, h('b', null, s.priority || '자동')),
      h('td', null, ruleConditions(s)),
      h('td', null, text),
      statePill(s),
      actionButtons(s, () => editRule(ctx, type, s), '규칙'));
  }

  function editRule(ctx, type, s) {
    const v6 = type === 'rule6';
    const cur = s || {};
    const text = (v, ph) => h('input', { type: 'text', value: v || '', spellcheck: 'false', placeholder: ph || '' });
    const ifaceOpts = [['', '모두'], ...ctx.ifaces.map((n) => [n, routeIfaceText(n) === n ? n : `${routeIfaceText(n)} (${n})`])];
    const priority = text(cur.priority, '비우면 자동');
    const action = selectEl(RULE_ACTIONS, ruleActionOf(cur));
    const lookup = text(cur.lookup, '예: 100');
    const gotoTo = text(cur.goto, '예: 2000');
    const src = text(cur.src, v6 ? '예: 2001:db8:1::/64' : '예: 192.168.1.0/24');
    const dest = text(cur.dest, '비우면 모두');
    const inIf = selectEl(ifaceOpts, cur.in || '');
    const outIf = selectEl(ifaceOpts, cur.out || '');
    const mark = text(cur.mark, '예: 0x1/0xff');
    const invert = toggleEl(cur.invert === '1', '조건에 맞지 않는 패킷에 적용');
    const enabled = toggleEl(cur.disabled !== '1', '이 규칙 사용');
    const f = {
      priority: formField('우선순위', priority, '숫자가 작을수록 먼저 검사합니다'),
      action: formField('동작', action),
      lookup: formField('라우팅 테이블', lookup, '테이블 번호 또는 이름'),
      gotoTo: formField('건너뛸 우선순위', gotoTo),
      src: formField('출발 주소', src),
      dest: formField('도착 주소', dest),
      inIf: formField('들어오는 인터페이스', inIf),
      outIf: formField('나가는 인터페이스', outIf),
      mark: formField('방화벽 표시값 (mark)', mark),
    };
    const sync = () => { f.lookup.el.hidden = action.value !== 'lookup'; f.gotoTo.el.hidden = action.value !== 'goto'; };
    action.addEventListener('change', sync);
    sync();

    const save = h('button', { class: 'btn', type: 'button' }, '적용');
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal }, '취소');
    save.addEventListener('click', () => {
      Object.values(f).forEach((x) => x.setError(null));
      let bad = false;
      const [p, l, g, sv, dv, mk] = [priority, lookup, gotoTo, src, dest, mark].map((x) => x.value.trim());
      const a = action.value;
      if (p && !routeInt(p, 4294967295)) { f.priority.setError('숫자를 입력해 주세요'); bad = true; }
      if (a === 'lookup' && !ROUTE_TABLE_RE.test(l)) { f.lookup.setError('사용할 테이블을 입력해 주세요'); bad = true; }
      if (a === 'goto' && !routeInt(g, 4294967295)) { f.gotoTo.setError('건너뛸 우선순위를 숫자로 입력해 주세요'); bad = true; }
      if (sv && !routeAddrOk(sv, v6, true)) { f.src.setError(`${v6 ? 'IPv6' : 'IPv4'} 주소 또는 대역을 입력해 주세요`); bad = true; }
      if (dv && !routeAddrOk(dv, v6, true)) { f.dest.setError(`${v6 ? 'IPv6' : 'IPv4'} 주소 또는 대역을 입력해 주세요`); bad = true; }
      if (mk && !/^(0x[0-9a-fA-F]{1,8}|\d{1,10})(\/(0x[0-9a-fA-F]{1,8}|\d{1,10}))?$/.test(mk)) { f.mark.setError('예: 0x1 또는 0x1/0xff'); bad = true; }
      if (bad) return;
      const want = {
        priority: p, src: sv, dest: dv, in: inIf.value, out: outIf.value, mark: mk,
        invert: invert.input.checked ? '1' : '',
        lookup: a === 'lookup' ? l : '', goto: a === 'goto' ? g : '',
        action: a === 'lookup' || a === 'goto' ? '' : a,
        disabled: enabled.input.checked ? '' : '1',
      };
      closeModal();
      apply(saveOps(type, s, want));
    });

    showModal(h('h3', null, `${v6 ? 'IPv6' : 'IPv4'} 규칙 ${s ? '수정' : '추가'}`),
      h('div', { class: 'fieldset' }, f.priority.el, f.action.el, f.lookup.el, f.gotoTo.el),
      h('div', { class: 'fieldset' }, f.src.el, f.dest.el),
      h('div', { class: 'fieldset' }, f.inIf.el, f.outIf.el),
      f.mark.el, invert.el, enabled.el,
      h('div', { class: 'actions' }, cancel, save));
  }

  load();
  return () => { alive = false; };
}

PAGES['/routing'] = routingPage;
