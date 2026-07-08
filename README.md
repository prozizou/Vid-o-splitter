# 🪓 Video Silence Cutter

Outil 100 % navigateur qui détecte et supprime les silences d'une vidéo.
Aucun serveur de traitement : tout se passe dans le navigateur du visiteur
(Web Audio API pour la détection + ffmpeg.wasm pour le découpage).

## Structure du projet

```
vercel-silence-cutter/
├── index.html      → la page
├── style.css       → les styles
├── app.js          → toute la logique (module ES)
├── vercel.json     → config Vercel (statique)
└── README.md
```

C'est un site **100 % statique** : pas de build, pas de backend.

## Déployer sur Vercel

### Option A — via GitHub (recommandé)
1. Créez un dépôt GitHub et poussez ces fichiers à la racine.
2. Sur https://vercel.com → **Add New → Project → Import** votre dépôt.
3. Framework Preset : **Other** (aucun build). Laissez les champs vides.
4. **Deploy**. Vercel vous donne une URL en `https://...vercel.app`.

### Option B — via la CLI Vercel
```bash
npm i -g vercel        # une seule fois
cd vercel-silence-cutter
vercel                 # déploiement de preview
vercel --prod          # déploiement en production
```

### Option C — glisser-déposer
Sur le tableau de bord Vercel, vous pouvez aussi déposer directement le dossier.

## Pourquoi ça marche sur Vercel

- Vercel sert le site en **HTTPS**, ce qui autorise les modules ES et
  ffmpeg.wasm (impossible en `file://`).
- On utilise le **core mono-thread** de ffmpeg, qui ne nécessite PAS
  les en-têtes `Cross-Origin-Opener-Policy` / `Embedder-Policy`.
  ⚠️ N'ajoutez donc PAS ces en-têtes : ils bloqueraient le chargement
  de ffmpeg depuis le CDN (unpkg / esm.sh).
- ffmpeg.wasm (~30 Mo) est téléchargé une fois puis mis en cache par le
  navigateur.

## Réglages (curseurs dans l'interface)

- **Sensibilité** : plus haut = garde les passages parlés plus doux.
- **Silence minimum** : un blanc plus court n'est pas coupé.
- **Marge conservée** : petit coussin de temps avant/après chaque phrase,
  pour ne pas rogner le début/fin des mots.

## ⚠️ Fiabilité & vitesse sur mobile (à lire si ça « bloque »)

Le traitement se fait entièrement dans le navigateur du téléphone, avec un
ffmpeg **mono-thread** (le seul qui fonctionne sans configuration serveur
spéciale). Conséquences :

- **Le chargement peut se figer** si le worker ffmpeg ne s'initialise pas
  (limitation connue du chargement via CDN sur certains navigateurs mobiles).
  Le code journalise désormais chaque étape ([1/4]…[4/4]) et abandonne avec un
  message clair au lieu de tourner indéfiniment. Regardez la dernière ligne du
  journal pour savoir OÙ ça coince.
- **L'encodage est lent** : réencoder une vidéo de plusieurs minutes découpée
  en dizaines/centaines de segments peut prendre de longues minutes, voire
  saturer la mémoire du navigateur (limite ~2 Go côté WASM).

### Bons réflexes
1. **Testez d'abord un clip court** (10–20 s) pour valider toute la chaîne
   avant de lancer une vidéo de 5 min.
2. Augmentez « Silence minimum » (ex. 0,5–0,8 s) pour réduire le nombre de
   segments : moins de segments = encodage beaucoup plus léger.
3. Gardez le téléphone branché : l'encodage est intensif (la batterie chute).

### Pour une vraie vitesse (version multi-thread)
La version multi-thread de ffmpeg utilise tous les cœurs du téléphone, mais
elle exige que le site soit « cross-origin isolated ». Sur Vercel il faut :

1. Ajouter ces en-têtes dans `vercel.json` :
   ```json
   {
     "headers": [{
       "source": "/(.*)",
       "headers": [
         { "key": "Cross-Origin-Opener-Policy",   "value": "same-origin" },
         { "key": "Cross-Origin-Embedder-Policy",  "value": "require-corp" }
       ]
     }]
   }
   ```
2. **Auto-héberger** les fichiers ffmpeg (le CDN est bloqué par ces en-têtes) :
   déposez `ffmpeg-core.js`, `ffmpeg-core.wasm`, `ffmpeg-core.worker.js` et le
   `worker.js` de `@ffmpeg/ffmpeg` dans un dossier `public/ffmpeg/`, puis
   chargez-les via des chemins locaux (`/ffmpeg/...`) au lieu des URL CDN.

C'est plus rapide mais plus lourd à mettre en place. Dites-le-moi si vous
voulez que je prépare cette variante clé en main.

## Limites connues

- Core mono-thread → plus lent que le multi-thread. Préférez des clips courts.
- Réencodage H.264/AAC systématique (les coupes ne tombent pas sur des
  images-clés) : c'est l'étape la plus lente.
- Beaucoup de segments = traitement lourd : augmentez « silence minimum ».
- Les gros fichiers sont limités par la mémoire du navigateur (~2 Go côté WASM).
