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
function drawActiveRoute(resetNav = true) {
  routeLayer.clearLayers();
  if (resetNav && typeof navReset === 'function') navReset();
  const r = routes.find((x) => x.id === activeRouteId);
  if (!r || editing) return;
  drawRouteInto(routeLayer, r);
  for (const cp of r.cps) {
    const t = CP_TYPES[cp.type] || CP_TYPES.view;
    cpMarker(cp).bindPopup(() => `<b>${escapeHtml(cp.name || t.label)}</b><br>${t.label}` +
      (cp.ele != null ? `<br>標高 ${Math.round(cp.ele)} m` : '') +
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
    (c.ele != null ? `<ele>${c.ele.toFixed(1)}</ele>` : '') + `<desc>${CP_TYPES[c.type].label}</desc><type>${c.type}</type></wpt>`).join('\n');
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
      ele: (() => { const e = parseFloat((w.getElementsByTagName('ele')[0] || {}).textContent); return isFinite(e) ? e : null; })(),
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
// 編集中のルートは「経由点（タップした点）」と「経由点の間の線（道に沿った線）」で持つ
//   draft = { name, wps: [{lat, lon}], legs: [[[lat, lon], ...], ...], cps }
//   legs[i] は wps[i] → wps[i+1] を結ぶ線
let editing = null;     // { routeId|null, draft, mode, history: [], follow: bool }
const editLayer = L.layerGroup();
const candLayer = L.layerGroup();   // 分岐点・山頂などの候補
const CAND_MIN_ZOOM = 14;
const SNAP_PX = 28;                 // タップ位置から道に吸い寄せる距離（画面上のピクセル）

function snapshot() { const d = editing.draft; return JSON.stringify({ wps: d.wps, legs: d.legs, cps: d.cps }); }
function pushHistory() { editing.history.push(snapshot()); if (editing.history.length > 200) editing.history.shift(); }

const llOf = (p) => [p.lat, p.lon];
function flattenLegs(d) {
  if (!d.legs.length) return d.wps.map((p) => ({ lat: p.lat, lon: p.lon }));
  const out = [];
  d.legs.forEach((leg, i) => leg.forEach((c, j) => { if (i > 0 && j === 0) return; out.push({ lat: c[0], lon: c[1] }); }));
  return out;
}
function metersPerPixel() {
  const c = map.getSize().divideBy(2);
  return map.distance(map.containerPointToLatLng(c), map.containerPointToLatLng(c.add([10, 0]))) / 10;
}

// 2つの経由点を結ぶ線（道に沿うモードで道が見つかれば道なり、なければ直線）
function makeLeg(a, b) {
  if (editing.follow && trailNet.nodes.size) {
    const r = Math.max(40, metersPerPixel() * SNAP_PX);
    const s = snapToTrail(a.lat, a.lon, r), e = snapToTrail(b.lat, b.lon, r);
    if (s && e) {
      const path = routeAlongTrails(s, e);
      if (path) { path[0] = llOf(a); path[path.length - 1] = llOf(b); return path; }
    }
    editing.straightCount = (editing.straightCount || 0) + 1;
  }
  return [llOf(a), llOf(b)];
}
// タップした点を道の上に吸い寄せる
function snapPoint(ll) {
  if (!editing.follow || !trailNet.nodes.size) return ll;
  const s = snapToTrail(ll.lat, ll.lon, Math.max(25, metersPerPixel() * SNAP_PX));
  return s ? { lat: s.lat, lon: s.lon } : ll;
}

function addWaypoint(ll) {
  const d = editing.draft;
  pushHistory();
  editing.straightCount = 0;
  const p = { lat: ll.lat, lon: ll.lon };
  if (d.wps.length) d.legs.push(makeLeg(d.wps[d.wps.length - 1], p));
  d.wps.push(p);
  if (editing.straightCount) toast('この区間は道が見つからないため直線で結びました');
  renderEdit();
}
function recomputeAround(i) {
  const d = editing.draft;
  if (i > 0) d.legs[i - 1] = makeLeg(d.wps[i - 1], d.wps[i]);
  if (i < d.wps.length - 1) d.legs[i] = makeLeg(d.wps[i], d.wps[i + 1]);
}
function removeWaypoint(i) {
  const d = editing.draft;
  pushHistory();
  if (d.wps.length === 1) { d.wps = []; d.legs = []; }
  else if (i === 0) { d.wps.shift(); d.legs.shift(); }
  else if (i === d.wps.length - 1) { d.wps.pop(); d.legs.pop(); }
  else { d.wps.splice(i, 1); d.legs.splice(i - 1, 2, makeLeg(d.wps[i - 1], d.wps[i])); }
  renderEdit();
}
// 線の途中に経由点を追加（線はそのまま2つに分ける）
function splitLeg(i) {
  const d = editing.draft, leg = d.legs[i];
  pushHistory();
  let k = Math.floor(leg.length / 2), p;
  if (leg.length === 2) { p = [(leg[0][0] + leg[1][0]) / 2, (leg[0][1] + leg[1][1]) / 2]; d.legs.splice(i, 1, [leg[0], p], [p, leg[1]]); }
  else { p = leg[k]; d.legs.splice(i, 1, leg.slice(0, k + 1), leg.slice(k)); }
  d.wps.splice(i + 1, 0, { lat: p[0], lon: p[1] });
  renderEdit();
}

function startEdit(r) {
  if (recId && !confirm('記録は続けたままルートを編集します。よろしいですか？')) return;
  let draft;
  if (r && r.wps && r.legs) draft = JSON.parse(JSON.stringify({ name: r.name, wps: r.wps, legs: r.legs, cps: r.cps }));
  else if (r) {   // 以前の形式（点を直線で結んだルート）や GPX から読み込んだルート
    const wps = r.points.map((p) => ({ lat: p.lat, lon: p.lon }));
    const legs = wps.slice(1).map((p, i) => [llOf(wps[i]), llOf(p)]);
    draft = { name: r.name, wps, legs, cps: JSON.parse(JSON.stringify(r.cps)) };
  } else draft = { name: '', wps: [], legs: [], cps: [] };
  editing = { routeId: r ? r.id : null, draft, mode: 'line', history: [], follow: store.get('mgps.followTrails', true) };
  closePanels();
  setFollow(false);
  document.body.classList.add('editing');
  $('editBar').hidden = false;
  map.doubleClickZoom.disable();
  editLayer.addTo(map); candLayer.addTo(map);
  drawActiveRoute();     // 編集中は通常表示を消す
  setMode('line');
  updateFollowButton();
  if (r) fitRoute(r);
  renderEdit();
  ensureTrails();
}

function endEdit() {
  editing = null;
  editLayer.clearLayers(); editLayer.remove();
  candLayer.clearLayers(); candLayer.remove();
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
    ? '通る場所を順にタップ → 道に沿って結びます。◇分岐・▲山頂もタップで選べます。□ドラッグで移動／タップで削除、＋で間に追加'
    : '◇分岐・▲山頂・🏠小屋・👁展望地をタップ → 名前入りで追加。地図の好きな場所にも置けます';
  renderCandidates();
}
$('modeLine').addEventListener('click', () => { setMode('line'); renderEdit(); });
$('modeCp').addEventListener('click', () => { setMode('cp'); renderEdit(); });

function updateFollowButton() {
  $('followTrails').classList.toggle('active', editing.follow);
  $('followTrails').textContent = editing.follow ? '🛤 道に沿う：ON' : '📏 道に沿う：OFF（直線）';
}
$('followTrails').addEventListener('click', () => {
  editing.follow = !editing.follow;
  store.set('mgps.followTrails', editing.follow);
  updateFollowButton();
  if (editing.follow) ensureTrails();
  toast(editing.follow ? 'これから打つ点は道に沿って結びます' : 'これから打つ点は直線で結びます');
});

/* --- 道のデータの読み込みと候補表示 --- */
let trailStatus = '';
let trailTimer = null;
async function ensureTrails() {
  if (!editing || !editing.follow) { trailStatus = ''; renderEditInfo(); return; }
  if (map.getZoom() < TRAIL_MIN_ZOOM) { trailStatus = '道のデータ：地図を拡大すると読み込みます'; renderEditInfo(); renderCandidates(); return; }
  const b = map.getBounds().pad(0.5);
  const sb = { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
  if (trailsCover(sb)) { trailStatus = '道のデータ：読み込み済み'; renderEditInfo(); renderCandidates(); return; }
  trailStatus = '道のデータ：読み込み中…'; renderEditInfo();
  try {
    await loadTrails(b);
    map.attributionControl.addAttribution('道データ &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>');
    trailStatus = '道のデータ：読み込み済み';
  } catch {
    trailStatus = navigator.onLine === false ? '道のデータ：圏外のため直線で結びます' : '道のデータ：取得できませんでした（直線で結びます）';
  }
  renderEditInfo();
  renderCandidates();
}
map.on('moveend', () => {
  if (!editing) return;
  clearTimeout(trailTimer);
  trailTimer = setTimeout(ensureTrails, 500);
  renderCandidates();
});

const POI_MARK = { summit: '▲', rest: '🏠', view: '👁' };
function renderCandidates() {
  candLayer.clearLayers();
  if (!editing || map.getZoom() < CAND_MIN_ZOOM) return;
  const b = map.getBounds().pad(0.2);
  const junctions = trailJunctions(b);
  if (junctions.length > 600) return;   // 多すぎる場合は拡大してもらう
  for (const j of junctions) {
    L.marker([j.lat, j.lon], {
      icon: L.divIcon({ className: '', html: '<div class="cand-junction"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
      zIndexOffset: 300, bubblingMouseEvents: false,
    }).on('click', () => pickCandidate({ lat: j.lat, lon: j.lon, type: 'junction', name: '' })).addTo(candLayer);
  }
  for (const p of trailNet.pois.values()) {
    if (!b.contains([p.lat, p.lon])) continue;
    const m = L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: '', html: `<div class="cand-poi" style="--c:${CP_TYPES[p.type].color}">${POI_MARK[p.type]}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
      zIndexOffset: 400, bubblingMouseEvents: false,
    }).on('click', () => pickCandidate(p)).addTo(candLayer);
    if (p.name) m.bindTooltip(escapeHtml(p.name) + (p.ele != null ? ` ${Math.round(p.ele)}m` : ''), { permanent: true, direction: 'bottom', offset: [0, 8], className: 'cand-label' });
  }
}
// 候補をタップ：線モードなら経由点に、ポイントモードなら種類・名前入りでチェックポイント追加
function pickCandidate(c) {
  if (editing.mode === 'line') { addWaypoint({ lat: c.lat, lon: c.lon }); return; }
  openCpDialog(null, { lat: c.lat, lon: c.lon }, { type: c.type, name: c.name, ele: c.ele });
}

function vertexIcon(cls) {
  return L.divIcon({ className: '', html: `<div class="v-handle ${cls}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
}
const midIcon = L.divIcon({ className: '', html: '<div class="v-mid">+</div>', iconSize: [18, 18], iconAnchor: [9, 9] });

function renderEditInfo() {
  if (!editing) return;
  const d = editing.draft;
  $('editInfo').innerHTML = `距離 ${fmtDist(routeDistance(flattenLegs(d)))} ・ 点 ${d.wps.length} ・ チェックポイント ${d.cps.length}` +
    (trailStatus ? `<br><span class="small">${escapeHtml(trailStatus)}</span>` : '');
}

function renderEdit() {
  if (!editing) return;
  const d = editing.draft;
  editLayer.clearLayers();
  drawRouteInto(editLayer, { name: d.name, points: flattenLegs(d) });
  const last = d.wps.length - 1;
  d.wps.forEach((p, i) => {
    const m = L.marker([p.lat, p.lon], {
      icon: vertexIcon(i === 0 ? 'first' : i === last ? 'last' : ''), draggable: true, zIndexOffset: 600,
    }).addTo(editLayer);
    m.on('dragstart', pushHistory);
    m.on('dragend', (e) => {
      const ll = snapPoint({ lat: e.target.getLatLng().lat, lon: e.target.getLatLng().lng });
      p.lat = ll.lat; p.lon = ll.lon;
      editing.straightCount = 0;
      recomputeAround(i);
      renderEdit();
    });
    m.on('click', () => {
      if (editing.mode === 'cp') { openCpDialog(null, { lat: p.lat, lon: p.lon }); return; }
      if (confirm(`${i + 1}番目の点を削除しますか？`)) removeWaypoint(i);
    });
  });
  // 線の途中に点を追加するための「＋」
  if (editing.mode === 'line') {
    d.legs.forEach((leg, i) => {
      const k = Math.floor(leg.length / 2);
      const pos = leg.length === 2 ? [(leg[0][0] + leg[1][0]) / 2, (leg[0][1] + leg[1][1]) / 2] : leg[k];
      L.marker(pos, { icon: midIcon, zIndexOffset: 550 }).on('click', () => splitLeg(i)).addTo(editLayer);
    });
  }
  for (const cp of d.cps) {
    const m = cpMarker(cp, { draggable: true }).addTo(editLayer);
    m.on('dragstart', pushHistory);
    m.on('dragend', (e) => { const ll = e.target.getLatLng(); cp.lat = ll.lat; cp.lon = ll.lng; cp.ele = null; renderEdit(); });
    m.on('click', () => openCpDialog(cp));
  }
  renderEditInfo();
}

map.on('click', (e) => {
  if (!editing) return;
  const ll = { lat: e.latlng.lat, lon: e.latlng.lng };
  if (editing.mode === 'line') addWaypoint(snapPoint(ll));
  else openCpDialog(null, ll);
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
  if (!d.wps.length && !d.cps.length) { toast('地図をタップしてルートを描いてください'); return; }
  let r = routes.find((x) => x.id === editing.routeId);
  if (!r) {
    const name = prompt('ルートの名前', d.name || `ルート ${fmtDate(Date.now())}`);
    if (name === null) return;
    r = { id: Date.now(), name: name.trim() || `ルート ${fmtDate(Date.now())}`, created: Date.now(), points: [], cps: [] };
    routes.push(r);
  }
  r.points = flattenLegs(d);
  r.wps = d.wps;
  r.legs = d.legs;
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
function openCpDialog(cp, ll, preset = null) {
  cpTarget = { cp, ll, type: cp ? cp.type : (preset ? preset.type : 'summit'), ele: preset ? preset.ele : null };
  $('cpTitle').textContent = cp ? 'チェックポイントを編集' : 'チェックポイントを追加';
  $('cpName').value = cp ? cp.name : (preset ? preset.name : '');
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
  else editing.draft.cps.push({ id: Date.now(), type: cpTarget.type, name, lat: cpTarget.ll.lat, lon: cpTarget.ll.lon,
    ele: cpTarget.ele != null ? cpTarget.ele : null });
  closeCpDialog(); renderEdit();
});
$('cpDelete').addEventListener('click', () => {
  pushHistory();
  editing.draft.cps = editing.draft.cps.filter((c) => c !== cpTarget.cp);
  closeCpDialog(); renderEdit();
});

$('btnNewRoute').addEventListener('click', () => startEdit(null));

drawActiveRoute();
