/* =============================================================================
   TURBO · CONFIGURATION DE L'ENCODEUR VIDÉO
   -----------------------------------------------------------------------------
   Tout ce qui décide COMMENT encoder la vidéo : débit cible, cadences standard
   reconnues par le matériel, alignement des dimensions sur 16, et le choix d'une
   config H.264 réellement supportée (avec repli matériel -> logiciel signalé).
   Fonctions pures ou quasi pures : aucune dépendance interne.
   ========================================================================== */

const CODEC_CANDIDATES = ['avc1.640033', 'avc1.640028', 'avc1.4d0028', 'avc1.42e01e'];

function bitrateFor(w, h, fps, crf) {
  // 0,08 bit/pixel à CRF 23, doublé tous les 6 points de CRF en moins.
  const bpp = 0.08 * Math.pow(2, (23 - crf) / 6);
  return Math.max(400_000, Math.round(w * h * fps * bpp));
}

// Frequences que les encodeurs MATERIELS reconnaissent generalement. Une
// video de telephone a debit variable (l'appareil freine la capture sur une
// image statique, pour l'autonomie) donne une frequence MOYENNE souvent non
// standard — 56 im/s par exemple — alors que le flux reel ne depasse jamais
// 60. Demander cette moyenne telle quelle a l'encodeur materiel peut suffire
// a faire rejeter TOUS les candidats de codec, alors qu'une frequence
// standard proche serait acceptee sans probleme.
//
// C'est un champ sans consequence sur le rendu : `framerate` de
// VideoEncoderConfig ne sert qu'au controle de debit, jamais a caler le
// calendrier reel des images — chaque VideoFrame garde l'horodatage qu'on lui
// donne dans emit(). L'arrondir ne ralentit ni n'accelere rien a l'ecran.
const STD_FPS = [24, 25, 30, 50, 60];
export function nearestStdFps(fps) {
  return STD_FPS.reduce((best, f) => (Math.abs(f - fps) < Math.abs(best - fps) ? f : best), STD_FPS[0]);
}

// Cadence maximale du rendu turbo. Une video parlee (le public vise par cet
// outil : silences a couper, podcasts, vlogs) n'apporte rien de plus a 50 ou
// 60 im/s qu'a 30 — l'oeil ne gagne rien sur un plan quasi fixe. En revanche
// une cadence source elevee ou non standard (56 par exemple, une MOYENNE sur
// un flux a debit variable) coute deux fois plus d'images a encoder, et peut
// a elle seule faire echouer l'essai materiel (voir nearestStdFps). Plafonner
// ici, avant l'encodage, regle les deux problemes a la fois : moitie moins
// d'images a passer dans l'encodeur (le poste le plus couteux, surtout en
// repli logiciel), et une cadence toujours standard.
const MAX_FPS = 30;

/**
 * Arrondit une dimension au multiple de 16 INFERIEUR, plancher a 16.
 *
 * Beaucoup d'encodeurs H.264 MATERIELS (Android/MediaCodec en tete) exigent
 * des dimensions multiples de 16 : une resolution native de telephone en
 * portrait (1080×2436, par exemple) ne l'est presque jamais. On rogne vers le
 * BAS plutot que de padder vers le haut : un rognage de quelques pixels
 * (moins de 16, invisible) ne fait que retirer un peu de contenu existant, un
 * agrandissement inventerait une bordure noire a la place.
 */
export function align16(n) {
  return Math.max(16, Math.floor(n / 16) * 16);
}

/**
 * Choisit une configuration d'encodeur H.264 supportée.
 *
 * Repli SILENCIEUX a dessein detecte par l'appelant, pas ici : quand AUCUN
 * candidat ne supporte `accel` (typiquement 'prefer-hardware'), on relache la
 * contrainte et on relance avec 'no-preference' — le navigateur choisit alors
 * librement, y compris un encodeur logiciel.
 *
 * Ce repli-la ne leve JAMAIS d'exception : il aboutit presque toujours a une
 * config valide, donc `renderAllOnce` ne voit jamais d'echec et ne le
 * remonte jamais a `turboRenderAll`, qui est le seul endroit qui journalise
 * « Codec matériel en échec ». Resultat observe : un rendu qui tourne a
 * 0,4x sur une video de 10 min, sans le moindre message d'alerte avant la fin
 * — l'appareil n'a simplement pas d'encodeur materiel pour cette resolution
 * (frequente au-dela de 1080p, ou en orientation portrait sur certains
 * telephones), et rien ne le signalait avant que l'encodage entier soit fini.
 *
 * `downgraded` permet a l'appelant de le dire tout de suite, avant la
 * premiere image encodee, plutot que de laisser deviner via la vitesse
 * mesuree en fin de traitement.
 * @returns { config, downgraded } — downgraded = vrai si AUCUN essai materiel
 *   (frequence source comprise ou arrondie a une valeur standard) n'a abouti.
 */
async function pickVideoConfig(w, h, fps, crf, accel = 'prefer-hardware') {
  const base = {
    width: w, height: h,
    bitrate: bitrateFor(w, h, fps, crf),
    avc: { format: 'avc' },
    // Un profil High (avc1.640033, notre 1er candidat) autorise les images B,
    // que certains encodeurs MATERIELS utilisent par defaut pour la
    // compression. Une image B se decode APRES des images qui la suivent a
    // l'ecran : l'encodeur doit alors emettre ses paquets dans un ordre de
    // DECODAGE distinct de l'ordre de PRESENTATION. `mp4-muxer` (addVideoChunk)
    // suppose au contraire un flux SANS reordonnancement, et rejette tout
    // paquet dont l'horodatage recule :
    //   Timestamps must be monotonically increasing (DTS went from X to Y)
    // 'realtime' est le mecanisme standard WebCodecs pour desactiver le
    // fenetrage/reordonnancement en B : chaque trame ressort dans l'ordre ou
    // elle a ete soumise. Cout : une compression legerement moins efficace, un
    // echange largement justifie face a l'echec observe — une erreur de
    // MULTIPLEXAGE, pas de decodage/encodage, donc turboRenderAll() ne la
    // reconnaissait meme pas comme un probleme de codec : `dejaFait || !codec`
    // rejetait aussitot l'erreur SANS tenter le repli logiciel. Le message
    // « ⚠️ Codec matériel en échec » n'apparaissait donc jamais ; seul
    // « ⚠️ Moteur turbo interrompu » remontait, en echec sec.
    latencyMode: 'realtime',
  };
  const stdFps = nearestStdFps(fps);
  // 1) frequence source telle quelle ; 2) meme materiel mais frequence
  // arrondie a une valeur standard (souvent suffisant, voir STD_FPS) ; 3) on
  // laisse le navigateur choisir librement, y compris un encodeur logiciel.
  const attempts = [{ framerate: fps, hardwareAcceleration: accel }];
  if (stdFps !== fps) attempts.push({ framerate: stdFps, hardwareAcceleration: accel });
  attempts.push({ framerate: fps, hardwareAcceleration: 'no-preference' });

  for (const attempt of attempts) {
    for (const codec of CODEC_CANDIDATES) {
      try {
        const cfg = { ...base, codec, ...attempt };
        const s = await VideoEncoder.isConfigSupported(cfg);
        if (s.supported) return { config: s.config || cfg, downgraded: attempt.hardwareAcceleration !== accel };
      } catch {}
    }
  }
  throw new Error("Aucun encodeur H.264 disponible sur cet appareil.");
}

export { MAX_FPS, pickVideoConfig };
