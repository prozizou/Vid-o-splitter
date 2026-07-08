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

## Limites connues

- Core mono-thread → plus lent que le multi-thread. Préférez des clips courts.
- Réencodage H.264/AAC systématique (les coupes ne tombent pas sur des
  images-clés) : c'est l'étape la plus lente.
- Beaucoup de segments = traitement lourd : augmentez « silence minimum ».
- Les gros fichiers sont limités par la mémoire du navigateur (~2 Go côté WASM).
