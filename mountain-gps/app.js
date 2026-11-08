'use strict';
/*
 * オフライン山GPS
 *  - 事前に地図タイルを Cache Storage に保存し、圏外でも表示
 *  - GPS (Geolocation API) で現在地を表示
 *  - 記録中は一定間隔（既定3分）で位置をログし、軌跡を描画
 *  - 軌跡は localStorage に保存、GPX で書き出し/読み込み
 */

const APP_VERSION = '1.1.0';
const TILE_CACHE = 'mgps-tiles-v1';
const MAX_TILES = 20000;          // 1回のダウンロード上限
const DL_CONCURRENCY = 6;

const LAYERS = {
  gsi_std: {
    name: '地理院地図 標準（等高線あり）',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    maxNativeZoom: 18, minZoom: 5,
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
  },
  gsi_pale: {
    name: '地理院地図 淡色',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
    maxNativeZoom: 18, minZoom: 5,
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
  },
  gsi_photo: {
    name: '地理院 航空写真',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    maxNativeZoom: 18, minZoom: 5,
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
  },
  osm: {
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxNativeZoom: 19, minZoom: 2, maxDlZoom: 16,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
  },
};

/* ---------- 保存（localStorage, 例外安全） ---------- */
const store = {
  get(key, def) {
    try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); }
    catch { return def; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { toast('保存に失敗しました: ' + e.message); return false; }
  },
};

const SETTINGS_REV = 2;
const storedSettings = store.get('mgps.settings', null);
const settings = Object.assign(
  { interval: 30, wake: true, follow: true, layer: 'gsi_std' },
  storedSettings || {},
);
const saveSettings = () => store.set('mgps.settings', settings);
if (storedSettings && (storedSettings.rev || 1) < 2 && settings.interval === 180) {
  settings.interval = 30;                // v1 の既定（3分）から 30秒 へ移行
}
settings.rev = SETTINGS_REV;
saveSettings();

/* ---------- ユーティリティ ---------- */
const $ = (id) => document.getElementById(id);
let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const pad2 = (n) => String(n).padStart(2, '0');
function fmtTime(ts) { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${fmtTime(ts)}`;
}
function fmtDur(ms) {
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}時間${pad2(m % 60)}分` : `${m}分`;
}
function fmtInterval(sec) { return sec < 60 ? `${sec}秒` : `${sec / 60}分`; }
function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m'; }
function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function trackStats(points) {
  let dist = 0, up = 0, down = 0;
  for (let i = 1; i < points.length; i++) {
    dist += haversine(points[i - 1], points[i]);
    const a0 = points[i - 1].alt, a1 = points[i].alt;
    if (a0 != null && a1 != null) { const d = a1 - a0; if (d > 0) up += d; else down -= d; }
  }
  const dur = points.length > 1 ? points[points.length - 1].t - points[0].t : 0;
  return { dist, up, down, dur };
}

/* ---------- 地図 ---------- */
const lastView = store.get('mgps.view', { lat: 35.3606, lon: 138.7274, z: 12 }); // 既定: 富士山
const map = L.map('map', { zoomControl: false, maxZoom: 18 }).setView([lastView.lat, lastView.lon], lastView.z);
// 記録点は数が多いので Canvas で描画（tolerance を広げてタップしやすく）
const pointRenderer = L.canvas({ padding: 0.5, tolerance: 10 });
// 縮小表示では時刻ラベルを隠して画面をすっきりさせる
const LABEL_MIN_ZOOM = 13;
function updateLabelVisibility() { map.getContainer().classList.toggle('hide-labels', map.getZoom() < LABEL_MIN_ZOOM); }
map.on('zoomend', updateLabelVisibility);
updateLabelVisibility();
L.control.zoom({ position: 'topright' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

const baseLayers = {};
for (const [id, def] of Object.entries(LAYERS)) {
  baseLayers[def.name] = L.tileLayer(def.url, {
    maxZoom: 18, maxNativeZoom: def.maxNativeZoom, minZoom: def.minZoom,
    attribution: def.attribution, crossOrigin: true,
  });
  baseLayers[def.name]._mgpsId = id;
}
const initialLayer = baseLayers[(LAYERS[settings.layer] || LAYERS.gsi_std).name];
initialLayer.addTo(map);
L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
map.on('baselayerchange', (e) => { settings.layer = e.layer._mgpsId; saveSettings(); updateEstimate(); });
map.on('moveend', () => {
  const c = map.getCenter();
  store.set('mgps.view', { lat: c.lat, lon: c.lng, z: map.getZoom() });
  updateEstimate();
});
map.on('dragstart', () => { if (settings.follow) setFollow(false); });

/* ---------- タイル計算 ---------- */
function lon2x(lon, z) { return Math.floor(((lon + 180) / 360) * 2 ** z); }
function lat2y(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}
function tileRange(b, z) {
  const n = 2 ** z - 1, clamp = (v) => Math.max(0, Math.min(n, v));
  return {
    x0: clamp(lon2x(b.west, z)), x1: clamp(lon2x(b.east, z)),
    y0: clamp(lat2y(b.north, z)), y1: clamp(lat2y(b.south, z)),
  };
}
function* tilesIn(b, zmin, zmax) {
  for (let z = zmin; z <= zmax; z++) {
    const r = tileRange(b, z);
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) yield { z, x, y };
  }
}
function countTiles(b, zmin, zmax) {
  let n = 0;
  for (let z = zmin; z <= zmax; z++) { const r = tileRange(b, z); n += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1); }
  return n;
}
const tileUrl = (tpl, t) => tpl.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);

/* ---------- 地図ダウンロード ---------- */
const dlLayerSel = $('dlLayer');
for (const [id, def] of Object.entries(LAYERS)) {
  const o = document.createElement('option'); o.value = id; o.textContent = def.name; dlLayerSel.appendChild(o);
}
dlLayerSel.value = settings.layer;

function dlBounds() {
  const padRatio = parseFloat($('dlPad').value) || 0;
  const b = map.getBounds().pad(padRatio);
  return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
}
function dlParams() {
  const layerId = dlLayerSel.value;
  const def = LAYERS[layerId];
  let zmin = parseInt($('dlZmin').value, 10) || 10;
  let zmax = parseInt($('dlZmax').value, 10) || 16;
  const zcap = def.maxDlZoom || def.maxNativeZoom;
  zmin = Math.max(def.minZoom, Math.min(zmin, zcap));
  zmax = Math.max(zmin, Math.min(zmax, zcap));
  return { layerId, def, zmin, zmax, bounds: dlBounds() };
}
function updateEstimate() {
  if ($('panelDownload').hidden) return;
  const p = dlParams();
  const n = countTiles(p.bounds, p.zmin, p.zmax);
  const mb = (n * (p.layerId === 'gsi_photo' ? 25 : 15)) / 1024; // 1タイル平均 15〜25KB 想定
  const el = $('dlEstimate');
  el.textContent = `タイル数 約 ${n.toLocaleString()} 枚（目安 ${mb.toFixed(0)} MB） / ズーム ${p.zmin}〜${p.zmax}`;
  el.classList.toggle('warn', n > MAX_TILES);
  if (n > MAX_TILES) el.textContent += ` — 上限 ${MAX_TILES.toLocaleString()} 枚を超えています。範囲を狭めるか最大ズームを下げてください`;
  $('btnDl').disabled = n > MAX_TILES || dlRunning;
}
['dlZmin', 'dlZmax', 'dlPad', 'dlLayer'].forEach((id) => $(id).addEventListener('change', updateEstimate));

let dlRunning = false, dlAbort = false;
let areaRects = L.layerGroup().addTo(map);

async function startDownload() {
  if (!('caches' in window)) { toast('このブラウザは地図の保存に対応していません（HTTPSで開いてください）'); return; }
  const p = dlParams();
  const total = countTiles(p.bounds, p.zmin, p.zmax);
  if (total > MAX_TILES) return;
  if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch {} }

  dlRunning = true; dlAbort = false;
  $('btnDl').disabled = true; $('btnDlCancel').hidden = false;
  document.querySelector('#panelDownload .progress').hidden = false;
  const cache = await caches.open(TILE_CACHE);
  const iter = tilesIn(p.bounds, p.zmin, p.zmax);
  let done = 0, failed = 0, skipped = 0;
  const update = () => {
    $('dlBar').style.width = ((done / total) * 100).toFixed(1) + '%';
    $('dlStatus').textContent = `${done.toLocaleString()} / ${total.toLocaleString()} 枚` +
      (skipped ? `（保存済み ${skipped}）` : '') + (failed ? `　失敗 ${failed}` : '');
  };

  async function worker() {
    for (;;) {
      if (dlAbort) return;
      const n = iter.next();
      if (n.done) return;
      const url = tileUrl(p.def.url, n.value);
      try {
        if (await cache.match(url)) { skipped++; }
        else {
          let ok = false;
          for (let attempt = 0; attempt < 3 && !ok; attempt++) {
            try {
              const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
              if (res.ok) { await cache.put(url, res); ok = true; }
              else if (res.status === 404) { ok = true; } // 海上など存在しないタイル
            } catch { await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); }
          }
          if (!ok) failed++;
        }
      } catch { failed++; }
      done++;
      if (done % 10 === 0 || done === total) update();
    }
  }
  await Promise.all(Array.from({ length: DL_CONCURRENCY }, worker));
  update();

  const name = $('dlName').value.trim() || `エリア ${fmtDate(Date.now())}`;
  if (!dlAbort) {
    const areas = store.get('mgps.areas', []);
    areas.push({ id: Date.now(), name, layerId: p.layerId, zmin: p.zmin, zmax: p.zmax, bounds: p.bounds, tiles: total, failed });
    store.set('mgps.areas', areas);
    toast(failed ? `完了（${failed}枚失敗。もう一度実行すると失敗分だけ再取得します）` : '地図の保存が完了しました', 5000);
    $('dlName').value = '';
  } else {
    toast('ダウンロードを中止しました（取得済みのタイルは残ります）');
  }
  dlRunning = false;
  $('btnDlCancel').hidden = true;
  updateEstimate();
  renderAreas();
}
$('btnDl').addEventListener('click', startDownload);
$('btnDlCancel').addEventListener('click', () => { dlAbort = true; });

async function deleteArea(id) {
  const areas = store.get('mgps.areas', []);
  const area = areas.find((a) => a.id === id);
  if (!area || !confirm(`「${area.name}」の地図を削除しますか？`)) return;
  const rest = areas.filter((a) => a.id !== id);
  // 他の保存エリアと重なっているタイルは残す
  const keep = (t) => rest.some((a) => a.layerId === area.layerId && t.z >= a.zmin && t.z <= a.zmax && (() => {
    const r = tileRange(a.bounds, t.z); return t.x >= r.x0 && t.x <= r.x1 && t.y >= r.y0 && t.y <= r.y1;
  })());
  const cache = await caches.open(TILE_CACHE);
  const def = LAYERS[area.layerId];
  const jobs = [];
  for (const t of tilesIn(area.bounds, area.zmin, area.zmax)) if (!keep(t)) jobs.push(cache.delete(tileUrl(def.url, t)));
  await Promise.all(jobs);
  store.set('mgps.areas', rest);
  renderAreas();
  toast('削除しました');
}

async function renderAreas() {
  const areas = store.get('mgps.areas', []);
  const ul = $('areaList');
  ul.innerHTML = '';
  areaRects.clearLayers();
  if (!areas.length) ul.innerHTML = '<li class="empty">まだ保存された地図はありません</li>';
  for (const a of areas) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="title">${escapeHtml(a.name)}</div>
      <div class="meta">${escapeHtml(LAYERS[a.layerId]?.name || a.layerId)} ・ ズーム ${a.zmin}〜${a.zmax} ・ ${a.tiles.toLocaleString()}枚</div>
      <div class="actions"><button data-act="show">表示</button><button data-act="del">削除</button></div>`;
    li.querySelector('[data-act=show]').onclick = () => {
      map.fitBounds([[a.bounds.south, a.bounds.west], [a.bounds.north, a.bounds.east]]);
      setFollow(false);
    };
    li.querySelector('[data-act=del]').onclick = () => deleteArea(a.id);
    ul.appendChild(li);
    L.rectangle([[a.bounds.south, a.bounds.west], [a.bounds.north, a.bounds.east]],
      { color: '#1f5130', weight: 1, fill: false, dashArray: '4 4', interactive: false }).addTo(areaRects);
  }
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const e = await navigator.storage.estimate();
      $('storageInfo').textContent = `使用容量 ${(e.usage / 1048576).toFixed(1)} MB / 利用可能 ${(e.quota / 1048576).toFixed(0)} MB`;
    } catch {}
  }
}

$('btnClearTiles').addEventListener('click', async () => {
  if (!confirm('保存した地図をすべて削除しますか？')) return;
  await caches.delete(TILE_CACHE);
  store.set('mgps.areas', []);
  renderAreas();
  toast('すべての地図を削除しました');
});

/* ---------- 現在地 ---------- */
const posMarker = L.marker([0, 0], {
  icon: L.divIcon({ className: '', html: '<div class="pos-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
  interactive: false, keyboard: false, zIndexOffset: 1000,
});
const accCircle = L.circle([0, 0], { radius: 1, color: '#1976d2', weight: 1, fillOpacity: 0.12, interactive: false });
let latestFix = null;   // { lat, lon, alt, acc, t }
let watchId = null;
let firstFix = true;

function setFollow(on) {
  settings.follow = on; saveSettings();
  $('setFollow').checked = on;
  $('btnCenter').classList.toggle('active', on);
}

function onPosition(pos) {
  const c = pos.coords;
  latestFix = {
    lat: c.latitude, lon: c.longitude,
    alt: c.altitude != null ? c.altitude : null,
    acc: c.accuracy, t: Date.now(), // 端末によって pos.timestamp がずれるため受信時刻を使う
  };
  const ll = [latestFix.lat, latestFix.lon];
  posMarker.setLatLng(ll); accCircle.setLatLng(ll).setRadius(latestFix.acc);
  if (!map.hasLayer(posMarker)) { accCircle.addTo(map); posMarker.addTo(map); }
  if (firstFix || settings.follow) {
    map.setView(ll, firstFix ? Math.max(map.getZoom(), 15) : map.getZoom(), { animate: !firstFix });
    firstFix = false;
  }
  renderHud();
  maybeLog();
}
function onPositionError(err) {
  const msg = { 1: '位置情報の利用が許可されていません', 2: '位置を取得できません', 3: 'GPSタイムアウト' }[err.code] || err.message;
  $('gpsState').className = 'dot err';
  if (!latestFix) $('coord').textContent = msg;
  if (err.code === 1) toast(msg + '（ブラウザの設定で許可してください）', 5000);
}
function startWatch() {
  if (!('geolocation' in navigator)) { $('coord').textContent = 'この端末は位置情報に対応していません'; return; }
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 60000 });
}

function renderHud() {
  if (latestFix) {
    const f = latestFix;
    $('coord').textContent = `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}`;
    $('alt').textContent = f.alt != null ? `標高 ${Math.round(f.alt)} m` : '標高 --';
    $('acc').textContent = `精度 ±${Math.round(f.acc)} m`;
    const age = Math.round((Date.now() - f.t) / 1000);
    $('fixAge').textContent = age < 10 ? '最新' : `${age}秒前`;
    $('gpsState').className = 'dot ' + (age > 60 ? 'err' : f.acc > 50 ? 'weak' : 'ok');
  }
  const tr = currentTrack();
  if (tr) {
    const s = trackStats(tr.points);
    const next = lastLogAt ? Math.max(0, settings.interval - Math.floor((Date.now() - lastLogAt) / 1000)) : 0;
    $('recInfo').textContent = `● 記録中 ${fmtDur(Date.now() - tr.start)} ・ ${fmtDist(s.dist)} ・ ${tr.points.length}点 ・ 次の記録まで ${Math.floor(next / 60)}:${pad2(next % 60)}`;
  } else {
    $('recInfo').textContent = '';
  }
}

$('btnCenter').addEventListener('click', () => {
  setFollow(true);
  if (latestFix) map.setView([latestFix.lat, latestFix.lon], Math.max(map.getZoom(), 15));
  else toast('GPSで現在地を取得中です…');
});

/* ---------- 軌跡の記録 ---------- */
// tracks: [{ id, name, start, end, points: [{lat, lon, alt, acc, t}] }]
let tracks = store.get('mgps.tracks', []);
let recId = store.get('mgps.recording', null);   // 記録中のトラックID（リロードしても継続）
let lastLogAt = 0;
const saveTracks = () => store.set('mgps.tracks', tracks);
const currentTrack = () => (recId ? tracks.find((t) => t.id === recId) : null);
{
  const tr = currentTrack();
  if (recId && !tr) recId = null;
  if (tr && tr.points.length) lastLogAt = tr.points[tr.points.length - 1].t;
}

// 描画順: ルート（下）→ 過去の軌跡 → 記録中の軌跡（上）
map.createPane('routePane').style.zIndex = 390;
const recLine = L.polyline([], { color: '#d32f2f', weight: 4, opacity: 0.85 }).addTo(map);
const recPoints = L.layerGroup().addTo(map);
const viewLayer = L.layerGroup().addTo(map);   // 過去の軌跡表示用
const MAJOR_EVERY_MS = 10 * 60 * 1000;         // 10分ごとに大きな点＋時刻

function pointPopup(p, i) {
  return `<div class="pp-time">${fmtTime(p.t)}</div>#${i + 1} ・ ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` +
    (p.alt != null ? `<br>標高 ${Math.round(p.alt)} m` : '') + (p.acc ? `<br>精度 ±${Math.round(p.acc)} m` : '');
}
// 10分の区切り（時計の 10:00, 10:10 …）をまたいだ最初の点と、始点を「大きな点」にする
function isMajor(points, i) {
  return i === 0 || Math.floor(points[i].t / MAJOR_EVERY_MS) !== Math.floor(points[i - 1].t / MAJOR_EVERY_MS);
}
function drawTrackPoints(points, group, color) {
  points.forEach((p, i) => {
    if (isMajor(points, i)) {
      L.marker([p.lat, p.lon], {
        icon: L.divIcon({ className: '', html: `<div class="pt-major" style="--c:${color}"></div>`, iconSize: [20, 20], iconAnchor: [10, 10] }),
        zIndexOffset: 500,
      }).bindTooltip(fmtTime(p.t), { permanent: true, direction: 'right', offset: [10, 0], className: 'time-label' })
        .bindPopup(pointPopup(p, i)).addTo(group);
    } else {
      L.circleMarker([p.lat, p.lon], {
        renderer: pointRenderer, radius: 5, color, weight: 2, fillColor: '#fff', fillOpacity: 1,
      }).bindPopup(pointPopup(p, i)).addTo(group);
    }
  });
}
function drawRecording() {
  const tr = currentTrack();
  recPoints.clearLayers();
  if (!tr) { recLine.setLatLngs([]); return; }
  recLine.setLatLngs(tr.points.map((p) => [p.lat, p.lon]));
  drawTrackPoints(tr.points, recPoints, '#d32f2f');
}

function logPoint(fix) {
  const tr = currentTrack();
  if (!tr) return;
  tr.points.push({ lat: fix.lat, lon: fix.lon, alt: fix.alt, acc: fix.acc, t: Date.now() });
  tr.end = Date.now();
  lastLogAt = Date.now();
  saveTracks();
  drawRecording();
  renderHud();
}

let pendingOneShot = false;
function maybeLog(force = false) {
  if (!recId) return;
  const due = force || Date.now() - lastLogAt >= settings.interval * 1000;
  if (!due) return;
  const fresh = latestFix && Date.now() - latestFix.t < 30000;
  if (fresh) { logPoint(latestFix); return; }
  // 位置が古い場合は改めて取得してから記録
  if (pendingOneShot || !('geolocation' in navigator)) return;
  pendingOneShot = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => { pendingOneShot = false; onPosition(pos); if (Date.now() - lastLogAt >= settings.interval * 1000) logPoint(latestFix); },
    () => { pendingOneShot = false; },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 45000 },
  );
}

// 5秒ごとに記録タイミングを確認（タイマーがバックグラウンドで止まっても復帰時に追いつく）
setInterval(() => { maybeLog(); renderHud(); }, 5000);

/* --- 画面スリープ防止 --- */
let wakeLock = null;
async function updateWakeLock() {
  const want = recId && settings.wake && document.visibilityState === 'visible';
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release(); wakeLock = null;
    }
  } catch { /* 省電力モード等で拒否されることがある */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    startWatch();   // 一部端末はバックグラウンドで watch が止まるため張り直す
    maybeLog();
  }
  updateWakeLock();
});

function updateRecButton() {
  const b = $('btnRec');
  b.classList.toggle('recording', !!recId);
  b.textContent = recId ? '■ 記録停止' : '● 記録開始';
}

$('btnRec').addEventListener('click', () => {
  if (recId) {
    const tr = currentTrack();
    if (!confirm('記録を停止しますか？')) return;
    if (latestFix && Date.now() - latestFix.t < 30000) logPoint(latestFix); // 終点を記録
    recId = null; store.set('mgps.recording', null);
    tr.end = Date.now(); saveTracks();
    drawRecording();
    if (tr.points.length) showTrack(tr);
    const s = trackStats(tr.points);
    toast(`記録を保存しました：${fmtDist(s.dist)} / ${fmtDur(s.dur)} / ${tr.points.length}点`, 5000);
  } else {
    const now = Date.now();
    const tr = { id: now, name: `山行 ${fmtDate(now)}`, start: now, end: now, points: [] };
    tracks.push(tr); saveTracks();
    recId = tr.id; store.set('mgps.recording', recId);
    lastLogAt = 0;
    viewLayer.clearLayers();
    maybeLog(true);   // 始点をすぐ記録
    toast(`記録を開始しました（${fmtInterval(settings.interval)}ごと）`);
  }
  updateRecButton(); updateWakeLock(); renderHud(); renderTracks();
});

/* ---------- 軌跡一覧・GPX ---------- */
function showTrack(tr) {
  viewLayer.clearLayers();
  if (!tr.points.length) return;
  const lls = tr.points.map((p) => [p.lat, p.lon]);
  L.polyline(lls, { color: '#7b1fa2', weight: 4, opacity: 0.85 }).addTo(viewLayer);
  drawTrackPoints(tr.points, viewLayer, '#7b1fa2');
  if (lls.length > 1) L.circleMarker(lls[lls.length - 1], { radius: 8, color: '#fff', fillColor: '#c62828', fillOpacity: 1, weight: 3 }).bindPopup(`終了 ${fmtTime(tr.points[tr.points.length - 1].t)}`).addTo(viewLayer);
  setFollow(false);
  map.fitBounds(L.latLngBounds(lls).pad(0.2), { maxZoom: 16 });
}

function toGpx(tr) {
  const pts = tr.points.map((p) =>
    `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">` +
    (p.alt != null ? `<ele>${p.alt.toFixed(1)}</ele>` : '') +
    `<time>${new Date(p.t).toISOString()}</time></trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Offline Mountain GPS" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escapeHtml(tr.name)}</name><time>${new Date(tr.start).toISOString()}</time></metadata>
  <trk>
    <name>${escapeHtml(tr.name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}
function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function renderTracks() {
  const ul = $('trackList');
  ul.innerHTML = '';
  if (!tracks.length) { ul.innerHTML = '<li class="empty">まだ記録はありません</li>'; return; }
  for (const tr of [...tracks].reverse()) {
    const s = trackStats(tr.points);
    const li = document.createElement('li');
    const rec = tr.id === recId;
    li.innerHTML = `<div class="title">${rec ? '● ' : ''}${escapeHtml(tr.name)}</div>
      <div class="meta">${fmtDate(tr.start)} ・ ${fmtDur(s.dur)} ・ ${fmtDist(s.dist)} ・ ↑${Math.round(s.up)}m ↓${Math.round(s.down)}m ・ ${tr.points.length}点</div>
      <div class="actions">
        <button data-act="show">地図に表示</button><button data-act="gpx">GPX保存</button>
        <button data-act="rename">名前変更</button>${rec ? '' : '<button data-act="del">削除</button>'}
      </div>`;
    li.querySelector('[data-act=show]').onclick = () => { closePanels(); rec ? (viewLayer.clearLayers(), tr.points.length && map.fitBounds(L.latLngBounds(tr.points.map((p) => [p.lat, p.lon])).pad(0.2), { maxZoom: 16 })) : showTrack(tr); };
    li.querySelector('[data-act=gpx]').onclick = () => {
      const fname = tr.name.replace(/[\\/:*?"<>|\s]+/g, '_') + '.gpx';
      downloadFile(fname, toGpx(tr), 'application/gpx+xml');
    };
    li.querySelector('[data-act=rename]').onclick = () => {
      const n = prompt('軌跡の名前', tr.name);
      if (n && n.trim()) { tr.name = n.trim(); saveTracks(); renderTracks(); }
    };
    const del = li.querySelector('[data-act=del]');
    if (del) del.onclick = () => {
      if (!confirm(`「${tr.name}」を削除しますか？`)) return;
      tracks = tracks.filter((t) => t.id !== tr.id); saveTracks(); viewLayer.clearLayers(); renderTracks();
    };
    ul.appendChild(li);
  }
}

$('gpxImport').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
    const nodes = [...doc.getElementsByTagName('trkpt'), ...doc.getElementsByTagName('rtept')];
    const points = nodes.map((n, i) => {
      const ele = n.getElementsByTagName('ele')[0], time = n.getElementsByTagName('time')[0];
      return {
        lat: parseFloat(n.getAttribute('lat')), lon: parseFloat(n.getAttribute('lon')),
        alt: ele ? parseFloat(ele.textContent) : null, acc: 0,
        t: time ? Date.parse(time.textContent) : Date.now() + i,
      };
    }).filter((p) => isFinite(p.lat) && isFinite(p.lon));
    if (!points.length) throw new Error('軌跡データが見つかりません');
    const nameEl = doc.getElementsByTagName('name')[0];
    const tr = { id: Date.now(), name: nameEl ? nameEl.textContent : file.name.replace(/\.gpx$/i, ''),
      start: points[0].t, end: points[points.length - 1].t, points, imported: true };
    tracks.push(tr); saveTracks(); renderTracks(); closePanels(); showTrack(tr);
    toast(`${points.length}点の軌跡を読み込みました`);
  } catch (err) { toast('GPXの読み込みに失敗: ' + err.message, 5000); }
  e.target.value = '';
});

/* ---------- パネル ---------- */
function closePanels() { document.querySelectorAll('.panel').forEach((p) => { p.hidden = true; }); }
document.querySelectorAll('[data-panel]').forEach((b) => b.addEventListener('click', () => {
  const p = $(b.dataset.panel), wasHidden = p.hidden;
  closePanels();
  p.hidden = !wasHidden;
  if (!p.hidden) {
    if (p.id === 'panelDownload') { dlLayerSel.value = settings.layer; updateEstimate(); renderAreas(); }
    if (p.id === 'panelTracks') renderTracks();
    if (p.id === 'panelRoutes') renderRoutes();
  }
}));
document.querySelectorAll('.panel .close').forEach((b) => b.addEventListener('click', closePanels));

/* ---------- 設定 ---------- */
$('setInterval').value = String(settings.interval);
$('setWake').checked = settings.wake;
$('setFollow').checked = settings.follow;
$('btnCenter').classList.toggle('active', settings.follow);
$('setInterval').addEventListener('change', (e) => { settings.interval = parseInt(e.target.value, 10); saveSettings(); renderHud(); });
$('setWake').addEventListener('change', (e) => { settings.wake = e.target.checked; saveSettings(); updateWakeLock(); });
$('setFollow').addEventListener('change', (e) => setFollow(e.target.checked));
$('appVersion').textContent = `バージョン ${APP_VERSION}`;

/* ---------- 起動 ---------- */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW登録失敗', e));
}
renderAreas();
drawRecording();
updateRecButton();
updateWakeLock();
startWatch();
renderHud();
if (recId) maybeLog();
