'use strict';
/*
 * 道のデータ（国土地理院 最適化ベクトルタイル）
 *  - 地理院地図に描かれている道路・登山道（徒歩道）の線データを読み込む
 *  - 2点間を道に沿った最短経路で結ぶ（ダイクストラ法）
 *  - 分岐点（3方向以上に分かれる点）と山頂（山名＋標高点）を求める
 * ルート作成時に使う。地図をダウンロードした範囲は圏外でも使える。
 */

const VT_URL = 'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/{z}/{x}/{y}.pbf';
const VT_Z = 16;                 // 道のデータは z16 のタイルで読む（1枚 約500m四方）
const TRAIL_MIN_ZOOM = 14;       // これより縮小していると範囲が広すぎるので読み込まない
const MAX_VT_TILES = 300;        // 一度に読み込むタイル数の上限
const GRID = 0.002;              // 線分を探すための格子の大きさ（度、約200m）

const trailNet = {
  nodes: new Map(),              // key -> { lat, lon, adj: Set<key> }
  grid: new Map(),               // 'i,j' -> [[keyA, keyB], ...]
  pois: new Map(),               // id -> { id, lat, lon, type, name, ele }
  tiles: new Set(),              // 読み込み済みタイル 'x/y'
  loading: null,
};

/* ---------- Mapbox Vector Tile の最小限のデコーダ ---------- */
function pbfReader(buf) {
  let pos = 0;
  const varint = () => {
    let v = 0, s = 1, b;
    do { b = buf[pos++]; v += (b & 0x7f) * s; s *= 128; } while (b & 0x80);
    return v;
  };
  return {
    get pos() { return pos; },
    end: buf.length,
    varint,
    tag() { const t = varint(); return [t >> 3, t & 7]; },
    bytes() { const n = varint(); const sub = buf.subarray(pos, pos + n); pos += n; return sub; },
    skip(wt) {
      if (wt === 0) varint(); else if (wt === 1) pos += 8; else if (wt === 2) pos += varint(); else if (wt === 5) pos += 4;
      else throw new Error('unknown wire type ' + wt);
    },
    f32() { const v = new DataView(buf.buffer, buf.byteOffset + pos, 4).getFloat32(0, true); pos += 4; return v; },
    f64() { const v = new DataView(buf.buffer, buf.byteOffset + pos, 8).getFloat64(0, true); pos += 8; return v; },
  };
}
const utf8 = new TextDecoder();
function packed(bytes) { const r = pbfReader(bytes), out = []; while (r.pos < r.end) out.push(r.varint()); return out; }
const zz = (n) => (n >>> 1) ^ -(n & 1);

function decodeValue(bytes) {
  const r = pbfReader(bytes);
  while (r.pos < r.end) {
    const [f, wt] = r.tag();
    if (f === 1) return utf8.decode(r.bytes());
    if (f === 2) return r.f32();
    if (f === 3) return r.f64();
    if (f === 4 || f === 5) return r.varint();
    if (f === 6) return zz(r.varint());
    if (f === 7) return !!r.varint();
    r.skip(wt);
  }
  return null;
}

// 必要なレイヤーだけ { name: { extent, features: [{type, props, geom: [[[x,y],...], ...]}] } } にする
function decodeMVT(buf, wanted) {
  const tile = pbfReader(buf), layers = {};
  while (tile.pos < tile.end) {
    const [f, wt] = tile.tag();
    if (f !== 3) { tile.skip(wt); continue; }
    const lr = pbfReader(tile.bytes());
    let name = '', extent = 4096;
    const keys = [], values = [], feats = [];
    while (lr.pos < lr.end) {
      const [lf, lwt] = lr.tag();
      if (lf === 1) name = utf8.decode(lr.bytes());
      else if (lf === 2) feats.push(lr.bytes());
      else if (lf === 3) keys.push(utf8.decode(lr.bytes()));
      else if (lf === 4) values.push(decodeValue(lr.bytes()));
      else if (lf === 5) extent = lr.varint();
      else lr.skip(lwt);
    }
    if (!wanted.includes(name)) continue;
    layers[name] = { extent, features: feats.map((fb) => {
      const fr = pbfReader(fb);
      let type = 0, tags = [], geom = [];
      while (fr.pos < fr.end) {
        const [ff, fwt] = fr.tag();
        if (ff === 2) tags = packed(fr.bytes());
        else if (ff === 3) type = fr.varint();
        else if (ff === 4) geom = packed(fr.bytes());
        else fr.skip(fwt);
      }
      const props = {};
      for (let i = 0; i < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      // ジオメトリのコマンド列を線（点の配列）の配列にする
      const lines = [];
      let x = 0, y = 0, cur = null;
      for (let i = 0; i < geom.length;) {
        const cmd = geom[i] & 7, cnt = geom[i] >> 3; i++;
        if (cmd === 7) { if (cur && cur.length) cur.push(cur[0]); continue; }
        for (let k = 0; k < cnt; k++) {
          x += zz(geom[i++]); y += zz(geom[i++]);
          if (cmd === 1) { cur = []; lines.push(cur); }
          cur.push([x, y]);
        }
      }
      return { type, props, geom: lines };
    }) };
  }
  return layers;
}

/* ---------- タイル番号と座標 ---------- */
const N16 = 2 ** VT_Z;
const lonToTX = (lon) => ((lon + 180) / 360) * N16;
const latToTY = (lat) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N16; };
const gxToLon = (gx) => (gx / N16) * 360 - 180;
const gyToLat = (gy) => { const n = Math.PI - (2 * Math.PI * gy) / N16; return (180 / Math.PI) * Math.atan(Math.sinh(n)); };

function tilesFor(b) {
  const x0 = Math.floor(lonToTX(b.w)), x1 = Math.floor(lonToTX(b.e));
  const y0 = Math.floor(latToTY(b.n)), y1 = Math.floor(latToTY(b.s));
  const out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y]);
  return out;
}
function trailsCover(b) { return tilesFor(b).every(([x, y]) => trailNet.tiles.has(x + '/' + y)); }

/* ---------- 道のネットワーク ---------- */
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
// 全国共通の整数座標（z16 タイル × extent）を点のキーにすると、隣のタイルとも同じ点が一致する
function nodeAt(gx, gy) {
  const key = Math.round(gx) + ',' + Math.round(gy);
  if (!trailNet.nodes.has(key)) {
    trailNet.nodes.set(key, { lat: gyToLat(Math.round(gy) / UNITS), lon: gxToLon(Math.round(gx) / UNITS), adj: new Set(), gx: Math.round(gx), gy: Math.round(gy) });
  }
  return key;
}
let UNITS = 4096;
function link(a, b) {
  if (a === b) return;
  const A = trailNet.nodes.get(a), B = trailNet.nodes.get(b);
  if (A.adj.has(b)) return;
  A.adj.add(b); B.adj.add(a);
  addSegToGrid(a, b);
}

// 線をタイルの枠 [0, ext] で切り取る（はみ出し部分は隣のタイルが受け持つ）
function clipLine(pts, ext) {
  const out = [];
  let cur = null;
  for (let i = 1; i < pts.length; i++) {
    let [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    let t0 = 0, t1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    const ok = [[-dx, x0], [dx, ext - x0], [-dy, y0], [dy, ext - y0]].every(([p, q]) => {
      if (p === 0) return q >= 0;
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
      return true;
    });
    if (!ok) { cur = null; continue; }
    const a = [x0 + t0 * dx, y0 + t0 * dy], b = [x0 + t1 * dx, y0 + t1 * dy];
    if (!cur || t0 > 0) { cur = [a]; out.push(cur); }
    cur.push(b);
    if (t1 < 1) cur = null;
  }
  return out;
}

const ELEV_CODES = new Set([7101, 7102, 7103, 7201, 7221]);   // 電子基準点・三角点・水準点・標高点
function addTile(x, y, layers) {
  const rd = layers.RdCL;
  if (rd) {
    UNITS = rd.extent;
    for (const f of rd.features) {
      for (const line of f.geom) {
        for (const piece of clipLine(line, rd.extent)) {
          let prev = null;
          for (const [px, py] of piece) {
            const k = nodeAt(x * rd.extent + px, y * rd.extent + py);
            if (prev) link(prev, k);
            prev = k;
          }
        }
      }
    }
  }
  // 山頂：山名（注記）の近くの標高点・三角点の位置に置く
  const an = layers.Anno;
  if (an) {
    const ext = an.extent;
    const toLL = (p) => ({ lat: gyToLat((y * ext + p[1]) / ext), lon: gxToLon((x * ext + p[0]) / ext) });
    const elevs = [];
    for (const f of an.features) {
      if (f.type === 1 && ELEV_CODES.has(f.props.vt_code) && f.geom[0]) {
        const ele = parseFloat(f.props.vt_text);
        if (isFinite(ele)) elevs.push({ ...toLL(f.geom[0][0]), ele });
      }
    }
    for (const f of an.features) {
      if (f.type !== 1 || f.props.vt_code !== 312 || !f.props.vt_text || !f.geom[0]) continue;
      const p = toLL(f.geom[0][0]);
      let best = null;
      for (const e of elevs) { const d = haversine(p, e); if (d < 400 && (!best || e.ele > best.ele)) best = e; }
      const at = best || p;
      const id = 'peak:' + f.props.vt_text + ':' + at.lat.toFixed(4) + ':' + at.lon.toFixed(4);
      trailNet.pois.set(id, { id, lat: at.lat, lon: at.lon, type: 'summit', name: f.props.vt_text, ele: best ? best.ele : null });
    }
  }
  trailNet.tiles.add(x + '/' + y);
}

// 1枚のタイルを取得（保存済みならそれを使う。圏外でもダウンロード済みの範囲は使える）
async function fetchVT(x, y) {
  const url = VT_URL.replace('{z}', VT_Z).replace('{x}', x).replace('{y}', y);
  const cache = 'caches' in window ? await caches.open(TILE_CACHE) : null;
  let res = cache && await cache.match(url);
  if (!res) {
    res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (res.status === 404) return new Uint8Array(0);   // 海など、データのないタイル
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (cache) cache.put(url, res.clone()).catch(() => {});
  }
  return new Uint8Array(await res.arrayBuffer());
}

// 範囲の道を読み込む（読み込み済みのタイルは飛ばす）
async function loadTrails(bounds) {
  const b = { s: bounds.getSouth(), w: bounds.getWest(), n: bounds.getNorth(), e: bounds.getEast() };
  const todo = tilesFor(b).filter(([x, y]) => !trailNet.tiles.has(x + '/' + y));
  if (!todo.length) return 'cached';
  if (todo.length > MAX_VT_TILES) throw new Error('範囲が広すぎます');
  if (trailNet.loading) await trailNet.loading.catch(() => {});
  trailNet.loading = (async () => {
    let failed = 0, i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const [x, y] = todo[i++];
        if (trailNet.tiles.has(x + '/' + y)) continue;
        try { addTile(x, y, decodeMVT(await fetchVT(x, y), ['RdCL', 'Anno'])); }
        catch { failed++; }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (failed === todo.length) throw new Error('道のデータを取得できませんでした');
    return 'loaded';
  })();
  try { return await trailNet.loading; } finally { trailNet.loading = null; }
}

// 地図のダウンロード時に、道のデータも一緒に保存しておく
function trailTileUrls(b) {
  return tilesFor(b).map(([x, y]) => VT_URL.replace('{z}', VT_Z).replace('{x}', x).replace('{y}', y));
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
      const key = a < b ? a + '|' + b : b + '|' + a;
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
