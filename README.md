# Studio Video — boite a outils 100 % locale (v6.2)

Quatre outils dans une seule PWA. Aucun fichier ne quitte l'appareil.

| Page | Outil | Fichier |
|---|---|---|
| `/` | Menu d'accueil | `index.html` |
| `/splitter` | **Splitter** — supprime les silences (moteur turbo WebCodecs) | `app.js` + `turbo.js` + `silence.js` |
| `/echo` | **Echo Remover** — attenue l'echo / la reverberation d'une piece | `echo.js` + `echo-worker.js` |
| `/studio` | **Audio Studio** — porte de bruit, EQ 7 bandes, compresseur, normalisation LUFS | `studio.js` + `loudness.js` |
| `/lyrics` | **Lyrics** — synchronisation de paroles au toucher, export .lrc / .srt | `lyrics.js` |

(Les URL n'ont pas d'extension : `cleanUrls` est actif sur Vercel.)

`media.js` est la boite a outils partagee : decodage audio universel (fichiers
audio OU video), export WAV, conversion M4A, reinjection de l'audio traite dans
la video d'origine (`-c:v copy`, l'image n'est jamais reencodee), et une FFT
autonome pour le traitement spectral.

### Modules purs (testes)

Trois modules ne touchent ni au DOM ni aux API du navigateur, et sont couverts
par `npm test` (lanceur integre de Node, aucune dependance a installer) :

| Module | Role |
|---|---|
| `silence.js` | seuil adaptatif, detection des silences, decoupage en parties |
| `loudness.js` | mesure de sonie BS.1770-4 (ponderation K + portes) et limiteur |
| `sfx.js` | synthese des sons de transition, ecriture WAV, fondus |

    npm test        # 66 tests, ~1 s

## Apercu des coupes

Bouton **« Apercu des coupes »** sur `/splitter` : l'enveloppe RMS est calculee
UNE fois puis mise en cache. Bouger la sensibilite, la duree de silence ou la
marge redessine l'apercu instantanement — plus besoin de lancer un traitement
complet de plusieurs minutes pour decouvrir qu'un reglage etait mauvais. Le
traitement reutilise ensuite l'analyse deja faite : le fichier n'est decode
qu'une seule fois.

Le graphique montre l'enveloppe du son, la **courbe de seuil** (qui est
adaptative, voir plus bas) et les zones conservees, avec le compte de segments,
la duree finale et le nombre de parties.

## Detection des silences (silence.js)

Le seuil n'est plus unique pour tout le fichier : il est recalcule par blocs de
~8 s puis interpole, et borne autour du seuil global pour qu'un bloc aberrant
ne derape pas. Une video dont le bruit de fond change en cours de route
(fenetre ouverte, changement de piece) n'est donc plus mal segmentee de bout en
bout. Une hysterese legere (0,8) evite le papillonnement d'un signal qui frole
le seuil ; la temporisation, elle, reste assuree par « silence minimum ».

## Transitions du Splitter (v6.1)

Panneau **Transitions** en haut de `/splitter.html`. Fichier : `sfx.js`.

**Fondu au noir** (0 a 200 ms, defaut 60 ms) de part et d'autre de chaque
raccord. Jamais applique au tout debut ni a la toute fin du film ; applique aux
coutures entre parties, ce qui masque les seams. Bride a `duree_segment / 2.5`
pour qu'un segment court ne soit pas devore par son propre fondu.

**Son de transition** : Clic leger, Souffle doux, Whoosh, Tic montant. Aucun
fichier audio n'est telecharge, tout est synthetise (bruit deterministe, pas de
`Math.random` : le rendu est identique a chaque passage). Volume reglable, -18 dB
par defaut. Bouton d'ecoute pour choisir sans rien traiter. Le son demarre 30 %
avant le raccord : l'oreille l'entend annoncer la coupe.

Les deux moteurs produisent les memes coupes, les memes fondus et les memes
bruitages :
- **turbo** : fondu par `OffscreenCanvas` (seules les images du fondu sont
  redessinees), son melange dans le PCM apres l'egaliseur.
- **ffmpeg** : filtres `fade` par segment, et un « lit » WAV de la duree de la
  partie contenant deja les bruitages, mixe via `amix=normalize=0` (la voix
  n'est pas baissee). Repli automatique sans bruitage si `amix` echoue.

Le son passe apres l'egaliseur : il n'est jamais colore par les reglages de voix.

**Une difference subsiste**, et elle est assumee : la case « egaliser le volume
entre les passages » applique `dynaudnorm` cote ffmpeg et un compresseur Web
Audio cote turbo. Le rendu n'est donc pas identique au decibel pres entre les
deux moteurs sur cette option precise. Les bandes de l'egaliseur, elles, sont
equivalentes (biquad peaking de meme frequence, meme Q, meme gain).

## Echo Remover
Le calcul tourne dans un **Worker** (`echo-worker.js`) : l'interface reste
fluide, et surtout le traitement n'est plus bride quand l'onglet passe en
arriere-plan (`setTimeout` y est limite a 1 s/tick, ce qui arretait quasiment
le traitement des qu'on changeait d'application). Les canaux audio sont
*transferes* au worker, sans copie. Repli automatique en page si les Workers de
type module sont indisponibles.

Soustraction spectrale trame par trame (STFT 1024/256, fenetre de Hann) :
l'estimation de la reverberation tardive (moyenne exponentielle reglee par la
« taille de piece ») est soustraite du spectre, avec plancher, lissage temporel
et frequentiel contre le bruit musical, et porte douce optionnelle entre les
phrases. Comparaison avant/apres integree.

## Audio Studio
Chaine : porte de bruit maison (attaque 3 ms, relache 120 ms, jamais de mute
brutal) -> coupe-bas -> EQ 7 bandes -> compresseur -> normalisation vers une
cible LUFS (-16 streaming / -14 reseaux sociaux) avec limiteur a -1 dBFS.
**Pre-ecoute en direct** des 10 premieres secondes avec la meme chaine, pour
regler avant de traiter tout le fichier. Prereglages : Voix, Podcast, Musique,
Reparation.

### Mesure de sonie (loudness.js)
La mesure suit **ITU-R BS.1770-4 / EBU R128** : ponderation K (plateau aigu +
passe-haut RLB), blocs de 400 ms a 75 % de recouvrement, porte absolue a
-70 LUFS puis porte relative a -10 LU. C'est ce qui compte pour une voix
parlee : elle est pleine de silences, qui tirent un RMS vers le bas sans rien
changer a la sonie percue. L'ancienne approximation (RMS sous-echantillonne)
pouvait se tromper de plusieurs decibels sur ce cas precis.

Etalonnage verifie par les tests : un sinus mono de 1 kHz a -23 dBFS RMS se
mesure a -23,0 LUFS (la constante -0,691 de la norme annule exactement le gain
de la ponderation K a cette frequence).

Le **limiteur** a une anticipation de 5 ms et une remontee de 100 ms : la
reduction n'intervient qu'autour des cretes. L'ancienne version se contentait
de plafonner le gain global, si bien qu'un seul transitoire empechait
d'atteindre la cible sur tout le fichier.

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

Le decoupage depend du MOTEUR, parce que ses deux raisons d'etre n'ont pas le
meme poids selon la vitesse de rendu.

|  | turbo | compatible (ffmpeg) |
|---|---|---|
| Decoupage automatique au-dela de | 20 min | 5 min |
| Duree visee d'une partie | 10 min | 4 min |
| Plafond de segments par partie | aucun | 40 |

ffmpeg encode a ~0,2x temps reel : sur une heure de video, pouvoir reprendre
apres un plantage est une necessite, et son `filter_complex` grossit de deux
branches par segment conserve — au-dela d'une quarantaine, la commande devient
ingerable.

Le moteur turbo traite la meme video en quelques secondes, et un segment n'y
coute rien de structurel. En revanche CHAQUE frontiere de partie a un cout
reel : un flush du decodeur (donc un groupe d'images a rejouer), un
remultiplexage, une couture de plus a l'assemblage. C'est d'ailleurs de ces
frontieres que venaient la plupart des defauts corriges dans les versions
recentes. On en fait donc le moins possible.

Le plafond de 40 segments etait auparavant applique aux deux moteurs : c'est
lui — et non la duree — qui decoupait une video de 10 min riche en segments en
plusieurs parties.

- **Automatique** : selon le tableau ci-dessus.
- **2 min** : telephone a memoire limitee.
- **Une seule partie** : impose le fichier entier d'un seul tenant.

### Dependances du build
Aucun `npm install` : `build.sh` telecharge les tarballs npm et copie ce dont
il a besoin dans `dist/vendor/`. Les versions **et les empreintes sha512** sont
figees dans `vendor.lock` — un tarball modifie en amont fait echouer le build
au lieu d'etre servi aux utilisateurs.

Auparavant mp4box et mp4-muxer etaient demandes en `latest` : chaque
deploiement pouvait donc changer sans qu'un seul commit n'ait bouge. (Effet de
bord constate : mp4box 2.x ne livre plus le bundle UMD `mp4box.all.js`, si bien
que la branche `latest` echouait systematiquement et retombait en silence sur
la 0.5.2. C'est cette version qui tourne reellement, elle est desormais
epinglee explicitement.)

Le build echoue bruyamment si un fichier attendu manque dans `dist/`.

## Confidentialite : ce qui la garantit techniquement

- **Content-Security-Policy** avec `default-src 'self'` et `connect-src 'self'`
  (`vercel.json`) : le navigateur lui-meme interdit toute requete sortante vers
  un autre domaine. La promesse « rien ne quitte l'appareil » n'est plus une
  politique, c'est une contrainte verifiable dans les outils de developpement.
- Aucun script inline (d'ou `sw-register.js`), aucune police ni image distante,
  aucune mesure d'audience.
- `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
  `Permissions-Policy` refusant camera, micro et geolocalisation.

## Mises a jour et cache (important)

La version du service worker est une **empreinte du contenu**, calculee par
`build.sh` et injectee dans `sw.js`. Des qu'un seul fichier servi change,
l'empreinte change, donc `sw.js` change, donc le navigateur voit une vraie mise
a jour : `install` puis `activate` s'executent et l'ancien cache est purge.

Ce numero etait auparavant ecrit a la main, et c'etait un piege : deux
livraisons ont modifie six fichiers JS sans qu'il bouge. `sw.js` restant
identique a l'octet pres, le navigateur ne declenchait **aucune** mise a jour,
la purge n'avait jamais lieu, et les utilisateurs continuaient de recevoir
l'ancien code depuis leur cache — sans le moindre signe.

Deux garde-fous accompagnent ce mecanisme :

- **Pastille de version** en bas de chaque page. Elle affiche la version
  REELLEMENT chargee dans le navigateur, pas celle qui est en ligne. En cas de
  doute (« ma correction est-elle deployee ? »), comparez-la au dernier build :
  si elles different, c'est le cache local, pas le deploiement.
- **Bandeau « Nouvelle version disponible »** au lieu d'un `skipWaiting()`
  automatique. Prendre la main au milieu d'un traitement d'une heure
  remplacerait les fichiers sous les pieds de l'onglet en cours : la mise a
  jour n'est appliquee que lorsque l'utilisateur clique.

Le build echoue si l'empreinte n'a pas ete substituee.

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
