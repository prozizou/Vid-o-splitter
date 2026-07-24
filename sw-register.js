/* Enregistrement du service worker, indicateur de version et bandeau de mise
   à jour.

   Ce code était en <script> inline dans chaque page. Il est sorti dans un
   fichier pour que la Content-Security-Policy puisse interdire tout script
   inline (`script-src 'self'`) — voir vercel.json.

   POURQUOI UN INDICATEUR DE VERSION
   Un service worker peut servir un code ancien sans que rien ne le signale.
   On a perdu du temps à se demander si une correction était déployée ou non :
   elle l'était, mais le navigateur servait toujours l'ancien fichier depuis son
   cache. La pastille en bas de page affiche la version RÉELLEMENT chargée, pas
   celle qui est en ligne. Comparez-la à celle du dépôt et le doute est levé.
*/

// Remplacé au build par une empreinte du contenu (voir build.sh).
const BUILD = '__BUILD_VERSION__';

// Un contrôleur déjà présent = ce n'est pas la première visite. Sert à ne pas
// recharger la page lors de l'installation initiale (clients.claim() déclenche
// aussi `controllerchange`).
const hadController = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;

function showBuildTag() {
  const tag = document.createElement('div');
  tag.className = 'build-tag';
  tag.textContent = BUILD.startsWith('__') ? 'version : dev' : `version ${BUILD}`;
  tag.title = 'Version réellement chargée dans ce navigateur';
  document.body.appendChild(tag);
}

function showUpdateBanner(reg) {
  if (document.querySelector('.update-banner')) return;

  const bar = document.createElement('div');
  bar.className = 'update-banner';
  bar.setAttribute('role', 'status');

  const txt = document.createElement('span');
  txt.textContent = 'Nouvelle version disponible.';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-small';
  btn.textContent = 'Recharger';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = 'Mise à jour…';
    // Le nouveau worker prend la main, puis `controllerchange` recharge.
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
  });

  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'btn btn-ghost btn-small';
  later.textContent = 'Plus tard';
  later.addEventListener('click', () => bar.remove());

  bar.append(txt, btn, later);
  document.body.appendChild(bar);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    showBuildTag();
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');

      // Une mise à jour peut déjà attendre depuis une visite précédente.
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg);

      reg.addEventListener('updatefound', () => {
        const nouveau = reg.installing;
        if (!nouveau) return;
        nouveau.addEventListener('statechange', () => {
          // « installed » avec un contrôleur déjà en place = mise à jour prête,
          // par opposition à une première installation.
          if (nouveau.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner(reg);
          }
        });
      });

      // Vérification explicite à chaque ouverture : sans cela, une application
      // installée sur l'écran d'accueil peut rester des jours sur une version
      // ancienne, faute de navigation qui déclenche le contrôle automatique.
      reg.update().catch(() => {});
    } catch (err) {
      console.warn('SW non enregistré :', err);
    }
  });

  let rechargement = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Uniquement après une vraie mise à jour acceptée par l'utilisateur : à la
    // première installation il n'y avait pas de contrôleur, et recharger la
    // page à ce moment-là serait gratuit et déroutant.
    if (!hadController || rechargement) return;
    rechargement = true;
    location.reload();
  });
}
