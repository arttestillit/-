'use strict';
/*
 * 道のデータ（OpenStreetMap）
 *  - Overpass API から登山道・道路・山頂・山小屋・展望地を取得
 *  - 2点間を道に沿った最短経路で結ぶ（ダイクストラ法）
 *  - 分岐点（3方向以上に分かれる点）を求める
 * ルート作成時（電波のある所）でだけ使う。圏外では直線で結ぶ。
 */

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const TRAIL_HIGHWAYS = 'path|footway|track|steps|bridleway|pedestrian|living_street|residential|service|unclassified|tertiary|secondary|primary|trunk|road';
const TRAIL_MIN_ZOOM = 13;   // これより縮小していると範囲が広すぎるので読み込まない
const GRID = 0.002;          // 線分を探すための格子の大きさ（度、約200m）

const trailNet = {
  nodes: new Map(),          // id -> { lat, lon, adj: Set<id> }
  grid: new Map(),           // 'i,j' -> [[idA, idB], ...]
  pois: new Map(),           // id -> { id, lat, lon, type, name, ele }
  loaded: [],                // 読み込み済みの範囲 [{s,w,n,e}]
  loading: null,
};

const cellKey = (i, j) => i + ',' + j;
function addSegToGrid(a, b) {
  const A = trailNet.nodes.get(a), B = trailNet.nodes.get(b);
  const i0 = Math.floor(Math.min(A.lat, B.lat) / GRID), i1 = Math.floor(Math.max(A.lat, B.lat) / GRID);
  const j0 = Math.floor(Math.min(A.lon, B.lon) / GRID), j1 = Math.floor(Math.max(A.lon, B.lon) / GRID);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const k = cellKey(i, j);
    if (!trailNet.grid.has(k)) trailNet.grid.set(k, []);
    trailNet.grid.get(k).push([a, b]);
  }
}

function trailsCover(b) {
  return trailNet.loaded.some((r) => r.s <= b.s && r.w <= b.w && r.n >= b.n && r.e >= b.e);
}

const POI_TYPES = (tags) => {
  if (tags.natural === 'peak') return 'summit';
  if (tags.tourism === 'viewpoint') return 'view';
  if (tags.tourism === 'alpine_hut' || tags.tourism === 'wilderness_hut' || tags.amenity === 'shelter') return 'rest';
  return null;
};

// 指定範囲の道を読み込む（読み込み済みなら何もしない）
async function loadTrails(bounds) {
  const b = { s: bounds.getSouth(), w: bounds.getWest(), n: bounds.getNorth(), e: bounds.getEast() };
  if (trailsCover(b)) return 'cached';
  if (trailNet.loading) return trailNet.loading;
  const bbox = `${b.s.toFixed(5)},${b.w.toFixed(5)},${b.n.toFixed(5)},${b.e.toFixed(5)}`;
  const q = `[out:json][timeout:25];(` +
    `way["highway"~"^(${TRAIL_HIGHWAYS})$"](${bbox});` +
    `node["natural"="peak"](${bbox});node["tourism"~"^(alpine_hut|wilderness_hut|viewpoint)$"](${bbox});node["amenity"="shelter"](${bbox});` +
    `);out body;>;out skel qt;`;
  trailNet.loading = (async () => {
    let lastErr;
    for (const url of OVERPASS_URLS) {
      try {
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        mergeOsm(await res.json());
        trailNet.loaded.push(b);
        return 'loaded';
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  })();
  try { return await trailNet.loading; } finally { trailNet.loading = null; }
}

function mergeOsm(data) {
  const coords = new Map();
  for (const el of data.elements) if (el.type === 'node') coords.set(el.id, el);
  for (const el of data.elements) {
    if (el.type === 'node' && el.tags) {
      const type = POI_TYPES(el.tags);
      if (type) {
        const ele = parseFloat(el.tags.ele);
        trailNet.pois.set(el.id, { id: el.id, lat: el.lat, lon: el.lon, type,
          name: el.tags['name:ja'] || el.tags.name || '', ele: isFinite(ele) ? ele : null });
      }
    }
  }
  for (const el of data.elements) {
    if (el.type !== 'way' || !el.nodes) continue;
    for (let i = 0; i < el.nodes.length; i++) {
      const id = el.nodes[i], c = coords.get(id);
      if (!c) continue;
      if (!trailNet.nodes.has(id)) trailNet.nodes.set(id, { lat: c.lat, lon: c.lon, adj: new Set() });
    }
    for (let i = 1; i < el.nodes.length; i++) {
      const a = el.nodes[i - 1], b = el.nodes[i];
      const A = trailNet.nodes.get(a), B = trailNet.nodes.get(b);
      if (!A || !B || A.adj.has(b)) continue;
      A.adj.add(b); B.adj.add(a);
      addSegToGrid(a, b);
    }
  }
}

// 最寄りの道（線分）上の点。maxDist(m) より遠ければ null
function snapToTrail(lat, lon, maxDist) {
  const ky = 110540, kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const r = Math.ceil(maxDist / (GRID * ky)) + 1;
  const ci = Math.floor(lat / GRID), cj = Math.floor(lon / GRID);
  let best = null;
  const seen = new Set();
  for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
    for (const [a, b] of trailNet.grid.get(cellKey(i, j)) || []) {
      const key = a < b ? a + ':' + b : b + ':' + a;
      if (seen.has(key)) continue;
      seen.add(key);
      const A = trailNet.nodes.get(a), B = trailNet.nodes.get(b);
      const ax = (A.lon - lon) * kx, ay = (A.lat - lat) * ky, bx = (B.lon - lon) * kx, by = (B.lat - lat) * ky;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px, py);
      if (d <= maxDist && (!best || d < best.dist)) {
        best = { a, b, t, dist: d, lat: A.lat + t * (B.lat - A.lat), lon: A.lon + t * (B.lon - A.lon) };
      }
    }
  }
  return best;
}

/* --- 最短経路 --- */
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) {
    const a = this.a; a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}
const nodeDist = (A, B) => haversine(A, B);

// 道上の2点（snapToTrail の結果）を道に沿って結ぶ。[[lat,lon], ...] か null
function routeAlongTrails(s, e, maxNodes = 300000) {
  const same = (s.a === e.a && s.b === e.b) || (s.a === e.b && s.b === e.a);
  if (same) return [[s.lat, s.lon], [e.lat, e.lon]];
  const N = trailNet.nodes;
  const dist = new Map(), prev = new Map(), done = new Set();
  const heap = new MinHeap();
  for (const id of [s.a, s.b]) {
    const d = nodeDist(s, N.get(id));
    if (!dist.has(id) || d < dist.get(id)) { dist.set(id, d); prev.set(id, null); heap.push(d, id); }
  }
  const endCost = new Map([[e.a, nodeDist(N.get(e.a), e)], [e.b, nodeDist(N.get(e.b), e)]]);
  let best = Infinity, bestEnd = null, count = 0;
  while (heap.size) {
    const [d, id] = heap.pop();
    if (done.has(id) || d > dist.get(id)) continue;
    if (d >= best) break;
    done.add(id);
    if (++count > maxNodes) break;
    if (endCost.has(id) && d + endCost.get(id) < best) { best = d + endCost.get(id); bestEnd = id; }
    const A = N.get(id);
    for (const nb of A.adj) {
      if (done.has(nb)) continue;
      const nd = d + nodeDist(A, N.get(nb));
      if (!dist.has(nb) || nd < dist.get(nb)) { dist.set(nb, nd); prev.set(nb, id); heap.push(nd, nb); }
    }
  }
  if (bestEnd == null) return null;
  const path = [];
  for (let id = bestEnd; id != null; id = prev.get(id)) { const n = N.get(id); path.push([n.lat, n.lon]); }
  path.reverse();
  return [[s.lat, s.lon], ...path, [e.lat, e.lon]];
}

// 分岐点（3方向以上に道が分かれる点）
function trailJunctions(bounds) {
  const out = [];
  for (const [id, n] of trailNet.nodes) {
    if (n.adj.size >= 3 && bounds.contains([n.lat, n.lon])) out.push({ id, lat: n.lat, lon: n.lon });
  }
  return out;
}
