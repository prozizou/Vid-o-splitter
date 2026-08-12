/* =============================================================================
   BGM.JS — sons de fond continus, synthétisés à la volée.

   Aucun fichier audio n'est téléchargé : tout est généré mathématiquement,
   pour toute la durée nécessaire. Contrairement à un son de transition (bref,
   placé à un instant précis), un son de fond couvre TOUTE la partie : il est
   donc calculé d'un bout à l'autre en une seule passe, jamais par répétition
   d'une boucle courte — il n'y a donc aucun point de bouclage audible, même
   sur plusieurs minutes.

   Utilisé par les deux moteurs du Splitter :
   - moteur turbo  : mélangé directement dans le PCM de la partie (mixBg) ;
   - moteur ffmpeg : un WAV de la durée de la partie, mixé via amix (voir
     makeBgWav et app.js).

   Ce fichier reste PUR (aucune API du navigateur) pour rester testable dans
   `npm test`. Les ambiances basées sur de vrais enregistrements (voir
   bgm-audio.js, qui a besoin de fetch()/AudioContext pour décoder les
   fichiers) réutilisent les briques ci-dessous (dbToLin, mixInto,
   pcmMonoToWavBlob, loopToLength, resampleLinear) au lieu de les dupliquer.
   ========================================================================== */

export const BGM_TYPES = {
  none:  'Aucun',
  rose:  'Bruit rose doux',
  rain:  'Pluie légère',
  drone: 'Nappe ambiante',
  waves: 'Vagues lointaines',
};

// Générateur de bruit reproductible (pas de Math.random : même rendu à
// chaque passage, y compris en cas de reprise après coupure).
function noiseGen(seed = 20260807) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

/**
 * Rend un son de fond MONO en continu sur `n` échantillons, normalisé à une
 * crête de 1,0 (le volume réel se règle au mélange, voir mixBg/makeBgWav).
 */
export function renderBgm(type, sr, n) {
  if (!type || type === 'none' || !(n > 0)) return new Float32Array(0);
  const rnd = noiseGen();
  const out = new Float32Array(n);

  switch (type) {
    case 'rose': {                         // bruit rose : filtre de Paul Kellet
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < n; i++) {
        const w = rnd();
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
      break;
    }
    case 'rain': {                         // bruissement filtré + gouttes éparses
      let lp = 0;
      let nextDrop = Math.round((0.05 + 0.05 * Math.abs(rnd())) * sr);
      for (let i = 0; i < n; i++) {
        lp += 0.10 * (rnd() - lp);         // passe-bas : bruissement continu
        if (i === nextDrop) {
          const dur = Math.round(0.02 * sr);
          const amp = 0.5 * rnd();
          for (let k = 0; k < dur && i + k < n; k++) {
            out[i + k] += Math.exp(-k / (0.004 * sr)) * amp;
          }
          nextDrop = i + Math.round((0.03 + 0.12 * Math.abs(rnd())) * sr);
        }
        out[i] += lp * 0.9;
      }
      break;
    }
    case 'drone': {                        // nappe : sinus détunés + LFO lents
      const freqs = [110, 165, 220, 275];
      const lfoHz = [0.07, 0.05, 0.09, 0.06];
      const phase = freqs.map(() => rnd() * Math.PI);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        let v = 0;
        for (let k = 0; k < freqs.length; k++) {
          const lfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * lfoHz[k] * t + phase[k]);
          v += Math.sin(2 * Math.PI * freqs[k] * t + phase[k]) * (0.25 + 0.15 * lfo);
        }
        out[i] = v * 0.35;
      }
      break;
    }
    case 'waves': {                        // bruit filtré, houle lente
      let lp = 0;
      const swellHz = 0.09;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        lp += 0.08 * (rnd() - lp);
        const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * swellHz * t);
        out[i] = lp * (0.3 + 0.7 * swell * swell);
      }
      break;
    }
    default:
      return new Float32Array(0);
  }

  // Micro-fondu aux extrémités : les parties sont rendues indépendamment
  // (voir turbo-render.js), donc chacune a son propre début/fin de fond
  // sonore — sans ce fondu, chaque coupure de partie ajouterait un clic.
  const f = Math.min(Math.round(0.015 * sr), n >> 1);
  for (let i = 0; i < f; i++) { out[i] *= i / f; out[n - 1 - i] *= i / f; }

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 1e-6) for (let i = 0; i < n; i++) out[i] /= peak;
  return out;
}

export const dbToLin = db => Math.pow(10, db / 20);

/**
 * Mélange un lit sonore mono `bg` dans des canaux PCM existants (sur place),
 * avec gain et écrêtage. Même signal appliqué à tous les canaux. Brique
 * commune à mixBg (ambiances synthétisées) et mixBgAudio (enregistrements,
 * voir bgm-audio.js) : seule la façon de PRODUIRE `bg` diffère entre les deux.
 * @param channels [Float32Array, ...]
 */
export function mixInto(channels, bg, gainDb) {
  if (!bg.length || !channels.length || !channels[0].length) return;
  const n = Math.min(bg.length, channels[0].length);
  const gain = dbToLin(gainDb);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      let v = ch[i] + bg[i] * gain;
      if (v > 1) v = 1; else if (v < -1) v = -1;
      ch[i] = v;
    }
  }
}

/**
 * Mélange un son de fond dans des canaux PCM existants (sur place), sur
 * toute leur longueur. Même signal mono sur tous les canaux.
 * @param channels [Float32Array, ...]
 */
export function mixBg(channels, sr, type, gainDb) {
  if (!type || type === 'none' || !channels.length || !channels[0].length) return;
  const bg = renderBgm(type, sr, channels[0].length);
  mixInto(channels, bg, gainDb);
}

/** Encode un signal mono déjà au format voulu (crête ≤ 1,0) en WAV 16 bits.
 * Brique commune à makeBgWav et makeBgAudioWav (voir bgm-audio.js). */
export function pcmMonoToWavBlob(samples, sr) {
  const n = samples.length;
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
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/** Fabrique un WAV mono de `totalSec`, le son de fond seul, au volume
 * demandé — moteur ffmpeg, mixé ensuite avec la voix via amix (voir app.js). */
export function makeBgWav(totalSec, sr, type, gainDb) {
  const n = Math.max(1, Math.round(totalSec * sr));
  const bg = renderBgm(type, sr, n);
  const gain = dbToLin(gainDb);
  const bed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bg[i] * gain;
    if (v > 1) v = 1; else if (v < -1) v = -1;
    bed[i] = v;
  }
  return pcmMonoToWavBlob(bed, sr);
}

/**
 * Boucle `samples` (mono, durée FIXE et courte — un enregistrement) pour
 * remplir exactement `n` échantillons, avec un fondu-enchaîné à chaque
 * raccord de boucle : contrairement aux ambiances synthétisées ci-dessus
 * (calculées d'un bout à l'autre, jamais bouclées), un enregistrement réel a
 * une durée fixe (quelques minutes) qu'il faut répéter pour couvrir une
 * partie plus longue — le fondu-enchaîné est ce qui évite un « clic »
 * audible à chaque reprise du fichier.
 */
export function loopToLength(samples, sr, n, xfadeSec = 2) {
  if (!(n > 0)) return new Float32Array(0);
  const len = samples.length;
  if (!len) return new Float32Array(n);
  if (n <= len) return samples.slice(0, n);

  const xfade = Math.max(1, Math.min(Math.round(xfadeSec * sr), len >> 1));
  const out = new Float32Array(n);
  out.set(samples.subarray(0, Math.min(len, n)), 0);
  let pos = len;
  while (pos < n) {
    // Fondu-enchaîné : la fin de ce qui est déjà écrit (`xfade` échantillons)
    // est mélangée avec le DÉBUT du même enregistrement, qui reprend juste
    // après — le raccord de boucle disparaît, même sur un cycle répété
    // plusieurs fois pour couvrir une longue partie.
    const start = pos - xfade;
    const room = n - start;
    const fadeN = Math.min(xfade, room);
    for (let i = 0; i < fadeN; i++) {
      const t = i / xfade;
      out[start + i] = out[start + i] * (1 - t) + samples[i] * t;
    }
    const remain = Math.min(len - xfade, n - (start + fadeN));
    if (remain > 0) out.set(samples.subarray(xfade, xfade + remain), start + fadeN);
    pos = start + fadeN + remain;
  }
  return out;
}

/** Ré-échantillonnage linéaire simple mono. Suffisant pour un lit sonore de
 * fond (pas de contenu haute fréquence critique) : évite de redécoder un
 * enregistrement à chaque fréquence d'échantillonnage demandée par les deux
 * moteurs (44100 Hz fixe côté ffmpeg, celle de la source côté turbo). */
export function resampleLinear(samples, srcSr, dstSr) {
  if (!samples.length || srcSr === dstSr) return samples;
  const dstLen = Math.max(1, Math.round(samples.length * dstSr / srcSr));
  const out = new Float32Array(dstLen);
  const ratio = (samples.length - 1) / Math.max(1, dstLen - 1);
  for (let i = 0; i < dstLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos), i1 = Math.min(i0 + 1, samples.length - 1);
    const t = pos - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}
