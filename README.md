# Studio Video — Splitter 100 % local (v6.2)

Un seul outil dans une PWA. Aucun fichier ne quitte l'appareil.

| Page | Outil | Fichier |
|---|---|---|
| `/` | Menu d'accueil | `index.html` |
| `/splitter` | **Splitter** — supprime les silences (moteur turbo WebCodecs) | `app.js` + `turbo.js` + `silence.js` |

(Les URL n'ont pas d'extension : `cleanUrls` est actif sur Vercel.)

`media.js` est la boite a outils partagee par le Splitter : formatage
(taille/duree), sondage de duree sans decodage complet, et les outils du
journal (copie / enregistrement).

> Echo Remover, Audio Studio et Lyrics ont ete retires (v6.3) pour ne garder
> que le Splitter. Leur code (`echo.js`, `echo-worker.js`, `studio.js`,
> `loudness.js`, `lyrics.js`) a ete supprime, ainsi que les exports de
> `media.js` qui ne servaient qu'a eux (decodage AudioBuffer generique, export
> WAV, reinjection ffmpeg, FFT).

### Modules purs (testes)

Deux modules ne touchent ni au DOM ni aux API du navigateur, et sont couverts
par `npm test` (lanceur integre de Node, aucune dependance a installer) :

| Module | Role |
|---|---|
| `silence.js` | seuil adaptatif, detection des silences, decoupage en parties |
| `sfx.js` | synthese des sons de transition, ecriture WAV, fondus |

    npm test        # 61 tests, ~0,3 s

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

## Réseau social visé (conversion + qualité)

Sélecteur **Réseau social visé** sur `/splitter` : TikTok, Instagram/Facebook
Reels, YouTube Shorts, WhatsApp (statut/message), Facebook (publication
horizontale), ou « Conserver la source ». Chaque préréglage fixe la
résolution/cadence cible **et** suggère une qualité vidéo (CRF) adaptée —
WhatsApp recompressant fortement au partage, son préréglage vise un fichier
plus compact ; TikTok tolère de gros fichiers, le sien vise une meilleure
qualité. La qualité suggérée est appliquée au changement de préréglage, mais
reste ajustable ensuite via le curseur « Qualité vidéo ».

La conversion se fait EN MEME TEMPS que le rendu, en une seule passe : chaque
image conservée est mise à l'échelle « remplir » (cover) sur la toile hors
écran déjà utilisée pour les fondus, puis rognée au centre. Le rapport
d'aspect est préservé — un plan paysage devient un portrait cadré au centre,
sans déformation ni bandes noires. On ne sur-échantillonne jamais la cadence :
viser 30 im/s plafonne à 30, une source plus lente reste à sa cadence.
« Conserver la source » retablit l'ancien comportement (résolution et cadence
d'origine, seul le rognage au multiple de 16 exigé par le matériel s'applique).

Une estimation de taille (« ≈ X Mo estimés… ») s'affiche sous le sélecteur dès
qu'un aperçu des coupes a été calculé, et se met à jour en direct avec la
qualité vidéo ou le préréglage — sans rien recalculer côté décodage. Elle
avertit si la taille dépasse le repère indicatif du réseau visé (WhatsApp
uniquement pour l'instant, seul repère de taille suffisamment stable pour être
affiché ; les autres réseaux n'imposent pas de limite pratique à ces
résolutions).

## Rendu final : assemblage automatique

L'ancien bouton **« Réunir toutes les parties »** a été retiré : dès que
toutes les parties d'une vidéo sont prêtes, l'assemblage final se fait
**automatiquement**, sans action de l'utilisateur (copie directe des flux déjà
encodés, sans réencodage — comme avant). Le cas le plus courant (une vidéo de
moins de 20 min turbo, une seule partie) saute même cette étape : la partie
unique EST déjà la vidéo finale.

Un encart **« Rendu final »** apparaît alors au-dessus de l'aperçu vidéo,
détaillant le réseau visé, le moteur utilisé, la résolution/cadence
réellement appliquée, la qualité vidéo, la durée et **la taille réelle du
fichier** — avec le même avertissement de dépassement que l'estimation, cette
fois basé sur la taille exacte.

Une reprise de session (page rechargée) dont toutes les parties étaient déjà
prêtes déclenche aussi cet assemblage automatique, sans qu'il soit nécessaire
de recliquer sur « Traiter ».

## Voix : debit audio

Le moteur turbo re-encode l'audio en AAC (la source etant presque toujours
DEJA de l'AAC, c'est un encodage **en tandem**). A 128 kb/s, la 2e generation
amplifiait le pre-echo du MDCT et donnait a la voix un timbre « metallique /
robotique ». Le debit est desormais plus genereux et proportionnel au nombre
de canaux (≈160 kb/s mono, ≈192 kb/s stereo) : les artefacts disparaissent,
pour un surcout de taille negligeable sur une piste parlee.

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

### Découpage du moteur (turbo-*.js)

`turbo.js` n'est plus qu'une **façade** qui ré-exporte l'API publique
(`turboSupported`, `turboAnalyze`, `turboRenderAll`, `turboJoin`, `turboMerge`).
Le moteur est réparti en modules à responsabilité unique, pour qu'on puisse en
lire un sans tout tenir en tête :

| Module | Rôle |
|---|---|
| `turbo-util.js`   | constantes de temps, détection WebCodecs, plomberie async (temporisation, barrières de file de codec, collecteur d'erreurs) |
| `turbo-mp4.js`    | chargement mp4box/mp4-muxer, descriptions de codec, flux d'échantillons paginé, primer de groupe d'images |
| `turbo-video.js`  | configuration de l'encodeur vidéo (débit, cadence, alignement 16, choix d'une config H.264 supportée) |
| `turbo-audio.js`  | analyse de sonie, filtre anti-sifflement, égaliseur voix |
| `turbo-render.js` | le cœur : la passe unique décodage → rendu → encodage |
| `turbo-join.js`   | réunion des parties et fusion de fichiers, sans réencodage |

`app.js` et les tests continuent d'importer depuis `./turbo.js` uniquement :
la surface publique n'a pas changé. Les six fichiers sont servis à plat (comme
tout le shell), donc ils entrent dans l'empreinte de version du service worker
(`build.sh`) : modifier un module suffit à déclencher une vraie mise à jour.

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
