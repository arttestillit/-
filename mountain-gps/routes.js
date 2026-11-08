'use strict';
/*
 * ルート（登る予定の道）とチェックポイント
 *  - 作成・編集（地図をタップして線を引く／ポイントを置く）
 *  - 選んだ1本を地図に太線で常時表示
 *  - GPX 読み込み・書き出し
 * app.js の map / store / $ / toast などを利用する
 */

const CP_TYPES = {
  summit:   { label: '山頂',     mark: '頂', color: '#8d3b1f' },
  rest:     { label: '休憩スポット', mark: '休', color: '#2e7d32' },
  junction: { label: '分岐点',   mark: '分', color: '#ef6c00' },
  view:     { label: '絶景スポット', mark: '景', color: '#6a1b9a' },
};
const ROUTE_COLOR = '#1565c0';

// routes: [{ id, name, created, points: [{lat, lon}], cps: [{id, type, name, lat, lon}] }]
let routes = store.get('mgps.routes', []);
let activeRouteId = store.get('mgps.activeRoute', null);
const saveRoutes = () => store.set('mgps.routes', routes);
const setActiveRoute = (id) => { activeRouteId = id; store.set('mgps.activeRoute', id); drawActiveRoute(); };

function routeDistance(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]);
  return d;
}

function cpIcon(type) {
  const t = CP_TYPES[type] || CP_TYPES.view;
  return L.divIcon({
    className: '', html: `<div class="cp-icon" style="--c:${t.color}"><span>${t.mark}</span></div>`,
    iconSize: [28, 28], iconAnchor: [14, 32], popupAnchor: [0, -30], tooltipAnchor: [12, -18],
  });
}
function cpMarker(cp, opts = {}) {
  const t = CP_TYPES[cp.type] || CP_TYPES.view;
  const m = L.marker([cp.lat, cp.lon], { icon: cpIcon(cp.type), zIndexOffset: 800, ...opts });
  if (cp.name) {
    m.bindTooltip(escapeHtml(cp.name), { permanent: true, direction: 'right', className: 'cp-label' });
    m.on('add', () => { const el = m.getTooltip() && m.getTooltip().getElement(); if (el) el.style.setProperty('--c', t.color); });
  }
  return m;
}

/* ---------- 表示中のルート ---------- */
const routeLayer = L.layerGroup().addTo(map);

function drawRouteInto(group, r) {
  const lls = r.points.map((p) => [p.lat, p.lon]);
  if (lls.length > 1) {
    // 白い縁取り＋太い青線で、軌跡（赤・紫）と見分けやすくする
    L.polyline(lls, { pane: 'routePane', color: '#fff', weight: 12, opacity: 0.9, interactive: false }).addTo(group);
    L.polyline(lls, { pane: 'routePane', color: ROUTE_COLOR, weight: 7, opacity: 0.75, interactive: false }).addTo(group);
  }
  if (lls.length) {
    L.circleMarker(lls[0], { pane: 'routePane', radius: 6, color: '#fff', weight: 2, fillColor: '#2e7d32', fillOpacity: 1 })
      .bindPopup(`<b>${escapeHtml(r.name)}</b><br>スタート`).addTo(group);
    if (lls.length > 1) L.circleMarker(lls[lls.length - 1], { pane: 'routePane', radius: 6, color: '#fff', weight: 2, fillColor: '#c62828', fillOpacity: 1 })
      .bindPopup(`<b>${escapeHtml(r.name)}</b><br>ゴール`).addTo(group);
  }
}
function drawActiveRoute() {
  routeLayer.clearLayers();
  const r = routes.find((x) => x.id === activeRouteId);
  if (!r || editing) return;
  drawRouteInto(routeLayer, r);
  for (const cp of r.cps) {
    const t = CP_TYPES[cp.type] || CP_TYPES.view;
    cpMarker(cp).bindPopup(`<b>${escapeHtml(cp.name || t.label)}</b><br>${t.label}` +
      (latestFix ? `<br>現在地から直線 ${fmtDist(haversine(latestFix, cp))}` : '')).addTo(routeLayer);
  }
}

function fitRoute(r) {
  const lls = [...r.points, ...r.cps].map((p) => [p.lat, p.lon]);
  if (!lls.length) return;
  setFollow(false);
  if (lls.length === 1) map.setView(lls[0], 15);
  else map.fitBounds(L.latLngBounds(lls).pad(0.15), { maxZoom: 16 });
}

/* ---------- 一覧 ---------- */
function renderRoutes() {
  const ul = $('routeList');
  ul.innerHTML = '';
  if (!routes.length) { ul.innerHTML = '<li class="empty">まだルートはありません</li>'; return; }
  for (const r of [...routes].reverse()) {
    const on = r.id === activeRouteId;
    const counts = Object.keys(CP_TYPES).map((k) => [k, r.cps.filter((c) => c.type === k).length]).filter(([, n]) => n);
    const li = document.createElement('li');
    li.innerHTML = `<div class="title">${on ? '👁 ' : ''}${escapeHtml(r.name)}</div>
      <div class="meta">${fmtDist(routeDistance(r.points))} ・ チェックポイント ${r.cps.length}</div>
      <div class="route-meta-cps">${counts.map(([k, n]) => `<span style="--c:${CP_TYPES[k].color}">${CP_TYPES[k].label} ${n}</span>`).join('')}</div>
      <div class="actions">
        <button data-act="toggle">${on ? '非表示' : '地図に表示'}</button>
        <button data-act="edit">編集</button><button data-act="gpx">GPX保存</button>
        <button data-act="rename">名前変更</button><button data-act="del">削除</button>
      </div>`;
    const act = (name, fn) => { li.querySelector(`[data-act=${name}]`).onclick = fn; };
    act('toggle', () => {
      if (on) setActiveRoute(null);
      else { setActiveRoute(r.id); closePanels(); fitRoute(r); }
      renderRoutes();
    });
    act('edit', () => startEdit(r));
    act('gpx', () => downloadFile(r.name.replace(/[\\/:*?"<>|\s]+/g, '_') + '.gpx', routeToGpx(r), 'application/gpx+xml'));
    act('rename', () => {
      const n = prompt('ルートの名前', r.name);
      if (n && n.trim()) { r.name = n.trim(); saveRoutes(); renderRoutes(); drawActiveRoute(); }
    });
    act('del', () => {
      if (!confirm(`ルート「${r.name}」を削除しますか？`)) return;
      routes = routes.filter((x) => x.id !== r.id); saveRoutes();
      if (on) setActiveRoute(null);
      renderRoutes();
    });
    ul.appendChild(li);
  }
}

/* ---------- GPX ---------- */
function routeToGpx(r) {
  const wpts = r.cps.map((c) =>
    `  <wpt lat="${c.lat.toFixed(7)}" lon="${c.lon.toFixed(7)}"><name>${escapeHtml(c.name || CP_TYPES[c.type].label)}</name>` +
    `<desc>${CP_TYPES[c.type].label}</desc><type>${c.type}</type></wpt>`).join('\n');
  const pts = r.points.map((p) => `    <rtept lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"></rtept>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Offline Mountain GPS" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escapeHtml(r.name)}</name></metadata>
${wpts}
  <rte>
    <name>${escapeHtml(r.name)}</name>
${pts}
  </rte>
</gpx>
`;
}
function guessCpType(wpt) {
  const type = (wpt.getElementsByTagName('type')[0] || {}).textContent;
  if (type && CP_TYPES[type]) return type;
  const text = [...wpt.children].map((n) => n.textContent).join(' ');
  if (/山頂|岳|峰|頂上|summit|peak/i.test(text)) return 'summit';
  if (/休憩|小屋|避難|水場|トイレ|rest|hut/i.test(text)) return 'rest';
  if (/分岐|出合|junction/i.test(text)) return 'junction';
  return 'view';
}
$('routeImport').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
    let nodes = [...doc.getElementsByTagName('rtept')];
    if (!nodes.length) nodes = [...doc.getElementsByTagName('trkpt')];
    const points = nodes.map((n) => ({ lat: parseFloat(n.getAttribute('lat')), lon: parseFloat(n.getAttribute('lon')) }))
      .filter((p) => isFinite(p.lat) && isFinite(p.lon));
    const cps = [...doc.getElementsByTagName('wpt')].map((w, i) => ({
      id: Date.now() + i, type: guessCpType(w),
      name: ((w.getElementsByTagName('name')[0] || {}).textContent || '').trim(),
      lat: parseFloat(w.getAttribute('lat')), lon: parseFloat(w.getAttribute('lon')),
    })).filter((c) => isFinite(c.lat) && isFinite(c.lon));
    if (!points.length && !cps.length) throw new Error('ルートが見つかりません');
    const nameEl = doc.getElementsByTagName('name')[0];
    const r = { id: Date.now(), name: (nameEl && nameEl.textContent.trim()) || file.name.replace(/\.gpx$/i, ''),
      created: Date.now(), points, cps };
    routes.push(r); saveRoutes(); setActiveRoute(r.id); renderRoutes(); closePanels(); fitRoute(r);
    toast(`ルートを読み込みました（${points.length}点・チェックポイント${cps.length}）`);
  } catch (err) { toast('GPXの読み込みに失敗: ' + err.message, 5000); }
  e.target.value = '';
});

/* ---------- 作成・編集 ---------- */
let editing = null;     // { routeId|null, draft: {name, points, cps}, mode, history: [] }
const editLayer = L.layerGroup();

function snapshot() { return JSON.stringify({ points: editing.draft.points, cps: editing.draft.cps }); }
function pushHistory() { editing.history.push(snapshot()); if (editing.history.length > 200) editing.history.shift(); }

function startEdit(r) {
  if (recId && !confirm('記録は続けたままルートを編集します。よろしいですか？')) return;
  editing = {
    routeId: r ? r.id : null,
    draft: r ? JSON.parse(JSON.stringify({ name: r.name, points: r.points, cps: r.cps })) : { name: '', points: [], cps: [] },
    mode: 'line', history: [],
  };
  closePanels();
  setFollow(false);
  document.body.classList.add('editing');
  $('editBar').hidden = false;
  map.doubleClickZoom.disable();
  editLayer.addTo(map);
  drawActiveRoute();     // 編集中は通常表示を消す
  setMode('line');
  if (r) fitRoute(r);
  renderEdit();
}

function endEdit() {
  editing = null;
  editLayer.clearLayers(); editLayer.remove();
  document.body.classList.remove('editing');
  $('editBar').hidden = true;
  map.doubleClickZoom.enable();
  drawActiveRoute();
}

function setMode(mode) {
  editing.mode = mode;
  $('modeLine').classList.toggle('active', mode === 'line');
  $('modeCp').classList.toggle('active', mode === 'cp');
  $('editHint').textContent = mode === 'line'
    ? '地図をタップして道に沿って点を打ちます。□はドラッグで移動、タップで削除。○をタップすると間に点を追加。'
    : '地図（または線の□）をタップしてチェックポイントを置きます。置いたポイントはドラッグで移動、タップで編集。';
}
$('modeLine').addEventListener('click', () => { setMode('line'); renderEdit(); });
$('modeCp').addEventListener('click', () => { setMode('cp'); renderEdit(); });

function vertexIcon(cls) {
  return L.divIcon({ className: '', html: `<div class="v-handle ${cls}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
}
const midIcon = L.divIcon({ className: '', html: '<div class="v-mid">+</div>', iconSize: [18, 18], iconAnchor: [9, 9] });

function renderEdit() {
  if (!editing) return;
  const d = editing.draft;
  editLayer.clearLayers();
  drawRouteInto(editLayer, d);
  const last = d.points.length - 1;
  d.points.forEach((p, i) => {
    const m = L.marker([p.lat, p.lon], {
      icon: vertexIcon(i === 0 ? 'first' : i === last ? 'last' : ''), draggable: true, zIndexOffset: 600,
    }).addTo(editLayer);
    m.on('dragstart', pushHistory);
    m.on('drag', (e) => { p.lat = e.latlng.lat; p.lon = e.latlng.lng; });
    m.on('dragend', renderEdit);
    m.on('click', () => {
      if (editing.mode === 'cp') { openCpDialog(null, { lat: p.lat, lon: p.lon }); return; }
      if (!confirm(`${i + 1}番目の点を削除しますか？`)) return;
      pushHistory(); d.points.splice(i, 1); renderEdit();
    });
  });
  // 線の途中に点を追加するための「＋」
  for (let i = 0; i < last && editing.mode === 'line'; i++) {
    const a = d.points[i], b = d.points[i + 1];
    L.marker([(a.lat + b.lat) / 2, (a.lon + b.lon) / 2], { icon: midIcon, zIndexOffset: 550 })
      .on('click', () => { pushHistory(); d.points.splice(i + 1, 0, { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }); renderEdit(); })
      .addTo(editLayer);
  }
  for (const cp of d.cps) {
    const m = cpMarker(cp, { draggable: true }).addTo(editLayer);
    m.on('dragstart', pushHistory);
    m.on('dragend', (e) => { const ll = e.target.getLatLng(); cp.lat = ll.lat; cp.lon = ll.lng; renderEdit(); });
    m.on('click', () => openCpDialog(cp));
  }
  $('editInfo').textContent = `距離 ${fmtDist(routeDistance(d.points))} ・ 点 ${d.points.length} ・ チェックポイント ${d.cps.length}`;
}

map.on('click', (e) => {
  if (!editing) return;
  const ll = { lat: e.latlng.lat, lon: e.latlng.lng };
  if (editing.mode === 'line') {
    pushHistory(); editing.draft.points.push(ll); renderEdit();
  } else {
    openCpDialog(null, ll);
  }
});

$('editUndo').addEventListener('click', () => {
  if (!editing || !editing.history.length) { toast('これ以上戻せません'); return; }
  Object.assign(editing.draft, JSON.parse(editing.history.pop()));
  renderEdit();
});
$('editCancel').addEventListener('click', () => {
  if (editing.history.length && !confirm('変更を保存せずに終了しますか？')) return;
  endEdit();
  $('panelRoutes').hidden = false; renderRoutes();
});
$('editSave').addEventListener('click', () => {
  const d = editing.draft;
  if (!d.points.length && !d.cps.length) { toast('地図をタップしてルートを描いてください'); return; }
  let r = routes.find((x) => x.id === editing.routeId);
  if (!r) {
    const name = prompt('ルートの名前', d.name || `ルート ${fmtDate(Date.now())}`);
    if (name === null) return;
    r = { id: Date.now(), name: name.trim() || `ルート ${fmtDate(Date.now())}`, created: Date.now(), points: [], cps: [] };
    routes.push(r);
  }
  r.points = d.points.map((p) => ({ lat: p.lat, lon: p.lon }));
  r.cps = d.cps;
  saveRoutes();
  endEdit();
  setActiveRoute(r.id);
  toast(`ルート「${r.name}」を保存しました`);
});

/* ---------- チェックポイントのダイアログ ---------- */
let cpTarget = null;   // { cp: 既存 or null, ll: 新規位置, type }
const cpTypesEl = $('cpTypes');
for (const [k, t] of Object.entries(CP_TYPES)) {
  const b = document.createElement('button');
  b.type = 'button'; b.dataset.type = k; b.style.setProperty('--c', t.color);
  b.innerHTML = `<span class="badge">${t.mark}</span>${t.label}`;
  b.onclick = () => selectCpType(k);
  cpTypesEl.appendChild(b);
}
function selectCpType(k) {
  cpTarget.type = k;
  cpTypesEl.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.type === k));
}
function openCpDialog(cp, ll) {
  cpTarget = { cp, ll, type: cp ? cp.type : 'summit' };
  $('cpTitle').textContent = cp ? 'チェックポイントを編集' : 'チェックポイントを追加';
  $('cpName').value = cp ? cp.name : '';
  $('cpDelete').hidden = !cp;
  selectCpType(cpTarget.type);
  $('cpDialog').hidden = false;
}
const closeCpDialog = () => { $('cpDialog').hidden = true; cpTarget = null; };
$('cpCancel').addEventListener('click', closeCpDialog);
$('cpDialog').addEventListener('click', (e) => { if (e.target.id === 'cpDialog') closeCpDialog(); });
$('cpOk').addEventListener('click', () => {
  pushHistory();
  const name = $('cpName').value.trim();
  if (cpTarget.cp) { cpTarget.cp.type = cpTarget.type; cpTarget.cp.name = name; }
  else editing.draft.cps.push({ id: Date.now(), type: cpTarget.type, name, lat: cpTarget.ll.lat, lon: cpTarget.ll.lon });
  closeCpDialog(); renderEdit();
});
$('cpDelete').addEventListener('click', () => {
  pushHistory();
  editing.draft.cps = editing.draft.cps.filter((c) => c !== cpTarget.cp);
  closeCpDialog(); renderEdit();
});

$('btnNewRoute').addEventListener('click', () => startEdit(null));

drawActiveRoute();
