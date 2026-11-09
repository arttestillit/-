'use strict';
/*
 * ナビ表示
 *  - 表示中のルートに沿って「次のチェックポイントまで あと◯m・標高差」「ゴールまで」を表示
 *  - ルートから外れたら振動とメッセージで知らせる
 * app.js / routes.js の map, routes, activeRouteId, latestFix, settings などを利用する
 */

const OFF_ROUTE_CONFIRM_MS = 15000;   // この時間外れ続けたら警告（GPSのブレで誤報しないため）

let navRoute = null;      // 計算用に前処理したルート
let navProgress = null;   // 直近のルート上の位置（m）。往復ルートで逆側に飛ばないために使う
let offSince = 0;         // ルート外れを最初に検知した時刻
let offAlerted = false;
const navLayer = L.layerGroup().addTo(map);

/* --- 平面近似（数km 程度なら十分な精度） --- */
function makeProjector(lat0, lon0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  return (p) => ({ x: (p.lon - lon0) * kx, y: (p.lat - lat0) * ky });
}

// ルートを前処理: 各頂点までの累積距離、チェックポイントのルート上の位置
function prepareRoute(r) {
  if (!r) return null;
  const base = r.points[0] || r.cps[0];
  if (!base) return null;
  const proj = makeProjector(base.lat, base.lon);
  const pts = r.points.map(proj);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const nr = { route: r, proj, pts, cum, total: cum[cum.length - 1] || 0 };
  nr.cps = r.cps.map((cp) => {
    const m = pts.length > 1 ? matchOnRoute(nr, proj(cp), null) : null;
    return { cp, along: m ? m.along : null };
  });
  // ルート上の順に並べる（ルートに乗っていないものは最後）
  nr.cps.sort((a, b) => (a.along ?? Infinity) - (b.along ?? Infinity));
  return nr;
}

// 点 q に最も近いルート上の位置を返す { along, dist, x, y }
// hint（前回の位置）がある場合、距離がほぼ同じ候補の中から前回に近い方を選ぶ（往復ルート対策）
function matchOnRoute(nr, q, hint) {
  const cands = [];
  for (let i = 1; i < nr.pts.length; i++) {
    const a = nr.pts[i - 1], b = nr.pts[i];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2)) : 0;
    const x = a.x + t * dx, y = a.y + t * dy;
    cands.push({ along: nr.cum[i - 1] + t * Math.sqrt(len2), dist: Math.hypot(q.x - x, q.y - y), x, y });
  }
  if (!cands.length) return null;
  const best = cands.reduce((m, c) => (c.dist < m.dist ? c : m));
  if (hint == null) return best;
  const near = cands.filter((c) => c.dist <= best.dist + 30);
  return near.reduce((m, c) => (Math.abs(c.along - hint) < Math.abs(m.along - hint) ? c : m));
}

function navReset() {
  const r = routes.find((x) => x.id === activeRouteId);
  navRoute = r && !editing ? prepareRoute(r) : null;
  navProgress = null; offSince = 0; offAlerted = false;
  navLayer.clearLayers();
  if (navRoute) fillCpElevations(navRoute.route);
  navUpdate();
}

function navUpdate() {
  const el = $('navInfo');
  navLayer.clearLayers();
  if (!navRoute || !latestFix || Date.now() - latestFix.t > 120000) { el.textContent = ''; el.className = ''; return; }
  const f = latestFix, nr = navRoute;
  const q = nr.proj(f);
  let lines = [], off = false, offDist = 0, m = null;

  if (nr.pts.length > 1) {
    m = matchOnRoute(nr, q, navProgress);
    offDist = m.dist;
    navProgress = m.along;
    // ゴールまで
    const remain = Math.max(0, nr.total - m.along);
    // 次のチェックポイント（ルート上で現在地より先にある最初のもの）
    const next = nr.cps.find((c) => c.along != null && c.along > m.along + 15);
    if (next) lines.push(cpLine(next.cp, next.along - m.along, 'ルート沿い'));
    lines.push(remain < 20 ? '🏁 ゴール付近です' : `🏁 ゴールまで ${fmtDist(remain)}`);
    // ルート外れの判定（GPSの誤差ぶんは差し引く）
    const limit = settings.offRouteDist;
    const effective = offDist - Math.min(f.acc || 0, 50) * 0.5;
    off = f.acc <= 100 && effective > limit;
    const back = effective < limit * 0.6;
    if (off) {
      if (!offSince) offSince = Date.now();
      if (!offAlerted && settings.offRouteAlert && Date.now() - offSince >= OFF_ROUTE_CONFIRM_MS) {
        offAlerted = true;
        try { navigator.vibrate && navigator.vibrate([400, 150, 400, 150, 400]); } catch {}
        toast(`⚠ ルートから ${fmtDist(offDist)} 外れています`, 6000);
      }
    } else if (back) {
      if (offAlerted) { toast('ルートに戻りました'); try { navigator.vibrate && navigator.vibrate(150); } catch {} }
      offSince = 0; offAlerted = false;
    }
    // 外れているときは、ルートの最寄り地点まで線を引く
    if (offDist > settings.offRouteDist * 0.6) {
      const ll = unproject(nr, m);
      L.polyline([[f.lat, f.lon], ll], { color: '#ef6c00', weight: 3, dashArray: '6 6', interactive: false }).addTo(navLayer);
      L.circleMarker(ll, { radius: 5, color: '#ef6c00', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(navLayer);
    }
  } else if (nr.cps.length) {
    // 線がなくチェックポイントだけのルート：一番近いポイントまでの直線距離
    const c = nr.cps.reduce((a, b) => (haversine(f, a.cp) < haversine(f, b.cp) ? a : b));
    lines.push(cpLine(c.cp, haversine(f, c.cp), '直線'));
  }

  if (off && offSince) lines.unshift(`⚠ ルートから ${fmtDist(offDist)} 外れています（オレンジの点線の先がルート）`);
  el.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
  el.className = off && offSince ? 'off' : '';
}

function cpLine(cp, dist, how) {
  const t = CP_TYPES[cp.type] || CP_TYPES.view;
  let s = `<span class="nav-badge" style="--c:${t.color}">${t.mark}</span>次：${escapeHtml(cp.name || t.label)} あと <b>${fmtDist(dist)}</b>`;
  if (how === '直線') s += '（直線）';
  if (cp.ele != null && latestFix && latestFix.alt != null) {
    const d = Math.round(cp.ele - latestFix.alt);
    s += ` ・ 標高差 ${d >= 0 ? '↑' : '↓'}${Math.abs(d)}m`;
  } else if (cp.ele != null) {
    s += ` ・ 標高 ${Math.round(cp.ele)}m`;
  }
  return s;
}

function unproject(nr, m) {
  const base = nr.route.points[0];
  const kx = 111320 * Math.cos((base.lat * Math.PI) / 180), ky = 110540;
  return [base.lat + m.y / ky, base.lon + m.x / kx];
}

/* --- チェックポイントの標高（国土地理院の標高API。電波がある時だけ取得） --- */
async function fetchElevation(lat, lon) {
  try {
    const url = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lon}&lat=${lat}&outtype=JSON`;
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return null;
    const j = await res.json();
    const e = parseFloat(j.elevation);
    return isFinite(e) ? e : null;
  } catch { return null; }
}
let fillingEle = false;
async function fillCpElevations(r) {
  if (fillingEle || !navigator.onLine) return;
  const missing = r.cps.filter((c) => c.ele == null);
  if (!missing.length) return;
  fillingEle = true;
  let changed = false;
  for (const cp of missing) {
    const e = await fetchElevation(cp.lat, cp.lon);
    if (e != null) { cp.ele = e; changed = true; }
  }
  fillingEle = false;
  if (changed) { saveRoutes(); drawActiveRoute(false); navUpdate(); }
}

/* --- 設定 --- */
if (settings.offRouteAlert == null) settings.offRouteAlert = true;
if (settings.offRouteDist == null) settings.offRouteDist = 50;
$('setOffRoute').checked = settings.offRouteAlert;
$('setOffRouteDist').value = String(settings.offRouteDist);
$('setOffRoute').addEventListener('change', (e) => { settings.offRouteAlert = e.target.checked; saveSettings(); });
$('setOffRouteDist').addEventListener('change', (e) => { settings.offRouteDist = parseInt(e.target.value, 10); saveSettings(); navUpdate(); });

navReset();
