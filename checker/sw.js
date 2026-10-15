// Bubblemark service worker — makes the app open instantly and work offline.
const CACHE = 'bubblemark-dev';   // replaced with a content hash at build time (scripts/stamp-sw.mjs)
const FILES = ['./', 'index.html', 'omr.js', 'omr-worker.js', 'export.js', 'config.js', 'manifest.webmanifest', 'vendor/jspdf.umd.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url); if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return;   // sign-in and the admin page: always the network
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;   // local development: always load fresh files
  // App code (page, reader, worker, config) is network-first so a new deploy is never mixed with old cached code;
  // the cache is only the offline fallback, and is used after 4 s if the network is slow.
  const app = req.mode === 'navigate' || /\/(config|omr|omr-worker|export)\.js$/.test(url.pathname) || url.pathname.endsWith('/manifest.webmanifest');
  if (app) {
    const key = req.mode === 'navigate' ? 'index.html' : req;
    const fromNet = fetch(req, { cache: 'no-cache' }).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(key, c)); } return r; });
    const fromCache = () => caches.match(key, { ignoreSearch: true });
    e.respondWith(Promise.race([fromNet, new Promise((_, no) => setTimeout(no, 4000))]).catch(() => fromCache().then(hit => hit || fromNet)));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); } return r; })));
});
