// 인터페이스 목록 (+ vlan.js와 같이 쓰는 표시 도우미)

const IFACE_LABEL = { lan: '내부 네트워크', wan: '인터넷', wan6: '인터넷 (IPv6)', loopback: '루프백', guest: '게스트 네트워크', vnet: 'VLAN 네트워크' };
const PROTO_NAMES = { ...PROTO_LABEL, dhcpv6: 'DHCPv6', none: '없음', '6in4': '6in4', wireguard: 'WireGuard' };

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function ifaceState(i) {
  const addr = (i['ipv4-address'] || []).length || (i['ipv6-address'] || []).length;
  if (i.up && (addr || i.proto === 'none')) return ['ok', '연결됨'];
  if (i.up || i.pending) return ['warn', '연결 중'];
  return ['off', '꺼짐'];
}

function maskBits(mask) {
  return mask.split('.').reduce((a, p) => a + (+p).toString(2).split('1').length - 1, 0);
}

/* ---------- 인터페이스 목록 ---------- */

function interfacesPage(root) {
  const ifCard = card('인터페이스', h('span', { class: 'muted' }, '불러오는 중...'));
  const devCard = card('장치 (포트)', h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('인터페이스 목록'), ifCard, devCard);
  ifCard.style.maxWidth = 'none';
  devCard.style.maxWidth = 'none';
  let stopped = false;
  let timer = null;

  async function restart(name) {
    const ok = await confirmDialog('다시 연결', `'${IFACE_LABEL[name] || name}' 인터페이스를 끊었다가 다시 연결합니다. 잠시 인터넷이 끊길 수 있습니다.`, '다시 연결');
    if (!ok) return;
    try {
      await ubus(`network.interface.${name}`, 'down');
      await sleep(1000);
      await ubus(`network.interface.${name}`, 'up');
      infoModal('다시 연결', '다시 연결을 요청했습니다. 연결되기까지 몇 초 걸릴 수 있습니다.');
    } catch (e) {
      if (await handleDenied(e) !== 'expired') infoModal('다시 연결', '요청하지 못했습니다.', true);
    }
    refresh();
  }

  function render(dump, devices) {
    const stats = (dev) => ((devices || {})[dev] || {}).statistics || {};
    const ifaces = (dump.interface || []).filter((i) => i.interface !== 'loopback');
    const rows = ifaces.map((i) => {
      const [kind, text] = ifaceState(i);
      const v4 = (i['ipv4-address'] || []).map((a) => `${a.address}/${a.mask}`).join(', ');
      const v6a = (i['ipv6-address'] || []).map((a) => `${a.address}/${a.mask}`);
      const v6p = (i['ipv6-prefix-assignment'] || []).map((a) => a['local-address'] ? `${a['local-address'].address}/${a['local-address'].mask}` : '');
      const v6 = [...v6a, ...v6p].filter(Boolean).join(', ');
      const dev = i.l3_device || i.device || '-';
      const s = stats(dev);
      // 지금 이 화면이 쓰는 내부 네트워크는 끊으면 접속이 끊기므로 버튼을 주지 않는다
      const canRestart = i.interface !== 'lan' && !String(i.device || '').startsWith('br-lan');
      return h('tr', null,
        h('td', null, h('b', null, IFACE_LABEL[i.interface] || i.interface), h('div', { class: 'muted' }, i.interface)),
        h('td', null, PROTO_NAMES[i.proto] || i.proto || '-'),
        h('td', null, h('span', { class: 'pill ' + kind }, text)),
        h('td', null, v4 || '-', v6 ? h('div', { class: 'muted' }, v6) : null),
        h('td', null, dev),
        h('td', null, i.up ? fmtUptime(i.uptime || 0) : '-'),
        h('td', null, `↓ ${fmtBytes(s.rx_bytes)}`, h('div', { class: 'muted' }, `↑ ${fmtBytes(s.tx_bytes)}`)),
        h('td', { class: 'actions-cell' },
          i.dynamic ? null : h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => editInterface(i.interface, devices, refresh) }, '수정'),
          canRestart
            ? h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => restart(i.interface) }, '다시 연결')
            : null));
    });
    ifCard.replaceChildren(
      h('div', { class: 'card-head' }, h('h3', null, '인터페이스')),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ...['이름', '연결 방식', '상태', '주소', '장치', '연결 시간', '데이터', ''].map((x) => h('th', null, x)))),
        h('tbody', null, rows))));

    if (!devices) {
      devCard.replaceChildren(h('div', { class: 'card-head' }, h('h3', null, '장치 (포트)')), h('span', { class: 'muted' }, '장치 정보를 불러오지 못했습니다.'));
      return;
    }
    const names = Object.keys(devices).filter((n) => n !== 'lo').sort();
    const typeText = (d, n) => {
      if (d.type === 'bridge' || d.devtype === 'bridge') return '브리지';
      if (d.type === '8021q' || d.type === '8021ad' || d.devtype === 'vlan' || /\.\d+$/.test(n)) return 'VLAN';
      if (/^switch/.test(n)) return '스위치';
      if (d.devtype === 'wlan' || /^(wlan|phy)/.test(n)) return '무선';
      if (/^pppoe-/.test(n)) return 'PPPoE';
      return '포트';
    };
    devCard.replaceChildren(
      h('div', { class: 'card-head' }, h('h3', null, '장치 (포트)')),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ...['장치', '종류', '링크', '속도', 'MAC 주소', '구성', '데이터', ''].map((x) => h('th', null, x)))),
        h('tbody', null, names.map((n) => {
          const d = devices[n];
          const link = !d.present ? ['off', '없음'] : (d.up && d.carrier ? ['ok', '연결됨'] : (d.up ? ['warn', '케이블 없음'] : ['off', '꺼짐']));
          const s = d.statistics || {};
          return h('tr', null,
            h('td', null, h('b', null, portLabel(n)), portLabel(n) !== n ? h('div', { class: 'muted' }, n) : null),
            h('td', null, typeText(d, n)),
            h('td', null, h('span', { class: 'pill ' + link[0] }, link[1])),
            h('td', null, d.speed ? String(d.speed).replace(/F$/, ' Mbps 전이중').replace(/H$/, ' Mbps 반이중') : '-'),
            h('td', null, d.macaddr || '-'),
            h('td', null, (d['bridge-members'] || []).map(portLabel).join(', ') || (d.parent ? `${portLabel(d.parent)} · VLAN ${d.vid}` : '-')),
            h('td', null, `↓ ${fmtBytes(s.rx_bytes)}`, h('div', { class: 'muted' }, `↑ ${fmtBytes(s.tx_bytes)}`)),
            h('td', { class: 'actions-cell' }, ['포트', '브리지', 'VLAN'].includes(typeText(d, n))
              ? h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => editDevice(n, d, refresh) }, '수정')
              : null));
        })))));
  }

  async function refresh() {
    let dump, devices;
    try {
      await readBoard(); // 포트 이름(portLabel)용
      dump = await ubus('network.interface', 'dump');
      devices = await ubus('network.device', 'status').catch(() => null);
    } catch (e) {
      const text = await loadFailureText(e);
      if (!stopped && text) ifCard.replaceChildren(h('span', { class: 'muted' }, text));
      return;
    }
    if (!stopped) render(dump, devices);
  }

  let first = true;
  async function tick() {
    if (first || !document.hidden) await refresh();
    first = false;
    if (!stopped) timer = setTimeout(tick, POLL_MS);
  }
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}


PAGES['/interfaces'] = interfacesPage;
