// 국가 차단 (보안 기능): banIP 패키지로 고른 나라의 IP 주소 대역을 차단한다.
//   banip 설정의 ban_feed에 'country'를 넣고 ban_country에 나라 코드를 적는다. 방향은 ban_feedin/out/inout으로 정한다.
//   banIP는 설정이 바뀌어도 스스로 다시 읽지 않으므로 적용 뒤에 서비스를 다시 시작한다.
//   banIP를 다른 목록(feed)과 함께 쓰는 공유기는 그 설정을 건드리지 않는다.

const GEO_INIT = '/etc/init.d/banip';
const GEO_COUNTRIES = '/etc/banip/banip.countries';
const GEO_STATUS = '/var/run/banIP/banIP.runtime.json';
const GEO_FEED = 'country';
const GEO_EXEC_TIMEOUT_MS = 60000;
const GEO_DIRS = [
  ['in', '들어오는 연결만 차단 (권장)'],
  ['inout', '들어오고 나가는 연결 모두 차단'],
  ['out', '나가는 연결만 차단'],
];
const GEO_STATE = {
  active: ['ok', '동작 중'], processing: ['warn', '목록 받는 중'], running: ['warn', '목록 받는 중'],
  stopped: ['off', '꺼짐'], error: ['bad', '오류'],
};

// banip.countries 한 줄: '코드<탭>지역<탭>영어 이름' -> 한국어 이름순 목록
function geoParseCountries(text) {
  let names = null;
  try { names = new Intl.DisplayNames(['ko'], { type: 'region' }); } catch { /* 영어 이름을 쓴다 */ }
  const out = String(text || '').split('\n').map((line) => {
    const [code, , en] = line.split('\t');
    if (!/^[a-z]{2}$/.test(code || '')) return null;
    let ko = '';
    try { ko = names ? names.of(code.toUpperCase()) : ''; } catch { ko = ''; }
    return { code, en: (en || '').trim(), name: ko && ko !== code.toUpperCase() ? ko : (en || code).trim() };
  }).filter(Boolean);
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

// 검색해서 고르는 나라 목록. 고른 나라는 위에 이름표로 보인다.
function geoCountryPicker(countries, selected) {
  const chosen = new Set(selected);
  const chips = h('div', { class: 'geo-chips' });
  const search = h('input', { type: 'search', placeholder: '나라 이름 또는 코드로 찾기', spellcheck: 'false' });
  const err = h('small', { class: 'err', hidden: true });
  const nameOf = (c) => (countries.find((x) => x.code === c) || { name: c.toUpperCase() }).name;
  const rows = countries.map((c) => {
    const box = h('input', { type: 'checkbox' });
    box.checked = chosen.has(c.code);
    box.addEventListener('change', () => { if (box.checked) chosen.add(c.code); else chosen.delete(c.code); draw(); });
    return { c, box, el: h('label', null, box, h('span', null, c.name), h('span', { class: 'muted' }, c.code.toUpperCase())) };
  });
  function draw() {
    chips.replaceChildren(...(chosen.size ? [...chosen].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'ko')).map((code) => h('button', {
      class: 'ms-chip geo-chip', type: 'button', title: '선택 해제',
      onclick: () => {
        chosen.delete(code);
        const row = rows.find((r) => r.c.code === code);
        if (row) row.box.checked = false;
        draw();
      },
    }, `${nameOf(code)} ×`)) : [h('span', { class: 'ms-empty' }, '고른 나라가 없습니다')]));
  }
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    rows.forEach((r) => { r.el.hidden = !!q && ![r.c.name, r.c.en, r.c.code].some((t) => t.toLowerCase().includes(q)); });
  });
  draw();
  return {
    el: h('div', { class: 'field' }, h('span', null, '차단할 나라'), chips, search,
      h('div', { class: 'ms-panel geo-list' }, rows.map((r) => r.el)), err),
    values: () => [...chosen].sort(),
    setError(msg) { err.textContent = msg || ''; err.hidden = !msg; },
  };
}

function geoblockPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('국가 차단'), body);
  let stopped = false;
  let timer = null;
  const statusBox = h('div');

  const initExec = (action) => ubus('file', 'exec', { command: GEO_INIT, params: [action] }, state.sid, GEO_EXEC_TIMEOUT_MS);

  async function readStatus() {
    try {
      return JSON.parse((await ubus('file', 'read', { path: GEO_STATUS })).data || 'null');
    } catch {
      return null; // 아직 한 번도 실행하지 않았으면 파일이 없다
    }
  }

  function drawStatus(st, wanted) {
    const key = st && st.status ? String(st.status).toLowerCase().split(' ')[0] : 'stopped';
    const [cls, text] = GEO_STATE[key] || ['warn', key];
    const count = st && /^[\d ]+/.test(st.element_count || '') ? st.element_count.match(/^[\d ]+/)[0].trim() : '';
    const sets = st && Array.isArray(st.active_feeds) ? st.active_feeds.filter((f) => f.startsWith(`${GEO_FEED}.`)) : [];
    const last = st && st.last_run && st.last_run !== '-' ? (/date \/ time: ([^,]+)/.exec(st.last_run) || [])[1] : '';
    const families = [...new Set(sets.map((f) => (f.endsWith('6') ? 'IPv6' : 'IPv4')))].sort();
    const notice = key === 'error' ? '차단을 시작하지 못했습니다. 공유기의 인터넷 연결을 확인한 뒤 다시 적용해 주세요. 자세한 내용은 시스템 로그에서 볼 수 있습니다.'
      : wanted && key === 'active' && !sets.length ? '나라별 주소 목록을 받지 못했습니다. 공유기의 인터넷 연결을 확인한 뒤 다시 적용해 주세요.' : '';
    statusBox.replaceChildren(...[
      h('div', { class: 'card-head' }, h('h3', null, '차단 상태'), h('span', { class: 'pill ' + cls }, text)),
      kv([
        ['등록된 주소 대역', key === 'active' && count ? `${count}개` : '-'],
        ['적용된 주소 종류', key === 'active' && families.length ? families.join(', ') : '-'],
        ['마지막 갱신', last || '-'],
      ]),
      notice ? h('p', { class: 'msg warn-msg' }, notice) : null,
    ].filter(Boolean));
  }

  async function load() {
    let exists, sections, text;
    try {
      exists = await uciConfigExists('banip');
      if (exists) {
        sections = await uciSections('banip');
        text = (await ubus('file', 'read', { path: GEO_COUNTRIES })).data;
      }
    } catch (e) {
      const msg = await loadFailureText(e);
      if (!stopped && msg) body.replaceChildren(messageCard(msg));
      return;
    }
    if (stopped) return;
    if (!exists) { body.replaceChildren(missingPackageCard('banip', '국가 차단', load)); return; }
    render((sections || []).find((s) => s['.name'] === 'global') || null, geoParseCountries(text));
    poll();
  }

  let wanted = false;
  async function poll() {
    clearTimeout(timer);
    if (!document.hidden) {
      const st = await readStatus();
      if (stopped) return;
      drawStatus(st, wanted);
    }
    if (!stopped) timer = setTimeout(poll, POLL_MS);
  }

  function render(cfg, countries) {
    if (!cfg) { body.replaceChildren(messageCard('banIP 설정(global)을 찾을 수 없습니다.')); return; }
    const feeds = asList(cfg.ban_feed);
    const others = feeds.filter((f) => f !== GEO_FEED);
    const wasOn = cfg.ban_enabled === '1' && feeds.includes(GEO_FEED);
    wanted = wasOn;
    const curDir = asList(cfg.ban_feedinout).includes(GEO_FEED) ? 'inout' : asList(cfg.ban_feedout).includes(GEO_FEED) ? 'out' : 'in';
    const on = toggleEl(wasOn, '국가 차단 사용');
    const picker = geoCountryPicker(countries, asList(cfg.ban_country));
    const dir = selectEl(GEO_DIRS, curDir);
    const fDir = formField('차단 방향', dir, '들어오는 연결은 외부에서 공유기와 내부 기기로 들어오는 접속입니다');
    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');

    applyBtn.addEventListener('click', async () => {
      picker.setError(null);
      const want = on.input.checked;
      const codes = picker.values();
      if (want && !codes.length) { picker.setError('차단할 나라를 하나 이상 골라 주세요'); return; }
      if (want && dir.value !== 'in' && !await confirmDialog('나가는 연결 차단', [
        '고른 나라에 있는 웹사이트와 서비스에 내부 기기가 접속할 수 없게 됩니다.',
        h('p', { class: 'msg warn-msg' }, '해외 서버를 쓰는 앱이나 게임이 동작하지 않을 수 있습니다.'),
      ], '적용')) return;

      const dirList = (key, name) => {
        const rest = asList(cfg[key]).filter((f) => f !== GEO_FEED);
        return want && dir.value === name ? [...rest, GEO_FEED] : rest;
      };
      const feedList = want ? [...others, GEO_FEED] : others;
      const values = {
        ban_feed: feedList,
        ban_country: codes,
        ban_feedout: dirList('ban_feedout', 'out'),
        ban_feedinout: dirList('ban_feedinout', 'inout'),
        ban_enabled: want || (others.length && cfg.ban_enabled === '1') ? '1' : '0',
      };
      const changed = {};
      for (const [k, v] of Object.entries(values)) {
        const nv = Array.isArray(v) ? v.join(' ') : v;
        if (nv !== asList(cfg[k]).join(' ')) changed[k] = Array.isArray(v) && !v.length ? '' : v;
      }
      if (!Object.keys(changed).length && want === wasOn && !want) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }

      applyBtn.disabled = true;
      if (Object.keys(changed).length) {
        const r = await runApply([{ op: 'set', config: 'banip', section: 'global', values: changed }]);
        if (r !== 'applied') { applyBtn.disabled = false; if (r === 'rolledback') load(); return; }
      }
      try {
        const keepRunning = values.ban_enabled === '1';
        if (keepRunning) await initExec('enable');
        const res = await initExec(keepRunning ? 'restart' : 'stop');
        if (res.code !== 0) throw new Error(res.stderr || String(res.code));
        infoModal('국가 차단', keepRunning
          ? '적용을 시작했습니다. 나라별 주소 목록을 내려받는 동안 1~2분 걸릴 수 있습니다.'
          : '국가 차단을 껐습니다.');
      } catch (e) {
        if (await handleDenied(e) !== 'expired') infoModal('국가 차단', '서비스를 다시 시작하지 못했습니다. 목록을 받는 중이면 1~2분 뒤에 다시 적용해 주세요.', true);
      }
      applyBtn.disabled = false;
      if (!stopped) load();
    });

    body.replaceChildren(
      h('section', { class: 'card form-card' }, statusBox),
      h('section', { class: 'card form-card' },
        h('div', { class: 'card-head' }, h('h3', null, '국가 차단 설정')),
        h('p', { class: 'muted' }, '고른 나라에 할당된 IP 주소 대역의 접속을 차단합니다. 주소 목록은 인터넷에서 받아 오며, VPN 등을 쓰면 차단되지 않을 수 있습니다.'),
        on.el, picker.el, fDir.el,
        h('p', { class: 'muted' }, '고른 나라가 많을수록 공유기 메모리를 더 많이 씁니다.'),
        others.length ? h('p', { class: 'muted' }, `banIP의 다른 차단 목록(${others.join(', ')})은 그대로 유지됩니다.`) : null,
        h('div', { class: 'actions' }, applyBtn)));
  }

  load();
  return () => { stopped = true; clearTimeout(timer); };
}

PAGES['/geoblock'] = geoblockPage;
