// Proshno service worker: the app opens instantly and works offline after the first visit.
// The page itself is network-first (so a new version is picked up at once); fonts, icons and PDF libraries are cache-first.
// The MCQ test (checker/) has its own service worker.
const CACHE = 'proshno-v2';
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('proshno-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.includes('/checker/')) return;
  const put = (k, r) => { if (r && (r.ok || r.type === 'opaque')) { const c = r.clone(); caches.open(CACHE).then(x => x.put(k, c)); } return r; };
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
  if (url.origin === location.origin && (url.pathname.includes('/api/') || url.pathname.endsWith('/admin') || url.pathname.endsWith('admin.html'))) return;
  // the sign-in key: fresh when online, the saved copy when offline
  if (url.origin === location.origin && url.pathname.endsWith('auth-config.js')) {
    e.respondWith(fetch(req, {cache: 'no-cache'}).then(r => put(req, r)).catch(() => caches.match(req)));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(Promise.race([fetch(req, {cache: 'no-cache'}).then(r => put('index.html', r)), new Promise((_, no) => setTimeout(no, 5000))])
      .catch(() => caches.match('index.html')));
    return;
  }
  const cdn = /fonts\.(googleapis|gstatic)\.com$|cdnjs\.cloudflare\.com$/.test(url.hostname);
  if (url.origin === location.origin || cdn)
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => put(req, r))));
});
