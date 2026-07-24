/* =============================================================================
   ECHO-WORKER.JS — cœur de calcul de l'Echo Remover.

   Ce traitement tournait dans la boucle d'événements de la page, avec un
   `await setTimeout(0)` toutes les 64 trames pour « rendre la main ». Deux
   conséquences : l'interface saccadait, et surtout `setTimeout` est bridé à
   1 seconde dès que l'onglet passe en arrière-plan — le traitement s'arrêtait
   donc quasiment dès qu'on changeait d'application.

   Dans un Worker, le calcul est isolé du rendu ET n'est pas bridé.

   Le module est utilisable des deux côtés : il s'enregistre comme worker quand
   il est chargé comme tel, et exporte `dereverbChannel` / `highpass` pour le
   repli en page (navigateur sans Worker de type module).
   ========================================================================== */

import { fftForward, fftInverse } from './media.js';

const N = 1024, HOP = 256;
const hann = new Float32Array(N);
for (let i = 0; i < N; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));
// Compensation COLA pour fenêtre appliquée à l'analyse ET à la synthèse.
const cola = (() => { let s = 0; for (let i = 0; i < N; i += HOP) s += hann[i] * hann[i]; return s; })();

/** Coupe-bas simple (biquad Butterworth 2e ordre) appliqué avant la STFT. */
export function highpass(x, sr, fc) {
  const w = Math.tan((Math.PI * fc) / sr);
  const k = 1 / (1 + Math.SQRT2 * w + w * w);
  const b0 = k, b1 = -2 * k, b2 = k;
  const a1 = 2 * k * (w * w - 1), a2 = k * (1 - Math.SQRT2 * w + w * w);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const yi = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = yi; y[i] = yi;
  }
  return y;
}

/**
 * Déréverbération d'un canal par soustraction spectrale.
 * @param P { strength, tail, gate }
 * @param onProgress rappel 0..1 (facultatif)
 */
export function dereverbChannel(x, sr, P, onProgress) {
  const out = new Float32Array(x.length + N);
  const bins = N / 2 + 1;

  // Constantes de lissage dérivées des réglages utilisateur.
  const tailFrames = Math.max(2, Math.round((P.tail * sr) / HOP));
  const aRev = Math.exp(-1 / tailFrames);            // mémoire de la réverb
  const aGain = 0.6;                                  // lissage temporel du gain
  const floor = Math.max(0.05, 0.18 - P.strength * 0.08);
  const k = P.strength;

  const rev = new Float32Array(bins);                 // estimation réverb
  const gPrev = new Float32Array(bins).fill(1);
  const re = new Float32Array(N), im = new Float32Array(N);
  const mag = new Float32Array(bins), g = new Float32Array(bins);

  // Expandeur : suivi du niveau de trame pour la porte douce.
  let envSlow = 0, envFast = 0;
  const frames = Math.ceil((x.length + N) / HOP);

  for (let f = 0, pos = 0; pos < x.length; f++, pos += HOP) {
    for (let i = 0; i < N; i++) {
      const s = pos + i < x.length ? x[pos + i] : 0;
      re[i] = s * hann[i]; im[i] = 0;
    }
    fftForward(re, im);

    let frameEnergy = 0;
    for (let b = 0; b < bins; b++) {
      // Math.sqrt plutôt que Math.hypot : même résultat ici (pas de risque de
      // débordement sur des magnitudes audio) et nettement plus rapide, dans
      // la boucle la plus chaude du fichier (bins × trames).
      const r = re[b], i2 = im[b];
      const m = Math.sqrt(r * r + i2 * i2);
      mag[b] = m;
      frameEnergy += m * m;
    }

    for (let b = 0; b < bins; b++) {
      // 1. la réverb tardive est une traînée : moyenne exponentielle du passé
      rev[b] = aRev * rev[b] + (1 - aRev) * mag[b];
      // 2. soustraction avec plancher
      let gain = mag[b] > 1e-9 ? 1 - (k * rev[b]) / (mag[b] + 1e-9) : floor;
      if (gain < floor) gain = floor;
      if (gain > 1) gain = 1;
      // 3. lissage temporel (anti bruit musical)
      g[b] = aGain * gPrev[b] + (1 - aGain) * gain;
    }
    // lissage fréquentiel 1-2-1
    g[0] = (2 * g[0] + g[1]) / 3;
    for (let b = 1; b < bins - 1; b++) g[b] = (g[b - 1] + 2 * g[b] + g[b + 1]) / 4;
    g[bins - 1] = (g[bins - 2] + 2 * g[bins - 1]) / 3;
    gPrev.set(g);

    // 4. porte douce : si la trame est bien plus faible que le niveau parlé,
    //    on l'atténue progressivement (jamais un mute brutal).
    let gateGain = 1;
    if (P.gate) {
      const lvl = Math.sqrt(frameEnergy / bins);
      envFast = Math.max(lvl, envFast * 0.85);
      envSlow = 0.995 * envSlow + 0.005 * envFast;
      const ratio = envFast / (envSlow + 1e-9);
      gateGain = ratio < 0.25 ? 0.35 : ratio < 0.5 ? 0.65 : 1;
    }

    for (let b = 0; b < bins; b++) {
      const gg = g[b] * gateGain;
      re[b] *= gg; im[b] *= gg;
      if (b > 0 && b < N / 2) { re[N - b] *= gg; im[N - b] *= gg; }
    }

    fftInverse(re, im);
    for (let i = 0; i < N; i++) out[pos + i] += (re[i] * hann[i]) / cola;

    if (onProgress && (f & 63) === 0) onProgress(f / frames);
  }
  return out.subarray(0, x.length).slice();
}

/** Traite tous les canaux d'un coup. */
export function dereverbAll(channels, sr, P, onProgress) {
  return channels.map((x, c) => {
    const src = P.hp ? highpass(x, sr, 85) : x;
    return dereverbChannel(src, sr, P, p => onProgress && onProgress((c + p) / channels.length));
  });
}

// --- Point d'entrée Worker -------------------------------------------------
// Le garde évite d'installer un onmessage sur `window` quand ce module est
// importé en page pour le repli.
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  // La page attend ce signal avant de transférer les canaux audio : voir
  // startWorker() dans echo.js.
  self.postMessage({ type: 'ready' });
  self.onmessage = e => {
    const { channels, sr, params } = e.data;
    try {
      const out = dereverbAll(channels, sr, params, p => self.postMessage({ type: 'progress', p }));
      self.postMessage({ type: 'done', channels: out }, out.map(c => c.buffer));
    } catch (err) {
      self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
    }
  };
}
