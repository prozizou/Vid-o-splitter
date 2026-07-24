/* =============================================================================
   SILENCE.JS — détection des silences et découpage en parties.

   Fonctions PURES, sans DOM ni Web API : c'est ce qui les rend testables en
   Node (`npm test`). app.js ne fait qu'appeler ces fonctions avec l'enveloppe
   RMS produite par le moteur turbo (WebCodecs) ou par ffmpeg.

   Le seuil de silence est ADAPTATIF : il est recalculé par blocs de ~8 s puis
   interpolé, au lieu d'un seuil unique pour tout le fichier. Une vidéo dont le
   bruit de fond change en cours de route (fenêtre ouverte, changement de pièce)
   n'est donc plus mal segmentée de bout en bout.

   La machine à états utilise une HYSTÉRÉSIS (deux seuils) : la voix « ouvre »
   au seuil haut et ne « ferme » qu'au seuil bas. Sans cela, un passage juste
   au niveau du seuil produit un papillonnement de micro-segments.
   ========================================================================== */

export const DEFAULTS = {
  windowSec:     0.03,   // fenêtre d'analyse audio
  minSilenceDur: 0.40,   // durée mini d'un silence pour être coupé
  minSegmentDur: 0.30,   // on jette les segments conservés trop courts
  padding:       0.08,   // marge conservée avant/après la voix
  sensitivity:   1.0,    // multiplicateur du seuil adaptatif
  absFloor:      0.004,  // plancher d'amplitude absolu
};

// Un seuil local est recalculé tous les BLOCK_SEC. Trop court : le seuil suit
// la voix elle-même et on coupe des mots. Trop long : on perd l'adaptativité.
const BLOCK_SEC = 8;

// Le seuil local ne peut pas s'écarter arbitrairement du seuil global : sans
// ces bornes, un bloc entièrement silencieux (ou entièrement saturé) produirait
// un seuil aberrant sur sa portion de fichier.
const LOCAL_MIN_RATIO = 0.35;
const LOCAL_MAX_RATIO = 2.5;

// Hystérésis : une fois la voix détectée, on ne referme qu'en dessous de
// CLOSE_RATIO × seuil. Évite le papillonnement d'un signal qui frôle le seuil.
//
// Volontairement PROCHE de 1 : la temporisation, c'est `minSilenceDur` qui la
// fournit (on ne coupe qu'après un silence assez long). Une hystérésis large
// (0,55 par exemple) faisait pire que mieux — un bruit de fond soutenu situé
// entre les deux seuils maintenait la porte ouverte jusqu'à la fin du fichier,
// et le silence bruyant n'était jamais coupé.
const CLOSE_RATIO = 0.8;

/** Percentile d'un tableau DÉJÀ trié. */
function pctOf(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** Seuil brut d'un jeu de valeurs RMS : au-dessus du bruit, loin sous la voix. */
function rawThreshold(sorted) {
  return Math.max(pctOf(sorted, 0.10) * 2.5, pctOf(sorted, 0.90) * 0.06);
}

/**
 * Courbe de seuil, une valeur par fenêtre d'analyse.
 * Exportée pour que l'aperçu graphique affiche exactement le seuil utilisé.
 */
export function thresholdCurve(loud, winSec, cfg = {}) {
  const C = { ...DEFAULTS, ...cfg };
  const n = loud.length;
  const curve = new Float32Array(n);
  if (!n) return curve;

  const globalRaw = rawThreshold(Float32Array.from(loud).sort());
  const apply = t => Math.max(t / C.sensitivity, C.absFloor);

  const blockLen = Math.max(1, Math.round(BLOCK_SEC / winSec));
  const nBlocks = Math.ceil(n / blockLen);

  // Un seuil brut par bloc, borné autour du seuil global.
  const blockThr = new Float32Array(nBlocks);
  for (let b = 0; b < nBlocks; b++) {
    const from = b * blockLen;
    const to = Math.min(n, from + blockLen);
    const slice = Float32Array.from(loud.slice(from, to)).sort();
    const t = rawThreshold(slice);
    blockThr[b] = Math.min(
      Math.max(t, globalRaw * LOCAL_MIN_RATIO),
      globalRaw * LOCAL_MAX_RATIO,
    );
  }

  // Interpolation linéaire entre les centres de blocs : le seuil ne saute pas
  // brutalement d'un bloc à l'autre au milieu d'une phrase.
  for (let i = 0; i < n; i++) {
    const x = (i - blockLen / 2) / blockLen;
    const b0 = Math.floor(x);
    const f = x - b0;
    const a = blockThr[Math.min(nBlocks - 1, Math.max(0, b0))];
    const c = blockThr[Math.min(nBlocks - 1, Math.max(0, b0 + 1))];
    curve[i] = apply(a + (c - a) * Math.min(1, Math.max(0, f)));
  }
  return curve;
}

/**
 * Enveloppe RMS -> segments à conserver.
 * @param loud     enveloppe RMS (une valeur par fenêtre)
 * @param winSec   durée d'une fenêtre, en secondes
 * @param duration durée totale, en secondes
 * @returns { segments: [[start, end], ...], duration, kept, threshold }
 */
export function segmentsFromLoud(loud, winSec, duration, cfg = {}) {
  const C = { ...DEFAULTS, ...cfg };
  const nWin = loud.length;
  const threshold = thresholdCurve(loud, winSec, C);

  const minSilWin = Math.max(1, Math.round(C.minSilenceDur / winSec));
  const raw = [];
  let start = null, lastLoud = -1;

  for (let k = 0; k < nWin; k++) {
    const thr = threshold[k];
    // Hystérésis : seuil haut pour ouvrir, seuil bas pour rester ouvert.
    const isLoud = start === null ? loud[k] > thr : loud[k] > thr * CLOSE_RATIO;
    if (isLoud) {
      if (start === null) start = k;
      lastLoud = k;
    } else if (start !== null && (k - lastLoud) >= minSilWin) {
      raw.push([start * winSec, (lastLoud + 1) * winSec]);
      start = null;
    }
  }
  if (start !== null) raw.push([start * winSec, Math.min(duration, (lastLoud + 1) * winSec)]);

  const padded = raw.map(([s, e]) => [Math.max(0, s - C.padding), Math.min(duration, e + C.padding)]);
  const merged = [];
  for (const [s, e] of padded) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const final = merged.filter(([s, e]) => e - s >= C.minSegmentDur);
  if (final.length === 0) final.push([0, duration]);

  const kept = final.reduce((a, [s, e]) => a + (e - s), 0);
  return { segments: final, duration, kept, threshold };
}

/** Enveloppe RMS calculée sur du PCM 16 bits mono (moteur ffmpeg). */
export function loudFromPCM(pcm, sr, windowSec = DEFAULTS.windowSec) {
  const len = pcm.length;
  const win = Math.max(1, Math.floor(sr * windowSec));
  const nWin = Math.ceil(len / win);
  const loud = new Float32Array(nWin);
  let wi = 0;
  for (let i = 0; i < len; i += win) {
    const end = Math.min(i + win, len);
    let sum = 0, n = 0;
    for (let j = i; j < end; j++) { const s = pcm[j] / 32768; sum += s * s; n++; }
    loud[wi++] = Math.sqrt(sum / n);
  }
  return { loud, winSec: win / sr, duration: len / sr };
}

/**
 * Regroupe les segments en parties. Les frontières tombent toujours dans un
 * silence supprimé : aucune coupe au milieu d'un mot.
 * @param opts { chunkMode: 'auto'|'off'|secondes, autoAbove, autoSec, maxSegPerChunk }
 */
export function planChunks(segments, duration, opts = {}) {
  const {
    chunkMode = 'auto',
    autoAbove = 300,
    autoSec = 240,
    maxSegPerChunk = 40,
  } = opts;

  let target;
  if (chunkMode === 'off') target = Infinity;
  else if (chunkMode === 'auto') target = duration > autoAbove ? autoSec : Infinity;
  else target = parseFloat(chunkMode);

  const groups = [];
  if (!isFinite(target)) groups.push(segments);
  else {
    let cur = [];
    for (const seg of segments) {
      if (cur.length && (seg[1] - cur[0][0] > target || cur.length >= maxSegPerChunk)) {
        groups.push(cur); cur = [];
      }
      cur.push(seg);
    }
    if (cur.length) groups.push(cur);
  }
  return groups.map((segs, index) => ({
    index, segs,
    t0: segs[0][0],
    t1: segs[segs.length - 1][1],
    kept: segs.reduce((a, [s, e]) => a + (e - s), 0),
    status: 'pending',
    blob: null,
  }));
}
