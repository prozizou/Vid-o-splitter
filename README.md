# Studio Video — boite a outils 100 % locale (v6)

Quatre outils dans une seule PWA. Aucun fichier ne quitte l'appareil.

| Page | Outil | Fichier |
|---|---|---|
| `/` | Menu d'accueil | `index.html` |
| `/splitter.html` | **Splitter** — supprime les silences (moteur turbo WebCodecs) | `app.js` + `turbo.js` |
| `/echo.html` | **Echo Remover** — attenue l'echo / la reverberation d'une piece | `echo.js` |
| `/studio.html` | **Audio Studio** — porte de bruit, EQ 7 bandes, compresseur, normalisation LUFS | `studio.js` |
| `/lyrics.html` | **Lyrics** — synchronisation de paroles au toucher, export .lrc / .srt | `lyrics.js` |

`media.js` est la boite a outils partagee : decodage audio universel (fichiers
audio OU video), export WAV, conversion M4A, reinjection de l'audio traite dans
la video d'origine (`-c:v copy`, l'image n'est jamais reencodee), et une FFT
autonome pour le traitement spectral.

## Echo Remover
Soustraction spectrale trame par trame (STFT 1024/256, fenetre de Hann) :
l'estimation de la reverberation tardive (moyenne exponentielle reglee par la
« taille de piece ») est soustraite du spectre, avec plancher, lissage temporel
et frequentiel contre le bruit musical, et porte douce optionnelle entre les
phrases. Comparaison avant/apres integree.

## Audio Studio
Chaine : porte de bruit maison (attaque 3 ms, relache 120 ms, jamais de mute
brutal) -> coupe-bas -> EQ 7 bandes -> compresseur -> normalisation vers une
cible LUFS (-16 streaming / -14 reseaux sociaux) avec limiteur de crete a
-1 dBFS. **Pre-ecoute en direct** des 10 premieres secondes avec la meme chaine,
pour regler avant de traiter tout le fichier. Prereglages : Voix, Podcast,
Musique, Reparation.

## Lyrics
La chanson joue, on tape le gros bouton au debut de chaque ligne (ou barre
espace au clavier). Correction ligne par ligne, import .lrc existant,
sauvegarde automatique de la session, export **.lrc** (lecteurs de musique)
et **.srt** (sous-titres video).

---

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
