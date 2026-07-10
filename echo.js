/* =============================================================================
   ECHO REMOVER — réduction d'écho / réverbération, 100 % locale.

   Méthode (traitement spectral trame par trame, STFT 1024 / saut 256, Hann) :
   1. Estimation de la réverbération tardive : moyenne exponentielle des
      magnitudes passées, pondérée par la « taille de pièce » choisie.
   2. Soustraction spectrale avec plancher : gain = max(1 - k·R/|X|, floor),
      lissé en temps et en fréquence pour éviter le bruit musical.
   3. Expandeur doux (porte de bruit optionnelle) sur l'énergie de trame.
   4. Recomposition par addition-recouvrement (COLA respecté).

   Ce n'est pas une déréverbération studio par IA, mais sur une voix
   enregistrée dans une pièce qui résonne, le résultat est net et naturel.
   ========================================================================== */

import {
  ui, wireDropZone, makeStatus, makeProgress, fmtSize,
  decodeFile, bufferToWav, channelsToBuffer, isVideo,
  replaceAudioInVideo, wavToM4a, fftForward, fftInverse,
} from './media.js';

const els = ui(['dropZone','fileInput','processBtn','status','progressContainer','progressBar',
  'strength','strengthVal','tail','tailVal','hp','gate',
  'compareBox','beforeAudio','afterAudio','exportBox','dlWav','dlM4a','dlVideo',
  'videoOut','dlVideoLink','logOutput']);

const setStatus = makeStatus(els.status);
const progress = makeProgress(els.progressContainer, els.progressBar);
const log = m => { els.logOutput.classList.remove('hidden'); els.logOutput.textContent += m + '\n'; };

let file = null;
let resultWav = null;
let urls = [];
const remember = u => (urls.push(u), u);
const freeUrls = () => { urls.forEach(u => URL.revokeObjectURL(u)); urls = []; };

// ---------- Réglages ----------
const P = { strength: 0.8, tail: 0.35, hp: true, gate: true };
const strengthLabel = v => (v < 0.6 ? 'Légère' : v < 1.1 ? 'Moyenne' : 'Forte');
const tailLabel = v => (v < 0.25 ? 'Petite' : v < 0.55 ? 'Moyenne' : 'Grande');
els.strength.addEventListener('input', () => { P.strength = +els.strength.value; els.strengthVal.textContent = strengthLabel(P.strength); });
els.tail.addEventListener('input', () => { P.tail = +els.tail.value; els.tailVal.textContent = tailLabel(P.tail); });
els.hp.addEventListener('change', () => { P.hp = els.hp.checked; });
els.gate.addEventListener('change', () => { P.gate = els.gate.checked; });

// ---------- Fichier ----------
wireDropZone(els.dropZone, els.fileInput, f => {
  file = f;
  resultWav = null;
  freeUrls();
  els.compareBox.classList.add('hidden');
  els.exportBox.classList.add('hidden');
  els.videoOut.classList.add('hidden');
  els.dlVideoLink.classList.add('hidden');
  els.processBtn.disabled = false;
  setStatus(`✅ ${f.name} (${fmtSize(f.size)})${isVideo(f) ? ' — vidéo : l\u2019audio sera traité, l\u2019image conservée.' : ''}`);
});

// ---------- Traitement spectral ----------
const N = 1024, HOP = 256;
const hann = new Float32Array(N);
for (let i = 0; i < N; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));
// Compensation COLA pour fenêtre appliquée à l'analyse ET à la synthèse.
const cola = (() => { let s = 0; for (let i = 0; i < N; i += HOP) s += hann[i] * hann[i]; return s; })();

async function dereverbChannel(x, sr, onProgress) {
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
      mag[b] = Math.hypot(re[b], im[b]);
      frameEnergy += mag[b] * mag[b];
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

    if ((f & 63) === 0) { onProgress(f / frames); await new Promise(r => setTimeout(r)); }
  }
  return out.subarray(0, x.length).slice();
}

// Coupe-bas simple (biquad Butterworth 2e ordre) appliqué avant la STFT.
function highpass(x, sr, fc) {
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

// ---------- Bouton principal ----------
els.processBtn.addEventListener('click', async () => {
  if (!file) return;
  els.processBtn.disabled = true;
  progress.show(true); progress.set(0);
  try {
    setStatus('🎧 Décodage du fichier…');
    const buf = await decodeFile(file, setStatus);
    const sr = buf.sampleRate;
    const nCh = Math.min(2, buf.numberOfChannels);

    setStatus('🔬 Réduction de l\u2019écho en cours…');
    const outCh = [];
    for (let c = 0; c < nCh; c++) {
      let x = buf.getChannelData(c);
      if (P.hp) x = highpass(x, sr, 85);
      const done = await dereverbChannel(x, sr, p => progress.set((c + p) / nCh));
      outCh.push(done);
    }

    resultWav = bufferToWav(channelsToBuffer(outCh, sr));
    progress.set(1);

    // Comparaison avant / après
    els.beforeAudio.src = remember(URL.createObjectURL(file));
    els.afterAudio.src = remember(URL.createObjectURL(resultWav));
    els.compareBox.classList.remove('hidden');
    els.exportBox.classList.remove('hidden');
    els.dlWav.href = remember(URL.createObjectURL(resultWav));
    els.dlVideo.classList.toggle('hidden', !isVideo(file));
    setStatus(`✅ Terminé (${fmtSize(resultWav.size)} en WAV). Comparez, ajustez l'intensité si besoin, relancez.`);
  } catch (e) {
    console.error(e);
    setStatus('❌ ' + e.message, 'err');
  } finally {
    els.processBtn.disabled = false;
  }
});

// ---------- Exports ----------
els.dlM4a.addEventListener('click', async () => {
  if (!resultWav) return;
  els.dlM4a.disabled = true;
  setStatus('🎼 Conversion en M4A…'); progress.show(true); progress.set(0);
  try {
    const m4a = await wavToM4a(resultWav, log, p => progress.set(p));
    const a = document.createElement('a');
    a.href = remember(URL.createObjectURL(m4a));
    a.download = 'voix_sans_echo.m4a';
    a.click();
    setStatus(`✅ M4A prêt (${fmtSize(m4a.size)}).`);
  } catch (e) { setStatus('❌ Conversion impossible : ' + e.message, 'err'); }
  finally { els.dlM4a.disabled = false; }
});

els.dlVideo.addEventListener('click', async () => {
  if (!resultWav || !file) return;
  els.dlVideo.disabled = true;
  setStatus('🎬 Réinjection de l\u2019audio dans la vidéo (image copiée, pas réencodée)…');
  progress.show(true); progress.set(0);
  try {
    const out = await replaceAudioInVideo(file, resultWav, log, p => progress.set(p));
    els.videoOut.src = remember(URL.createObjectURL(out));
    els.videoOut.classList.remove('hidden');
    els.dlVideoLink.href = els.videoOut.src;
    els.dlVideoLink.classList.remove('hidden');
    setStatus(`✅ Vidéo prête (${fmtSize(out.size)}).`);
  } catch (e) { setStatus('❌ Réinjection impossible : ' + e.message, 'err'); }
  finally { els.dlVideo.disabled = false; }
});

window.addEventListener('beforeunload', freeUrls);
