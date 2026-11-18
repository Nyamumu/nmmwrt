// 추가 패키지가 필요한 기능: DDNS(ddns-scripts), 속도 관리(sqm-scripts)

// 대상은 OpenWrt 25 이상이므로 패키지 관리자는 apk
async function installCommand(pkg) {
  return `apk update && apk add ${pkg}`;
}

async function missingPackageCard(pkg, what) {
  return card('패키지가 필요합니다',
    h('p', null, `${what} 기능을 쓰려면 공유기에 ${pkg} 패키지를 설치해야 합니다.`),
    h('p', { class: 'muted' }, 'SSH로 공유기에 접속해서 아래 명령을 실행한 뒤 이 화면을 새로고침하세요.'),
    h('code', { class: 'cmd' }, await installCommand(pkg)));
}

/* ---------- DDNS ---------- */

const DDNS_SERVICES = [
  ['duckdns.org', 'DuckDNS', '도메인: 이름만 (예: myhome), 아이디: 비워 둠, 비밀번호: 토큰'],
  ['dynv6.com', 'dynv6', '도메인: 전체 이름, 아이디: 비워 둠, 비밀번호: 토큰'],
  ['no-ip.com', 'No-IP', '도메인: 전체 이름, 아이디/비밀번호: No-IP 계정'],
  ['dyndns.org', 'Dyn', '도메인: 전체 이름, 아이디/비밀번호: Dyn 계정'],
  ['freedns.afraid.org', 'FreeDNS (afraid.org)', '도메인: 전체 이름, 아이디/비밀번호: 계정'],
  ['cloudflare.com-v4', 'Cloudflare (ddns-scripts-cloudflare 필요)', '도메인: 호스트@영역 (예: home@example.com), 아이디: Bearer, 비밀번호: API 토큰'],
];

function ddnsPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('DDNS 설정'), body);
  let alive = true;

  async function load() {
    let exists, sections;
    try {
      exists = await uciConfigExists('ddns');
      sections = exists ? await uciSections('ddns') : null;
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (!alive) return;
    if (!exists) { body.replaceChildren(await missingPackageCard('ddns-scripts', 'DDNS')); return; }
    render((sections || []).filter((s) => s['.type'] === 'service'));
  }

  function render(services) {
    // 우리가 만든 'nmmwrt' 섹션을 우선, 없으면 첫 번째 서비스를 고친다
    const svc = services.find((s) => s['.name'] === 'nmmwrt') || services[0] || null;
    const cur = svc || {};
    const on = toggleEl(svc ? svc.enabled === '1' : true, 'DDNS 사용');
    const service = selectEl(DDNS_SERVICES.map(([v, l]) => [v, l]), cur.service_name || 'duckdns.org');
    const domain = h('input', { type: 'text', value: cur.domain || '', spellcheck: 'false' });
    const user = h('input', { type: 'text', value: cur.username && cur.username !== 'NA' ? cur.username : '', spellcheck: 'false' });
    const pass = h('input', { type: 'password', value: cur.password || '', autocomplete: 'new-password', spellcheck: 'false' });
    const hint = h('p', { class: 'muted' });
    const syncHint = () => {
      const s = DDNS_SERVICES.find(([v]) => v === service.value);
      hint.textContent = s ? '입력 방법: ' + s[2] : '';
    };
    service.addEventListener('change', syncHint);
    syncHint();
    const f = {
      service: formField('서비스', service),
      domain: formField('도메인', domain),
      user: formField('아이디 (서비스에 따라 비워 둠)', user),
      pass: formField('비밀번호 / 토큰', pass),
    };
    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    applyBtn.addEventListener('click', async () => {
      Object.values(f).forEach((x) => x.setError(null));
      let bad = false;
      if (on.input.checked) {
        if (!/^[A-Za-z0-9@._-]+$/.test(domain.value.trim())) { f.domain.setError('도메인을 입력해 주세요.'); bad = true; }
        if (!pass.value) { f.pass.setError('비밀번호나 토큰을 입력해 주세요.'); bad = true; }
      }
      if (bad) return;
      const d = domain.value.trim();
      const values = {
        enabled: on.input.checked ? '1' : '0',
        service_name: service.value,
        domain: d,
        lookup_host: d.includes('@') ? d.split('@').join('.') : (service.value === 'duckdns.org' && !d.includes('.') ? d + '.duckdns.org' : d),
        username: user.value.trim() || 'NA',
        password: pass.value,
        interface: 'wan',
        ip_source: 'network',
        ip_network: 'wan',
        use_ipv6: '0',
      };
      const ops = svc
        ? [{ op: 'set', config: 'ddns', section: svc['.name'], values }]
        : [{ op: 'add', config: 'ddns', type: 'service', name: 'nmmwrt', values }];
      applyBtn.disabled = true;
      const r = await runApply(ops);
      applyBtn.disabled = false;
      if (alive && (r === 'applied' || r === 'rolledback')) load();
    });
    body.replaceChildren(
      h('section', { class: 'card form-card' },
        h('div', { class: 'card-head' }, h('h3', null, 'DDNS'),
          svc ? h('span', { class: 'pill ' + (svc.enabled === '1' ? 'ok' : 'off') }, svc.enabled === '1' ? '사용 중' : '꺼짐') : null),
        h('p', { class: 'muted' }, '바뀌는 외부 IP 주소를 고정된 도메인 이름으로 접속할 수 있게 합니다. 갱신 결과는 시스템 로그에서 볼 수 있습니다.'),
        on.el,
        h('div', { class: 'fieldset' }, f.service.el, f.domain.el, f.user.el, f.pass.el),
        hint,
        services.length > 1 ? h('p', { class: 'msg warn-msg' }, `DDNS 서비스가 ${services.length}개 설정되어 있습니다. 이 화면은 '${svc['.name']}' 하나만 고칩니다.`) : null,
        h('div', { class: 'actions' }, applyBtn)),
    );
  }

  load();
  return () => { alive = false; };
}

/* ---------- 속도 관리 (SQM) ---------- */

function trafficPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('속도 관리 (SQM)'), body);
  let alive = true;

  async function load() {
    let exists, sections, wan;
    try {
      exists = await uciConfigExists('sqm');
      [sections, wan] = await Promise.all([
        exists ? uciSections('sqm') : null,
        ubus('uci', 'get', { config: 'network', section: 'wan' }),
      ]);
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (!alive) return;
    if (!exists) { body.replaceChildren(await missingPackageCard('sqm-scripts', '속도 관리(SQM)')); return; }
    const wanDev = (wan && wan.values && wan.values.device) || 'wan';
    render((sections || []).find((s) => s['.type'] === 'queue') || null, wanDev);
  }

  function render(q, wanDev) {
    const cur = q || {};
    const on = toggleEl(q ? q.enabled === '1' : false, '속도 관리 사용');
    const toMbps = (kbit) => (kbit && +kbit > 0 ? String(Math.round(+kbit / 100) / 10) : '');
    const down = h('input', { type: 'text', inputmode: 'decimal', value: toMbps(cur.download) });
    const up = h('input', { type: 'text', inputmode: 'decimal', value: toMbps(cur.upload) });
    const fDown = formField('다운로드 속도 (Mbps)', down, '측정한 속도의 85~95%');
    const fUp = formField('업로드 속도 (Mbps)', up, '측정한 속도의 85~95%');
    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    applyBtn.addEventListener('click', async () => {
      fDown.setError(null);
      fUp.setError(null);
      const ok = (s) => /^\d+(\.\d+)?$/.test(s.trim()) && +s > 0;
      let bad = false;
      if (on.input.checked) {
        if (!ok(down.value)) { fDown.setError('0보다 큰 숫자를 입력해 주세요.'); bad = true; }
        if (!ok(up.value)) { fUp.setError('0보다 큰 숫자를 입력해 주세요.'); bad = true; }
      }
      if (bad) return;
      const values = {
        enabled: on.input.checked ? '1' : '0',
        interface: cur.interface || wanDev,
        qdisc: cur.qdisc || 'cake',
        script: cur.script || 'piece_of_cake.qos',
      };
      if (on.input.checked) {
        values.download = String(Math.round(+down.value * 1000));
        values.upload = String(Math.round(+up.value * 1000));
      }
      const ops = q
        ? [{ op: 'set', config: 'sqm', section: q['.name'], values }]
        : [{ op: 'add', config: 'sqm', type: 'queue', name: 'nmmwrt', values }];
      applyBtn.disabled = true;
      const r = await runApply(ops);
      applyBtn.disabled = false;
      if (alive && (r === 'applied' || r === 'rolledback')) load();
    });
    body.replaceChildren(
      h('section', { class: 'card form-card' },
        h('div', { class: 'card-head' }, h('h3', null, '속도 관리'),
          q ? h('span', { class: 'pill ' + (q.enabled === '1' ? 'ok' : 'off') }, q.enabled === '1' ? '사용 중' : '꺼짐') : null),
        h('p', { class: 'muted' }, '여러 기기가 동시에 쓸 때 게임, 화상 통화가 끊기거나 느려지는 현상(버퍼블로트)을 줄입니다. 인터넷 속도를 측정해서 그보다 조금 낮게 입력하세요.'),
        on.el,
        h('div', { class: 'fieldset' }, fDown.el, fUp.el),
        h('p', { class: 'muted' }, `적용 장치: ${cur.interface || wanDev} · 방식: ${cur.qdisc || 'cake'}`),
        h('div', { class: 'actions' }, applyBtn)),
    );
  }

  load();
  return () => { alive = false; };
}

PAGES['/ddns'] = ddnsPage;
PAGES['/traffic'] = trafficPage;
