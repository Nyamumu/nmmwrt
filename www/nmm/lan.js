// 내부 네트워크 설정, DHCP 서버 설정(+고정 IP 할당)

const LAN_APPLY_TIMEOUT = 120; // 주소가 바뀌면 기기가 새 주소를 받을 시간이 필요하다

/* ---------- 내부 네트워크 설정 ---------- */

function lanPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('내부 네트워크 설정'), body);
  let alive = true;

  async function load() {
    let lan, wan;
    try {
      [lan, wan] = await Promise.all([
        ubus('uci', 'get', { config: 'network', section: 'lan' }),
        ubus('uci', 'get', { config: 'network', section: 'wan' }),
      ]);
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (!alive) return;
    if (!lan || !lan.values) {
      body.replaceChildren(messageCard('내부 네트워크(LAN) 설정을 찾을 수 없습니다.'));
      return;
    }
    render(lan.values, wan && wan.values ? readAddr(wan.values) : null);
  }

  function render(cfg, wanAddr) {
    const cur = readAddr(cfg);
    const ip = h('input', { type: 'text', value: cur.ip, inputmode: 'decimal', spellcheck: 'false' });
    const mask = h('input', { type: 'text', value: cur.mask || '255.255.255.0', inputmode: 'decimal', spellcheck: 'false' });
    const fIp = formField('내부 IP 주소 (공유기 주소)', ip, '예: 192.168.1.1');
    const fMask = formField('서브넷 마스크', mask, '예: 255.255.255.0');
    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');

    applyBtn.addEventListener('click', async () => {
      const newIp = ip.value.trim();
      const newMask = mask.value.trim();
      fIp.setError(null);
      fMask.setError(null);
      let bad = false;
      if (!isIPv4(newIp)) { fIp.setError('IP 주소 형식이 올바르지 않습니다.'); bad = true; }
      if (!isNetmask(newMask)) { fMask.setError('서브넷 마스크 형식이 올바르지 않습니다.'); bad = true; }
      if (!bad) {
        const n = ipToInt(newIp);
        const m = ipToInt(newMask);
        const hostPart = (n & ~m) >>> 0;
        if (hostPart === 0 || hostPart === ((~m) >>> 0)) { fIp.setError('네트워크 주소나 브로드캐스트 주소는 쓸 수 없습니다.'); bad = true; }
        if (wanAddr && wanAddr.ip && sameSubnet(newIp, wanAddr.ip, newMask)) {
          fIp.setError(`인터넷(WAN) 주소(${wanAddr.ip})와 같은 대역입니다.`); bad = true;
        }
      }
      if (bad) return;
      if (newIp === cur.ip && newMask === cur.mask) {
        infoModal('설정 적용', '바뀐 내용이 없습니다.');
        return;
      }
      const prefix = mask.value.trim().split('.').reduce((a, p) => a + (+p).toString(2).split('1').length - 1, 0);
      const ok = await confirmDialog('내부 네트워크 주소 변경', [
        `공유기 주소가 ${newIp} 로 바뀝니다.`,
        '브라우저는 새 주소로 자동으로 이동합니다. 접속이 끊기면 랜선을 다시 꽂거나 무선을 다시 연결해 주세요.',
        h('p', { class: 'msg warn-msg' }, `${LAN_APPLY_TIMEOUT}초 안에 새 주소로 접속하지 못하면 이전 설정으로 자동으로 되돌아갑니다. 고정 IP 할당과 포트포워드의 주소도 새 대역에 맞게 고쳐야 합니다.`),
      ], '변경');
      if (!ok) return;
      applyBtn.disabled = true;
      // 기존 형식을 지킨다: 목록이면 목록, 문자열이면 문자열 (둘 다 CIDR로 쓰고 netmask는 지운다)
      const cidr = `${newIp}/${prefix}`;
      const result = await runApply(
        [{ op: 'set', config: 'network', section: 'lan', values: { ipaddr: Array.isArray(cfg.ipaddr) ? [cidr] : cidr, netmask: '' } }],
        { timeout: LAN_APPLY_TIMEOUT, newHost: newIp },
      );
      applyBtn.disabled = false;
      if (alive && (result === 'applied' || result === 'rolledback')) load();
      // 지금 주소로도 계속 닿아서(이름으로 접속했거나 개발 환경) 확인이 끝난 경우: 새 주소를 알려 준다
      if (result === 'applied' && location.hostname !== newIp) {
        infoModal('적용 완료', `설정을 적용했습니다. 공유기의 새 주소는 http://${newIp}${location.pathname} 입니다.`);
      }
    });

    body.replaceChildren(
      card('현재 설정', kv([['내부 IP 주소', cur.ip || '-'], ['서브넷 마스크', cur.mask || '-']])),
      h('section', { class: 'card form-card' },
        h('div', { class: 'card-head' }, h('h3', null, '주소 변경')),
        h('div', { class: 'fieldset' }, fIp.el, fMask.el),
        h('div', { class: 'actions' }, applyBtn)),
    );
  }

  load();
  return () => { alive = false; };
}

/* ---------- DHCP 서버 설정 ---------- */

const LEASE_TIMES = [['1h', '1시간'], ['2h', '2시간'], ['6h', '6시간'], ['12h', '12시간'], ['24h', '1일'], ['48h', '2일'], ['7d', '7일']];

function isHostname(s) {
  return /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(s);
}

function dhcpPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('DHCP 서버 설정'), body);
  let alive = true;

  async function load() {
    let lan, sections, leases;
    try {
      [lan, sections, leases] = await Promise.all([
        ubus('uci', 'get', { config: 'network', section: 'lan' }),
        uciSections('dhcp'),
        readLeases(),
      ]);
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (!alive) return;
    const dhcp = sections && sections.find((s) => s['.type'] === 'dhcp' && (s.interface === 'lan' || s['.name'] === 'lan'));
    if (!lan || !lan.values || !dhcp) {
      body.replaceChildren(messageCard('DHCP 설정을 찾을 수 없습니다.'));
      return;
    }
    const hosts = sections.filter((s) => s['.type'] === 'host');
    render(readAddr(lan.values), dhcp, hosts, leases);
  }

  function render(lanAddr, dhcp, hosts, leases) {
    const ignore = dhcp.ignore === '1';
    const onT = toggleEl(!ignore, 'DHCP 서버 사용 (연결한 기기에 주소를 자동으로 줍니다)');
    const start = h('input', { type: 'text', inputmode: 'numeric', value: dhcp.start || '100' });
    const limit = h('input', { type: 'text', inputmode: 'numeric', value: dhcp.limit || '150' });
    const lease = selectEl(LEASE_TIMES, dhcp.leasetime || '12h');
    const fStart = formField('시작 번호', start, '주소 끝자리부터 셉니다. 예: 100');
    const fLimit = formField('할당 개수', limit, '최대로 나눠 줄 주소 수');
    const fLease = formField('임대 시간', lease);
    const rangeText = h('p', { class: 'muted' });
    const syncRange = () => {
      rangeText.textContent = '할당 범위: ' + dhcpRangeText(lanAddr.ip, lanAddr.mask, start.value, limit.value);
    };
    start.addEventListener('input', syncRange);
    limit.addEventListener('input', syncRange);
    syncRange();
    const fields = h('div', null, h('div', { class: 'fieldset' }, fStart.el, fLimit.el, fLease.el), rangeText);
    const syncOn = () => { fields.hidden = !onT.input.checked; };
    onT.input.addEventListener('change', syncOn);
    syncOn();

    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    applyBtn.addEventListener('click', async () => {
      fStart.setError(null);
      fLimit.setError(null);
      const values = { ignore: onT.input.checked ? '' : '1' };
      if (onT.input.checked) {
        const hostBits = 32 - lanAddr.mask.split('.').reduce((a, p) => a + (+p).toString(2).split('1').length - 1, 0);
        const max = 2 ** hostBits - 2;
        const s = +start.value;
        const l = +limit.value;
        let bad = false;
        if (!/^\d+$/.test(start.value) || s < 1 || s > max) { fStart.setError(`1 ~ ${max} 사이로 입력해 주세요.`); bad = true; }
        if (!/^\d+$/.test(limit.value) || l < 1) { fLimit.setError('1 이상으로 입력해 주세요.'); bad = true; }
        else if (!bad && s + l - 1 > max) { fLimit.setError(`시작 번호 + 개수가 대역을 넘습니다 (최대 ${max - s + 1}개).`); bad = true; }
        if (bad) return;
        Object.assign(values, { start: String(s), limit: String(l), leasetime: lease.value });
      }
      const same = (values.ignore === (ignore ? '1' : ''))
        && (!onT.input.checked || (values.start === (dhcp.start || '100') && values.limit === (dhcp.limit || '150')
          && values.leasetime === (dhcp.leasetime || '12h')));
      if (same) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
      applyBtn.disabled = true;
      const r = await runApply([{ op: 'set', config: 'dhcp', section: dhcp['.name'], values }]);
      applyBtn.disabled = false;
      if (alive && (r === 'applied' || r === 'rolledback')) load();
    });

    body.replaceChildren(
      h('section', { class: 'card form-card' },
        h('div', { class: 'card-head' }, h('h3', null, 'DHCP 서버')),
        onT.el, fields,
        h('div', { class: 'actions' }, applyBtn)),
      staticLeaseCard(lanAddr, hosts, leases, () => { if (alive) load(); }),
    );
  }

  load();
  return () => { alive = false; };
}

// 고정 IP 할당 (dhcp host 섹션)
function staticLeaseCard(lanAddr, hosts, leases, reload) {
  const rows = hosts.map((hst) => {
    const del = h('button', { class: 'btn btn-ghost btn-small', type: 'button' }, '삭제');
    del.addEventListener('click', async () => {
      if (!await confirmDialog('고정 IP 할당 삭제', `${hst.name || hst.mac} (${hst.ip || '-'}) 할당을 삭제할까요?`, '삭제', true)) return;
      const r = await runApply([{ op: 'delete', config: 'dhcp', section: hst['.name'] }]);
      if (r === 'applied' || r === 'rolledback') reload();
    });
    return h('tr', null,
      h('td', null, hst.name || '-'), h('td', null, asList(hst.mac).join(', ') || '-'), h('td', null, hst.ip || '-'),
      h('td', { class: 'actions-cell' }, del));
  });

  const pick = h('select', null, h('option', { value: '' }, '접속 중인 기기에서 고르기...'),
    leases.map((l, i) => h('option', { value: String(i) }, `${l.name} (${l.ip}, ${l.mac})`)));
  const name = h('input', { type: 'text', spellcheck: 'false', placeholder: 'living-tv' });
  const mac = h('input', { type: 'text', spellcheck: 'false', placeholder: 'aa:bb:cc:dd:ee:ff' });
  const ip = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', placeholder: '192.168.1.50' });
  pick.addEventListener('change', () => {
    const l = leases[+pick.value];
    if (!l) return;
    mac.value = l.mac;
    ip.value = l.ip;
    name.value = l.name !== '이름 없음' && isHostname(l.name) ? l.name : '';
  });
  const fName = formField('이름 (선택, 영문/숫자/-)', name);
  const fMac = formField('MAC 주소', mac);
  const fIp = formField('할당할 IP 주소', ip);
  const addBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '추가');
  addBtn.addEventListener('click', async () => {
    [fName, fMac, fIp].forEach((f) => f.setError(null));
    const v = { name: name.value.trim(), mac: mac.value.trim().toLowerCase(), ip: ip.value.trim() };
    let bad = false;
    if (v.name && !isHostname(v.name)) { fName.setError('영문, 숫자, - 만 쓸 수 있습니다.'); bad = true; }
    if (!isMac(v.mac)) { fMac.setError('MAC 주소 형식이 올바르지 않습니다.'); bad = true; }
    else if (hosts.some((x) => asList(x.mac).map((m) => m.toLowerCase()).includes(v.mac))) { fMac.setError('이미 등록된 MAC 주소입니다.'); bad = true; }
    if (!isIPv4(v.ip)) { fIp.setError('IP 주소 형식이 올바르지 않습니다.'); bad = true; }
    else if (!sameSubnet(v.ip, lanAddr.ip, lanAddr.mask)) { fIp.setError(`내부 네트워크(${lanAddr.ip}) 대역의 주소여야 합니다.`); bad = true; }
    else if (v.ip === lanAddr.ip) { fIp.setError('공유기 주소는 쓸 수 없습니다.'); bad = true; }
    else if (hosts.some((x) => x.ip === v.ip)) { fIp.setError('이미 다른 기기에 할당된 주소입니다.'); bad = true; }
    if (bad) return;
    if (!v.name) delete v.name;
    addBtn.disabled = true;
    const r = await runApply([{ op: 'add', config: 'dhcp', type: 'host', values: v }]);
    addBtn.disabled = false;
    if (r === 'applied' || r === 'rolledback') reload();
  });

  return h('section', { class: 'card form-card' },
    h('div', { class: 'card-head' }, h('h3', null, '고정 IP 할당')),
    h('p', { class: 'muted' }, '특정 기기가 항상 같은 내부 주소를 받게 합니다. 기기가 다시 접속하면 적용됩니다.'),
    rows.length
      ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, '이름'), h('th', null, 'MAC 주소'), h('th', null, 'IP 주소'), h('th', null, ''))),
        h('tbody', null, rows)))
      : h('p', { class: 'muted' }, '등록된 고정 할당이 없습니다.'),
    h('h3', { style: 'font-size:14px;margin:16px 0 8px' }, '새 할당 추가'),
    leases.length ? h('label', { class: 'field' }, h('span', null, '기기 선택'), pick) : null,
    h('div', { class: 'fieldset' }, fName.el, fMac.el, fIp.el),
    h('div', { class: 'actions' }, addBtn));
}

PAGES['/lan'] = lanPage;
PAGES['/dhcp'] = dhcpPage;
