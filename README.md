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

## v5 : moteur TURBO (WebCodecs)

Le goulot d'etranglement n'etait pas le decoupage : c'etait **x264 compile en
WebAssembly**, qui encode a ~0,2x le temps reel. Une heure de video = cinq heures
d'attente, meme en multi-thread.

Le moteur **Turbo** confie l'encodage a la **puce video du telephone** via
WebCodecs : 10x a 50x plus rapide, et l'encodeur materiel chauffe moins la batterie.

    mp4box.js  ->  VideoDecoder (materiel)
                       |
                       v  (les GOP entierement silencieux ne sont JAMAIS decodes)
                   VideoEncoder (materiel)  ->  mp4-muxer  ->  partie MP4
                   AudioDecoder -> egaliseur (OfflineAudioContext) -> AudioEncoder

Une seule passe sur le fichier, dans l'ordre des parties. La reunion finale
re-empile les paquets deja encodes : aucune image n'est reencodee.

### Le moteur « Compatible » reste la
Selecteur **Moteur** en haut. Turbo par defaut. On retombe automatiquement sur
ffmpeg.wasm si :
- WebCodecs est absent (vieux navigateur, certains iOS) ;
- le fichier n'est pas un MP4/MOV lisible par mp4box (MKV, WebM, AVI...) ;
- aucun encodeur H.264 materiel n'est expose.

Le repli est silencieux et journalise. Si des parties ont deja ete produites en
Turbo, on ne bascule pas en cours de route (les flux seraient incompatibles) :
l'erreur est affichee et les parties deja pretes restent enregistrables.

### Egaliseur en mode Turbo
Les filtres `equalizer` de ffmpeg sont remplaces par des **BiquadFilterNode**
natifs dans un `OfflineAudioContext` (peaking x7 + coupe-bas + compresseur).
Meme resultat, calcul quasi instantane. La case « phase lineaire » ne concerne
que le moteur ffmpeg.

### Parties independantes
Chaque partie est encodee en MP4 autonome, apparait avec son apercu et son
bouton d'enregistrement des qu'elle est prete, pendant que les suivantes
continuent. Le bouton « Reunir toutes les parties » assemble le MP4 final.

### Traitement long / arriere-plan
Un navigateur **ne peut pas** poursuivre un encodage si l'application est fermee.
Ce qui est fait a la place :
- **Wake Lock** : l'ecran ne se met plus en veille.
- La boucle d'analyse utilise `MessageChannel` (non bride) au lieu de
  `setTimeout` : l'onglet en arriere-plan continue a pleine vitesse.
- **Chaque partie terminee est enregistree dans IndexedDB.** Onglet plante,
  memoire saturee, app fermee : rechargez le meme fichier, un bandeau propose
  de reprendre.
- **Pause** propre apres la partie en cours, et **notification** a la fin.

### Progression
Barre + pourcentage, phase en cours (« Partie 3/12 »), temps restant estime et
vitesse reelle (`12.4x` en Turbo, `0.2x` en Compatible).

### Reglage « Duree des parties »
- **Automatique** : une seule partie sous 5 min, parties de 4 min au-dela.
- **2 min** : telephone a memoire limitee.
- **Une seule partie** : pour les clips courts.

### Dependances ajoutees au build
`mp4box` (demultiplexage) et `mp4-muxer` (multiplexage), telechargees dans
`dist/vendor/` pendant le build Vercel, en meme temps que ffmpeg. Le build
echoue bruyamment si l'un des deux manque.

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
