// 純粋な計算ロジック(ブラウザ/Node 両対応)
(function (root) {
  const R = 6371008.8;
  const rad = d => d * Math.PI / 180;

  function haversine(a, b) {
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // ルート: [[lat,lon],...] -> {pts, cum, total}
  function buildRoute(pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
    return { pts, cum, total: cum.length ? cum[cum.length - 1] : 0 };
  }

  // 点 p をルートに射影。[lo,hi] は ルート上の距離(m)の探索範囲。
  function projectOnRoute(route, p, lo, hi) {
    const { pts, cum } = route;
    const k = Math.cos(rad(p[0]));
    let best = null;
    for (let i = 0; i < pts.length - 1; i++) {
      if (cum[i + 1] < lo || cum[i] > hi) continue;
      const ax = (pts[i][1] - p[1]) * 111320 * k, ay = (pts[i][0] - p[0]) * 110540;
      const bx = (pts[i + 1][1] - p[1]) * 111320 * k, by = (pts[i + 1][0] - p[0]) * 110540;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const off = Math.hypot(ax + t * dx, ay + t * dy);
      if (!best || off < best.off) best = { off, dist: cum[i] + t * (cum[i + 1] - cum[i]) };
    }
    return best;
  }

  // ルート上の現在位置(道なりの進捗 m)。{dist, off}: off = 現在地とルートの最短距離(m)
  // 道なりに進んだ位置だけを数え(ルートから外れた点は無視)、最後の点がルート外でも
  // ルート上の最も近い点で位置を見積もる。ルートも記録も無ければ null。
  function routeProgress(route, track, maxOff) {
    maxOff = maxOff || 120;
    if (!route || route.pts.length < 2 || !track.length) return null;
    let prog = 0;
    for (const q of track) {
      const p = [q.lat, q.lon];
      let r = projectOnRoute(route, p, prog - 300, prog + 3000);
      if (!r || r.off > maxOff) {
        const r2 = projectOnRoute(route, p, prog - 300, Infinity);
        r = r2 && r2.off <= maxOff ? r2 : null;
      }
      if (r) prog = Math.max(prog, r.dist);
    }
    const l = track[track.length - 1], lp = [l.lat, l.lon];
    const near = projectOnRoute(route, lp, prog - 300, prog + 3000);
    if (near && near.off <= maxOff) return { dist: prog, off: near.off };
    const any = near || projectOnRoute(route, lp, -Infinity, Infinity);
    return { dist: near ? Math.max(prog, near.dist) : prog, off: any ? any.off : Infinity };
  }

  // 精度の悪い点を除き、累積距離を付与
  function prepareTrack(raw, maxAcc) {
    maxAcc = maxAcc || 80;
    const out = [];
    let d = 0;
    for (const p of raw) {
      if (p.acc > maxAcc) continue;
      const prev = out[out.length - 1];
      if (prev) {
        const s = haversine([prev.lat, prev.lon], [p.lat, p.lon]);
        d += s < 15 ? 0 : s;          // 止まっているときの GPS ゆらぎ(15m未満)は歩行として数えない
      }
      out.push({ t: p.t, lat: p.lat, lon: p.lon, d });
    }
    return out;
  }

  // 時刻 t(ms) までの累積距離(m)
  function distAt(track, startMs, t) {
    if (!track.length || t <= startMs) return 0;
    if (t <= track[0].t) {
      const f = (t - startMs) / Math.max(1, track[0].t - startMs);
      return track[0].d * f;
    }
    for (let i = 1; i < track.length; i++) {
      if (t <= track[i].t) {
        const a = track[i - 1], b = track[i];
        return a.d + (b.d - a.d) * (t - a.t) / Math.max(1, b.t - a.t);
      }
    }
    return track[track.length - 1].d;
  }

  // 休憩判定: 同じ場所(半径 radius m 以内)に minMs 以上とどまっていたら休憩。 -> [{s,e}] (ms)
  function restIntervals(track, minMs, radius) {
    minMs = minMs || 180000; radius = radius || 20;
    const out = [], n = track.length;
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && haversine([track[i].lat, track[i].lon], [track[j + 1].lat, track[j + 1].lon]) <= radius) j++;
      if (track[j].t - track[i].t >= minMs) { out.push({ s: track[i].t, e: track[j].t }); i = j + 1; }
      else i++;
    }
    return out;
  }

  function restOverlap(rests, s, e) {
    let ms = 0;
    for (const r of rests) ms += Math.max(0, Math.min(e, r.e) - Math.max(s, r.s));
    return ms;
  }

  // 開始から 1 時間ごとの平均速度。kmh=休憩込み / kmhMoving=休憩を除いた仮想速度
  function hourly(track, startMs, endMs, rests) {
    rests = rests || [];
    const H = 3600000, rows = [];
    for (let k = 0; startMs + k * H < endMs; k++) {
      const s = startMs + k * H, e = Math.min(endMs, s + H);
      const m = distAt(track, startMs, e) - distAt(track, startMs, s);
      const hours = (e - s) / H;
      const restMs = restOverlap(rests, s, e), movingH = (e - s - restMs) / H;
      rows.push({ k, minutes: Math.round((e - s) / 60000), km: m / 1000,
        restMin: Math.round(restMs / 60000),
        kmh: hours >= 5 / 60 ? (m / 1000) / hours : null,
        kmhMoving: movingH >= 5 / 60 ? (m / 1000) / movingH : null,
        partial: e - s < H });
    }
    return rows;
  }

  const api = { haversine, buildRoute, projectOnRoute, routeProgress, prepareTrack, distAt, hourly, restIntervals, restOverlap };
  if (typeof module !== 'undefined') module.exports = api; else root.NH = api;
})(typeof window !== 'undefined' ? window : globalThis);
