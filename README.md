# 🪓 Video Silence Cutter (v2 — multi-thread)

Outil 100 % navigateur qui détecte et supprime les silences d'une vidéo, puis
réassemble une vidéo compacte. Aucun serveur de traitement : tout se passe dans
le navigateur (Web Audio API pour la détection + ffmpeg.wasm pour le montage).

## Ce qui change dans la v2

- **Multi-thread** : ffmpeg utilise tous les cœurs du téléphone -> beaucoup plus
  rapide sur les vidéos longues. Bascule automatique en mono-thread si
  l'isolation cross-origin n'est pas disponible.
- **Auto-hébergement de ffmpeg** : les fichiers ffmpeg ne sont plus chargés
  depuis un CDN au runtime. Ils sont téléchargés **pendant le build Vercel**
  (côté serveur) et servis depuis votre propre domaine (/vendor/...). Cela :
  - active le multi-thread (en-têtes COOP/COEP, incompatibles avec les CDN) ;
  - supprime les pannes de CDN qu'on subissait (404, worker cross-origin...) ;
  - évite tout upload manuel de 30 Mo depuis le téléphone.

## Structure

    index.html   -> page
    style.css    -> styles
    app.js       -> logique (module ES, imports depuis /vendor)
    build.sh     -> telecharge ffmpeg dans dist/vendor pendant le build
    vercel.json  -> build + outputDirectory + en-tetes COOP/COEP
    package.json
    README.md

Au build, dist/ contient la page ET dist/vendor/ avec :
ffmpeg/ (classe + worker), util/, core-st/ (mono-thread), core-mt/ (multi-thread).

## Deployer sur Vercel

Le vercel.json configure tout (build + en-tetes). Il suffit d'importer le depot :

1. Poussez ces fichiers a la racine d'un depot GitHub.
2. Sur https://vercel.com -> Add New -> Project -> Import.
3. Framework Preset : Other. Ne touchez pas aux commandes : Vercel lit
   vercel.json (Build = bash build.sh, Output = dist).
4. Deploy. Le build telecharge ffmpeg puis publie le site.

Verifiez dans les logs de build la ligne « Contenu de dist/vendor » : les
fichiers ffmpeg-core.wasm (core-st ET core-mt) doivent apparaitre.

### Verifier que le multi-thread est actif
Une fois en ligne, ouvrez la console et tapez : crossOriginIsolated
- true  -> multi-thread actif (journal : « Mode multi-thread active »).
- false -> en-tetes COOP/COEP non appliques ; l'app tourne en mono-thread.
  Verifiez que vercel.json est bien a la racine et redeployez.

## Reglages (curseurs)

- Sensibilite : plus haut = garde les passages parles plus doux.
- Silence minimum : un blanc plus court n'est pas coupe. Sur une video
  longue, MONTEZ-LE (0,5-1 s) pour reduire le nombre de segments.
- Marge conservee : coussin de temps avant/apres chaque phrase.

## Conseils pour les videos longues (votre cas d'usage)

1. Le multi-thread accelere l'encodage d'un facteur ~= nombre de coeurs, mais
   reencoder plusieurs dizaines de minutes reste intensif. Gardez le telephone
   BRANCHE.
2. Augmentez « Silence minimum » pour limiter le nombre de segments.
3. La memoire du navigateur (~2-4 Go) est la vraie limite : une video tres
   longue et tres lourde peut echouer. Dans ce cas, decoupez-la en 2-3 parties.
4. Faites un premier essai sur un extrait court pour valider vos reglages.


## Installer comme application (PWA)

Une fois le site en ligne sur Vercel (HTTPS) :

- Android / Chrome : menu ... -> « Installer l'application » (ou « Ajouter a
  l'ecran d'accueil »). Une icone adaptative apparait, l'app s'ouvre en plein
  ecran, sans barre de navigateur.
- iOS / Safari : bouton Partager -> « Sur l'ecran d'accueil ».
- Bureau / Chrome-Edge : icone d'installation dans la barre d'adresse.

Grace au service worker, l'app fonctionne hors-ligne des la 2e ouverture
(le moteur ffmpeg est mis en cache au premier traitement).

## Confidentialite

Tout reste sur l'appareil : la video n'est jamais envoyee sur un serveur.
Seuls les fichiers du moteur ffmpeg sont servis par votre domaine Vercel.
