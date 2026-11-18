// LED 설정 (시스템 관리 > 기본 설정 안의 카드)
//   LED 목록: /sys/class/leds (file list), 쓸 수 있는 동작: /sys/class/leds/<이름>/trigger ('none timer [default-on] ...', 괄호가 지금 동작)
//   설정: system의 led 섹션 (name, sysfs, trigger, default, dev, mode, delayon, delayoff). 섹션이 없으면 OpenWrt 기본 동작.
//   적용 후 /etc/init.d/led restart (uci apply만으로는 LED가 바로 바뀌지 않는다)

const LED_DIR = '/sys/class/leds';
const LED_CHOICES = [
  ['', 'OpenWrt 기본 동작'],
  ['off', '항상 끄기'],
  ['on', '항상 켜기'],
  ['heartbeat', '심장 박동처럼 깜빡임'],
  ['timer', '일정하게 깜빡임'],
  ['netdev', '네트워크 활동 표시'],
];

// LED 이름을 알아보기 쉽게: 'white:system' -> '시스템 (흰색)', 'mt76-phy0' -> '무선 (phy0)'
function ledLabel(name) {
  const colors = { white: '흰색', blue: '파란색', green: '초록색', red: '빨간색', amber: '주황색', orange: '주황색', yellow: '노란색' };
  const funcs = { system: '시스템', power: '전원', run: '동작', status: '상태', wan: '인터넷', lan: '내부 네트워크', wlan: '무선', internet: '인터넷', usb: 'USB' };
  const phy = /(phy\d+)/.exec(name);
  if (/^mt76|^ath|^rt2|wlan|wifi/.test(name) && phy) return `무선 (${phy[1]})`;
  const [color, func] = name.includes(':') ? name.split(':') : ['', name];
  const f = Object.keys(funcs).find((k) => (func || '').toLowerCase().includes(k));
  const c = colors[(color || '').toLowerCase()];
  return `${f ? funcs[f] : func || name}${c ? ` (${c})` : ''}`;
}

// 'none timer [default-on] netdev' -> { current: 'default-on', all: [...] }
function parseTriggers(text) {
  const all = String(text || '').trim().split(/\s+/).filter(Boolean);
  const cur = all.find((t) => /^\[.*\]$/.test(t));
  return { current: cur ? cur.slice(1, -1) : '', all: all.map((t) => t.replace(/^\[|\]$/g, '')) };
}

// 지금 설정(led 섹션) -> 화면의 선택값
function ledChoiceOf(sec) {
  if (!sec) return '';
  const t = sec.trigger || 'none';
  if (t === 'none') return sec.default === '1' ? 'on' : 'off';
  if (t === 'default-on') return 'on';
  return t;
}

function ledCard(sections, devices, reload) {
  const box = h('section', { class: 'card form-card' },
    h('div', { class: 'card-head' }, h('h3', null, 'LED 설정')), h('span', { class: 'muted' }, '불러오는 중...'));
  (async () => {
    let names;
    try {
      names = ((await ubus('file', 'list', { path: LED_DIR })).entries || []).map((e) => e.name).sort();
    } catch {
      names = [];
    }
    if (!names.length) {
      box.replaceChildren(box.firstChild, h('p', { class: 'muted' }, '이 공유기에서 설정할 수 있는 LED를 찾지 못했습니다.'));
      return;
    }
    const triggers = await Promise.all(names.map((n) => ubus('file', 'read', { path: `${LED_DIR}/${n}/trigger` })
      .then((d) => parseTriggers(d.data)).catch(() => ({ current: '', all: [] }))));
    const secs = sections.filter((s) => s['.type'] === 'led');
    const rows = names.map((n, i) => {
      const sec = secs.find((s) => s.sysfs === n) || null;
      const trig = triggers[i];
      const cur = ledChoiceOf(sec);
      // 드라이버가 따로 주는 동작(예: phy0tpt 무선 활동)도 고를 수 있게 한다
      const extra = trig.all.filter((t) => !['none', 'default-on', 'timer', 'heartbeat', 'netdev'].includes(t))
        .filter((t) => /phy|tpt|radio|usb|mmc|disk/.test(t)).map((t) => [t, `드라이버: ${t}`]);
      const choices = LED_CHOICES.filter(([k]) => !['heartbeat', 'timer', 'netdev'].includes(k) || !trig.all.length || trig.all.includes(k));
      const sel = selectEl([...choices, ...extra], cur);
      sel.classList.add('cell-select');
      const dev = selectEl([['', '장치 고르기'], ...devices.map((d) => [d, portLabel(d) !== d ? `${portLabel(d)} (${d})` : d])], (sec && sec.dev) || '');
      dev.classList.add('cell-select');
      const modes = asList(sec && sec.mode).length ? asList(sec.mode) : ['link', 'tx', 'rx'];
      const modeSel = selectEl([['link tx rx', '연결 + 주고받기'], ['link', '연결만'], ['tx rx', '주고받기만']], modes.join(' '));
      modeSel.classList.add('cell-select');
      const netBox = h('div', { class: 'led-net' }, dev, modeSel);
      const sync = () => { netBox.hidden = sel.value !== 'netdev'; };
      sel.addEventListener('change', sync);
      sync();
      const now = trig.current ? `지금: ${trig.current === 'none' ? '꺼짐/고정' : trig.current}` : '';
      return { n, sec, sel, dev, modeSel,
        el: h('tr', null, h('td', null, h('b', null, ledLabel(n)), h('div', { class: 'muted' }, n)),
          h('td', null, sel, netBox), h('td', { class: 'muted' }, now)) };
    });
    const err = h('p', { class: 'msg', hidden: true });
    const btn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    const allOff = h('button', { class: 'btn btn-ghost btn-inline', type: 'button', onclick: () => { rows.forEach((r) => { r.sel.value = 'off'; r.sel.dispatchEvent(new Event('change')); }); } }, '모두 끄기로 고르기');
    btn.addEventListener('click', async () => {
      err.hidden = true;
      const ops = [];
      for (const r of rows) {
        const want = r.sel.value;
        if (want === 'netdev' && !r.dev.value) { err.textContent = `${ledLabel(r.n)}: 네트워크 활동 표시에 쓸 장치를 고르세요.`; err.hidden = false; return; }
        if (want === ledChoiceOf(r.sec) && (want !== 'netdev' || (r.sec.dev === r.dev.value && asList(r.sec.mode).join(' ') === r.modeSel.value))) continue;
        if (!want) { if (r.sec) ops.push({ op: 'delete', config: 'system', section: r.sec['.name'] }); continue; }
        const v = { name: ledLabel(r.n), sysfs: r.n, trigger: want, default: '', dev: '', mode: '', delayon: '', delayoff: '' };
        if (want === 'off') { v.trigger = 'none'; v.default = '0'; }
        if (want === 'on') { v.trigger = 'default-on'; v.default = '1'; }
        if (want === 'timer') { v.delayon = '500'; v.delayoff = '500'; }
        if (want === 'netdev') { v.dev = r.dev.value; v.mode = r.modeSel.value.split(' '); }
        if (r.sec) ops.push({ op: 'set', config: 'system', section: r.sec['.name'], values: v });
        else ops.push({ op: 'add', config: 'system', type: 'led', name: `led_${r.n.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 40), values: dropEmpty(v) });
      }
      if (!ops.length) { infoModal('LED 설정', '바뀐 내용이 없습니다.'); return; }
      btn.disabled = true;
      const res = await runApply(ops);
      btn.disabled = false;
      if (res === 'applied') {
        // uci apply만으로는 LED 상태가 바로 바뀌지 않아 LED 서비스를 다시 시작한다
        await ubus('file', 'exec', { command: '/etc/init.d/led', params: ['restart'] }).catch(() => null);
      }
      if (res === 'applied' || res === 'rolledback') reload();
    });
    box.replaceChildren(box.firstChild,
      h('p', { class: 'muted' }, '공유기 앞면 불빛을 끄거나 동작을 바꿉니다. "OpenWrt 기본 동작"은 따로 정하지 않고 펌웨어 기본값을 따릅니다.'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'LED'), h('th', null, '동작'), h('th', null, ''))),
        h('tbody', null, rows.map((r) => r.el)))),
      err, h('div', { class: 'actions' }, allOff, btn));
  })();
  return box;
}
