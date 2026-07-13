/* Service worker — Video Silence Cutter PWA
   - Précache le "shell" léger de l'app (HTML/CSS/JS/manifest/icônes)
   - Met en cache à la volée les gros fichiers ffmpeg (/vendor/*) au 1er usage
     => l'app fonctionne hors-ligne dès la 2e ouverture.
*/
const VERSION = 'v7';
const SHELL_CACHE  = `shell-${VERSION}`;
const VENDOR_CACHE = `vendor-${VERSION}`;

const SHELL = [
  '/',
  '/index.html',
  '/splitter.html',
  '/echo.html',
  '/studio.html',
  '/lyrics.html',
  '/app.js',
  '/turbo.js',
  '/media.js',
  '/sfx.js',
  '/echo.js',
  '/studio.js',
  '/lyrics.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/icons/favicon.ico'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL_CACHE && k !== VENDOR_CACHE)
          .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // on ne touche qu'au même domaine

  // Navigation (ouverture de l'app) : réseau d'abord, cache en secours.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Fichiers ffmpeg volumineux : cache-first, rempli à la volée.
  if (url.pathname.startsWith('/vendor/')) {
    event.respondWith(
      caches.open(VENDOR_CACHE).then(async cache => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // Reste du shell : cache-first avec repli réseau.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then(c => c.put(req, copy));
      }
      return res;
    } catch (e) {
      return caches.match('/index.html');
    }
  })());
});
