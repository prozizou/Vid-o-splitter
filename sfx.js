/* =============================================================================
   SFX.JS — sons de transition et lit sonore, synthétisés à la volée.

   Aucun fichier audio n'est téléchargé : tout est généré mathématiquement.
   Utilisé par les deux moteurs du Splitter :
   - moteur turbo  : le son est mélangé directement dans le PCM de la partie ;
   - moteur ffmpeg : on fabrique un « lit » WAV de la durée de la partie, avec
     les sons déjà placés aux bons instants, et on le mixe via amix.
   ========================================================================== */

export const SFX_TYPES = {
  none:   'Aucun',
  click:  'Clic léger',
  breath: 'Souffle doux',
  whoosh: 'Whoosh',
  tick:   'Tic montant',
};

// Générateur de bruit reproductible (pas de Math.random : même rendu à chaque fois).
function noiseGen(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

/** Rend un son de transition mono, normalisé à une crête de 1,0. */
export function renderSfx(type, sr) {
  if (!type || type === 'none') return new Float32Array(0);
  const rnd = noiseGen();
  let n, out;

  switch (type) {
    case 'click': {                       // impulsion courte et sèche
      n = Math.round(0.014 * sr);
      out = new Float32Array(n);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const env = Math.exp(-t * 380);
        lp += 0.45 * (rnd() - lp);        // bruit adouci
        out[i] = env * (0.55 * Math.sin(2 * Math.PI * 1800 * t) + 0.45 * lp);
      }
      break;
    }
    case 'breath': {                      // souffle discret, sans attaque
      n = Math.round(0.14 * sr);
      out = new Float32Array(n);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const env = Math.sin(Math.PI * t) ** 2;   // montée/descente douce
        lp += 0.12 * (rnd() - lp);                // passe-bas ≈ 3 kHz
        out[i] = env * lp;
      }
      break;
    }
    case 'whoosh': {                      // bruit filtré, balayage montant-descendant
      n = Math.round(0.20 * sr);
      out = new Float32Array(n);
      let lo = 0, band = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const env = Math.sin(Math.PI * t) ** 1.5;
        const f = 300 + 2700 * Math.sin(Math.PI * t);       // 300 -> 3000 -> 300 Hz
        const q = 2 * Math.sin(Math.PI * f / sr);           // filtre à variable d'état
        const x = rnd();
        lo += q * band;
        const hi = x - lo - 0.6 * band;
        band += q * hi;
        out[i] = env * band;
      }
      break;
    }
    case 'tick': {                        // petit balayage sinus montant
      n = Math.round(0.09 * sr);
      out = new Float32Array(n);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const f = 500 + 900 * t;
        ph += (2 * Math.PI * f) / sr;
        out[i] = Math.exp(-t * 4.5) * Math.sin(ph);
      }
      break;
    }
    default:
      return new Float32Array(0);
  }

  // Micro-fondu aux extrémités : le son lui-même ne doit ajouter aucun clic.
  // Il est appliqué AVANT la normalisation, sinon il écraserait l'attaque des
  // sons percussifs (le clic perdait 8 dB) et le volume réglé serait faux.
  const f = Math.min(Math.round(0.002 * sr), n >> 1);
  for (let i = 0; i < f; i++) { out[i] *= i / f; out[n - 1 - i] *= i / f; }

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 1e-6) for (let i = 0; i < n; i++) out[i] /= peak;
  return out;
}

const dbToLin = db => Math.pow(10, db / 20);

/**
 * Mélange le son de transition dans des canaux PCM existants (sur place).
 * @param channels   [Float32Array, ...]
 * @param pointsSec  instants des raccords, en secondes
 */
export function mixBed(channels, sr, pointsSec, type, gainDb) {
  if (!type || type === 'none' || !pointsSec.length) return;
  const sfx = renderSfx(type, sr);
  if (!sfx.length) return;
  const gain = dbToLin(gainDb);
  // Le son démarre légèrement AVANT le raccord : l'oreille l'entend comme
  // annonçant la coupe, pas comme la suivant.
  const pre = Math.round(sfx.length * 0.3);

  for (const p of pointsSec) {
    const start = Math.round(p * sr) - pre;
    for (const ch of channels) {
      for (let i = 0; i < sfx.length; i++) {
        const j = start + i;
        if (j < 0 || j >= ch.length) continue;
        let v = ch[j] + sfx[i] * gain;
        if (v > 1) v = 1; else if (v < -1) v = -1;
        ch[j] = v;
      }
    }
  }
}

/** Fabrique un WAV mono de `totalSec`, silencieux sauf les sons de transition. */
export function makeBedWav(totalSec, sr, pointsSec, type, gainDb) {
  const n = Math.max(1, Math.round(totalSec * sr));
  const bed = new Float32Array(n);
  mixBed([bed], sr, pointsSec, type, gainDb);

  const bytes = 44 + n * 2;
  const ab = new ArrayBuffer(bytes);
  const v = new DataView(ab);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); v.setUint32(4, bytes - 8, true); wr(8, 'WAVE');
  wr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wr(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0, o = 44; i < n; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, bed[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/**
 * Opacité d'une image à l'instant `ts`, pour un fondu au noir à chaque raccord.
 * @param pts  instants des raccords (mêmes unités que ts)
 * @param fade demi-durée du fondu (mêmes unités)
 */
export function alphaAt(ts, pts, fade) {
  if (!fade || !pts.length) return 1;
  let d = Infinity;
  for (const p of pts) {
    const dd = Math.abs(ts - p);
    if (dd < d) d = dd;
  }
  return d >= fade ? 1 : d / fade;
}
