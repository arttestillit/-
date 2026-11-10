'use strict';
// オフライン山GPS — Service Worker
// アプリ本体はプリキャッシュ、地図タイルはキャッシュ優先（閲覧したタイルも自動で保存）
const SHELL_CACHE = 'mgps-shell-v9';
const TILE_CACHE = 'mgps-tiles-v1';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'native.js', 'trails.js', 'routes.js', 'nav.js', 'manifest.webmanifest', 'icon.svg',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
];
const TILE_HOSTS = ['cyberjapandata.gsi.go.jp', 'tile.openstreetmap.org'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('mgps-shell-') && k !== SHELL_CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req.url);
      if (hit) return hit;
      try {
        const res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
        if (res.ok) cache.put(req.url, res.clone());
        return res;
      } catch {
        return new Response('', { status: 504, statusText: 'offline' });
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    // アプリ本体：ネット優先（更新を取り込む）→ 圏外ならキャッシュ
    e.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const fallback = async () => (await cache.match(req, { ignoreSearch: true })) ||
        (await cache.match('index.html')) || null;
      try {
        const res = await fetch(req);
        if (res.ok) { cache.put(req, res.clone()); return res; }
        // 公開サイトが一時的に消えても（404等）、保存済みのアプリで動き続ける
        return (await fallback()) || res;
      } catch {
        return (await fallback()) || new Response('offline', { status: 503 });
      }
    })());
  }
});
