/* =============================================================================
   TURBO · LECTURE / ÉCRITURE MP4 (mp4box + mp4-muxer)
   -----------------------------------------------------------------------------
   Chargement à la demande des deux dépendances (démultiplexeur mp4box,
   multiplexeur mp4-muxer), extraction des « descriptions » de codec exigées par
   les décodeurs WebCodecs, flux d'échantillons paginé (mémoire bornée même sur
   un fichier de plusieurs Go), et le « primer » de groupe d'images rejoué après
   chaque flush du décodeur.
   ========================================================================== */

import { sleep } from './turbo-util.js';

const MUXER_URL = '/vendor/mp4-muxer/mp4-muxer.mjs';
const MP4BOX_URL = '/vendor/mp4box/mp4box.all.js';

let _mp4box, _muxer;
function loadMP4Box() {
  if (_mp4box) return _mp4box;
  _mp4box = new Promise((res, rej) => {
    if (self.MP4Box) return res(self.MP4Box);
    const s = document.createElement('script');
    s.src = MP4BOX_URL;
    s.onload = () => (self.MP4Box ? res(self.MP4Box) : rej(new Error('mp4box non chargé')));
    s.onerror = () => rej(new Error('mp4box introuvable dans /vendor'));
    document.head.appendChild(s);
  });
  return _mp4box;
}
function loadMuxer() { return _muxer || (_muxer = import(MUXER_URL)); }

/**
 * Rejoue le début d'un groupe d'images après un `flush()`.
 *
 * `turboRenderAll` appelle `vdec.flush()` à la fin de chaque partie, pour que
 * le décodeur rende ses dernières images. Mais après un flush, WebCodecs EXIGE
 * une image clé :
 *
 *   Failed to execute 'decode' on 'VideoDecoder': A key frame is required
 *   after configure() or flush().
 *
 * Or la partie suivante reprend le flux là où la précédente s'est arrêtée,
 * c'est-à-dire presque toujours AU MILIEU d'un groupe d'images. Le premier
 * paquet fourni est alors une image intermédiaire, et le décodage échoue.
 *
 * On garde donc en mémoire les paquets ENCODÉS depuis la dernière image clé —
 * quelques centaines de kilo-octets, pas des trames décodées — et on les
 * rejoue avant de reprendre. Les images ainsi reproduites appartiennent à la
 * partie précédente ou au silence supprimé : `emit()` les écarte via `inRange`,
 * elles ne polluent donc pas la sortie.
 *
 * Sauter les paquets jusqu'à la prochaine image clé aurait été plus simple,
 * mais aurait perdu jusqu'à un groupe d'images entier — une à deux secondes de
 * vidéo — au début de chaque partie.
 */
export function createGopPrimer() {
  let gop = [];            // paquets depuis la dernière image clé, incluse
  let needPrime = false;   // un flush a eu lieu : le décodeur attend une clé

  return {
    /** À appeler après chaque `flush()` du décodeur vidéo. */
    afterFlush() { needPrime = true; },

    /**
     * Enregistre un paquet et indique ce qu'il faut décoder AVANT lui.
     * @returns les paquets à rejouer (vide dans le cas courant).
     */
    accept(chunk) {
      if (chunk.type === 'key') {
        gop = [chunk];
        needPrime = false;
        return [];
      }
      const replay = needPrime ? gop.slice() : [];
      needPrime = false;
      gop.push(chunk);
      return replay;
    },

    get bufferedCount() { return gop.length; },
  };
}

/**
 * Localise la classe DataStream de mp4box.
 *
 * Le bundle `mp4box.all.js` expose DEUX globaux distincts : `MP4Box`, qui ne
 * contient que `createFile`, et `DataStream`, à côté. Chercher
 * `MP4Box.DataStream` donnait donc `undefined`, et lire `.BIG_ENDIAN` dessus
 * levait « Cannot read properties of undefined » — ce qui interrompait le
 * moteur turbo au moment du rendu et le faisait retomber sur ffmpeg.
 *
 * On accepte les deux emplacements : si une version future de mp4box range
 * DataStream sous MP4Box, ça continuera de fonctionner.
 */
export function resolveDataStream(MP4Box, scope) {
  const g = scope || (typeof self !== 'undefined' ? self : globalThis);
  const DS = (MP4Box && MP4Box.DataStream) || (g && g.DataStream);
  if (typeof DS !== 'function') {
    throw new Error('mp4box : classe DataStream introuvable (bundle incomplet ?)');
  }
  return DS;
}

// Récupère la « description » du codec (avcC / hvcC) exigée par VideoDecoder.
function videoDescription(mp4file, trackId, MP4Box) {
  const trak = mp4file.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (!box) continue;
    const DataStream = resolveDataStream(MP4Box);
    // BIG_ENDIAN vaut `false` chez mp4box (l'endianness y est un booléen où
    // `true` signifie petit-boutiste) : il faut donc bien passer la constante,
    // pas une valeur « vraie ».
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer, 8); // on saute l'en-tête de boîte
  }
  return null;
}

// AudioSpecificConfig (esds) ; sinon on la reconstruit à partir du profil AAC-LC.
const SR_INDEX = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
function audioDescription(mp4file, trackId, sampleRate, channels) {
  try {
    const trak = mp4file.getTrackById(trackId);
    const esds = trak.mdia.minf.stbl.stsd.entries[0].esds;
    const desc = esds.esd.descs[0].descs[0];
    if (desc && desc.data && desc.data.length) return new Uint8Array(desc.data);
  } catch {}
  const i = SR_INDEX.indexOf(sampleRate);
  if (i < 0) return null;
  const objType = 2; // AAC-LC
  const b0 = (objType << 3) | (i >> 1);
  const b1 = ((i & 1) << 7) | (channels << 3);
  return new Uint8Array([b0, b1]);
}

/**
 * Codec à passer au AudioDecoder, en préservant le VRAI profil AAC de la
 * source (mp4box le calcule depuis l'AudioSpecificConfig réelle du flux :
 * 'mp4a.40.2' = AAC-LC, 'mp4a.40.5' = HE-AAC/SBR, 'mp4a.40.29' = HE-AACv2).
 *
 * VOIX ROBOTIQUE — la source d'une voix enregistrée sur téléphone est souvent
 * en HE-AAC (plus efficace qu'AAC-LC à bas débit sur de la parole). Décoder un
 * flux HE-AAC en forçant le profil LC saute la reconstruction de bande
 * spectrale (SBR) : le décodeur ne restitue alors que la moitié grave du
 * spectre réel, à la moitié de la fréquence d'échantillonnage effective. Le
 * code réencodait ensuite ce PCM tronqué comme s'il était complet, au débit
 * DÉCLARÉ par le conteneur — d'où une voix trop aiguë, « robotique ».
 *
 * On ne force donc PLUS jamais le profil : la chaîne de la source est utilisée
 * telle quelle dès qu'elle est complète (deux composantes numériques après
 * 'mp4a.'). Repli sur AAC-LC uniquement si mp4box n'a pas pu déterminer le
 * profil (chaîne 'mp4a' nue, esds absent ou illisible) — un cas où de toute
 * façon aucune information de profil n'existe à préserver.
 */
function aacDecoderCodec(codec) {
  return /^mp4a\.[0-9a-fA-F]+\.\d+$/.test(codec) ? codec : 'mp4a.40.2';
}

/**
 * Débit audio DÉCLARÉ par la source, en bits/s (0 si inconnu).
 *
 * Lu dans le DecoderConfigDescriptor de l'esds (`avgBitrate`, sinon
 * `maxBitrate`). Sert à ré-encoder la voix au MÊME débit que l'original plutôt
 * qu'à une valeur imposée : un encodage AAC en tandem à un débit différent de
 * la source colore le timbre (« voix robotique »). Mieux vaut coller au débit
 * de départ. Renvoie 0 si l'esds est absent ou ne le renseigne pas — l'appelant
 * choisit alors un repli.
 */
function audioBitrate(mp4file, trackId) {
  try {
    const dcd = mp4file.getTrackById(trackId)
      .mdia.minf.stbl.stsd.entries[0].esds.esd.descs[0];
    const b = dcd.avgBitrate || dcd.maxBitrate || 0;
    return Number.isFinite(b) && b > 0 ? b : 0;
  } catch { return 0; }
}

// ==================== FLUX D'ÉCHANTILLONS ====================
// Lit le fichier par tranches de 4 Mo et livre les échantillons dans l'ordre.
// La lecture se met en pause dès que la file d'attente est pleine : la mémoire
// ne dépasse jamais quelques dizaines de Mo, même sur un fichier de 2 Go.

/**
 * Copie d'un échantillon mp4box, AVEC ses octets.
 *
 * mp4box livre à `onSamples` les objets `trak.samples[i]` eux-mêmes, et
 * `releaseUsedSamples()` fait `sample.data = null` sur ces mêmes objets. Comme
 * on met les échantillons en file pour les consommer plus tard, en garder la
 * référence revenait à ne recevoir que des `data: null` — et donc à faire
 * échouer la construction du tout premier EncodedVideoChunk/EncodedAudioChunk :
 *
 *   Failed to construct 'EncodedAudioChunk': [...] The provided value is not
 *   of type '(ArrayBuffer or ArrayBufferView)'
 *
 * Le moteur turbo basculait alors systématiquement sur ffmpeg, en silence.
 * On prend donc un instantané des octets avant toute libération.
 */
export function snapshotSample(s) {
  return {
    number: s.number,
    cts: s.cts,
    dts: s.dts,
    duration: s.duration,
    timescale: s.timescale,
    is_sync: s.is_sync,
    size: s.size,
    data: s.data ? s.data.slice() : null,
  };
}

async function createSampleStream(file, MP4Box, wanted) {
  const mp4 = MP4Box.createFile();
  const queue = [];
  let notify = null, finished = false, failed = null;

  const ready = new Promise((res, rej) => {
    mp4.onReady = info => res(info);
    mp4.onError = e => { failed = new Error('Fichier illisible : ' + e); rej(failed); };
  });
  mp4.onSamples = (id, _u, samples) => {
    // La copie DOIT précéder releaseUsedSamples : voir snapshotSample().
    for (const s of samples) queue.push({ id, s: snapshotSample(s) });
    mp4.releaseUsedSamples(id, samples[samples.length - 1].number + 1);
    if (notify) { notify(); notify = null; }
  };

  (async () => {
    const CH = 4 * 1024 * 1024;
    let off = 0;
    try {
      while (off < file.size) {
        while (queue.length > 400) await sleep(4);
        const buf = await file.slice(off, Math.min(off + CH, file.size)).arrayBuffer();
        buf.fileStart = off;
        mp4.appendBuffer(buf);
        off += CH;
      }
      mp4.flush();
    } catch (e) { failed = e; }
    finished = true;
    if (notify) { notify(); notify = null; }
  })();

  const info = await ready;
  for (const id of wanted) mp4.setExtractionOptions(id, null, { nbSamples: 50 });
  mp4.start();

  let pushback = null;
  return {
    mp4, info,
    peek: async () => (pushback ||= await pull()),
    take: async () => { if (pushback) { const p = pushback; pushback = null; return p; } return pull(); },
  };

  async function pull() {
    while (!queue.length) {
      if (failed) throw failed;
      if (finished) return null;
      await new Promise(r => { notify = r; });
    }
    return queue.shift();
  }
}

export { loadMP4Box, loadMuxer, videoDescription, audioDescription, audioBitrate, aacDecoderCodec, createSampleStream };
