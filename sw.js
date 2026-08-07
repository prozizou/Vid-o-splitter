/* Service worker — Studio Vidéo (PWA)
   - Précache le "shell" léger de l'app (HTML/CSS/JS/manifest/icônes)
   - Met en cache à la volée les gros fichiers ffmpeg/mp4box (/vendor/*)
     => l'app fonctionne hors-ligne dès la 2e ouverture.

   TROIS points corrigés en v8 :

   1. `cleanUrls: true` (vercel.json) redirige /splitter.html vers /splitter en
      308. Précacher les chemins en .html faisait donc échouer `cache.addAll`,
      qui est ATOMIQUE : une seule entrée en échec et TOUT le shell hors-ligne
      était perdu, silencieusement. On précache désormais les URL propres.

   2. Le repli de navigation renvoyait toujours /index.html : hors-ligne,
      ouvrir une page précachée (un raccourci du manifeste, par exemple)
      affichait l'accueil. On cherche maintenant la page demandée dans le
      cache avant de se rabattre.

   3. Le shell était servi en cache-first : après un déploiement, l'utilisateur
      recevait le HTML neuf (navigation en réseau-d'abord) avec l'ancien JS.
      Entre modules ESM qui évoluent ensemble, ça casse. On passe en
      stale-while-revalidate : réponse immédiate depuis le cache, et mise à
      jour en arrière-plan pour la visite suivante.
*/
// Empreinte du contenu, injectée par build.sh. Elle change des qu'UN SEUL
// fichier du shell change — donc sw.js change aussi, donc le navigateur voit
// une vraie mise a jour, donc `activate` s'execute et purge l'ancien cache.
//
// Avant, ce numero etait ecrit a la main : deux livraisons ont modifie six
// fichiers JS sans qu'il bouge. sw.js restant identique a l'octet pres, le
// navigateur ne declenchait aucune mise a jour et la purge n'avait jamais lieu.
const VERSION = '__BUILD_VERSION__';
const SHELL_CACHE  = `shell-${VERSION}`;
const VENDOR_CACHE = `vendor-${VERSION}`;

// URL PROPRES (sans .html) : c'est ce que sert Vercel avec cleanUrls.
const PAGES = ['/', '/splitter'];

const ASSETS = [
  '/app.js',
  '/turbo.js',
  '/turbo-util.js',
  '/turbo-mp4.js',
  '/turbo-video.js',
  '/turbo-audio.js',
  '/turbo-render.js',
  '/turbo-join.js',
  '/silence.js',
  '/media.js',
  '/bgm.js',
  '/sw-register.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/icons/favicon.ico',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll est atomique : une entrée en échec annule tout. On ajoute donc les
    // fichiers un par un, et un échec isolé (une icône manquante, par exemple)
    // ne prive plus l'utilisateur de tout le mode hors-ligne.
    await Promise.all([...PAGES, ...ASSETS].map(async url => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch { /* réessayé à la volée lors de la première visite */ }
    }));
    // PAS de skipWaiting() ici : prendre la main au milieu d'un traitement long
    // remplacerait les fichiers sous les pieds de l'onglet en cours. On attend
    // que l'utilisateur clique « Recharger » dans le bandeau (sw-register.js).
  })());
});

// Déclenché par le bandeau de mise à jour.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== SHELL_CACHE && k !== VENDOR_CACHE).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// Met à jour l'entrée en cache en arrière-plan, sans bloquer la réponse.
async function revalidate(cache, req) {
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') await cache.put(req, res.clone());
    return res;
  } catch {
    return null;
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // on ne touche qu'au même domaine

  // --- Navigation : réseau d'abord, puis LA PAGE demandée, puis l'accueil ---
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(SHELL_CACHE);
          cache.put(url.pathname, res.clone()).catch(() => {});
        }
        return res;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match(url.pathname))
            || (await cache.match(url.pathname.replace(/\.html$/, '')))
            || (await cache.match('/'))
            || Response.error();
      }
    })());
    return;
  }

  // --- Fichiers moteur volumineux : cache-first, remplis à la volée ---------
  // Ils ne changent que si build.sh change de version épinglée, et le nom du
  // cache est versionné : inutile de les revalider à chaque chargement.
  if (url.pathname.startsWith('/vendor/')) {
    event.respondWith((async () => {
      const cache = await caches.open(VENDOR_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    })());
    return;
  }

  // --- Reste du shell : stale-while-revalidate ------------------------------
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(req);
    if (hit) {
      event.waitUntil(revalidate(cache, req));   // rafraîchi pour la prochaine fois
      return hit;
    }
    const res = await revalidate(cache, req);
    // Surtout PAS de repli vers /index.html ici : renvoyer du HTML pour un .js
    // manquant produit une erreur de type MIME incompréhensible. Mieux vaut
    // laisser remonter l'échec réseau, qui est ce qui s'est réellement passé.
    return res || Response.error();
  })());
});
