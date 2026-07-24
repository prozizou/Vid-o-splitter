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
  ui, wireDropZone, makeStatus, makeProgress, fmtSize, attachLogTools,
  decodeFile, bufferToWav, channelsToBuffer, isVideo,
  replaceAudioInVideo, wavToM4a,
} from './media.js';

const els = ui(['dropZone','fileInput','processBtn','status','progressContainer','progressBar',
  'strength','strengthVal','tail','tailVal','hp','gate',
  'compareBox','beforeAudio','afterAudio','exportBox','dlWav','dlM4a','dlVideo',
  'videoOut','dlVideoLink','logOutput']);

const setStatus = makeStatus(els.status);
const progress = makeProgress(els.progressContainer, els.progressBar);
const log = m => { els.logOutput.classList.remove('hidden'); els.logOutput.textContent += m + '\n'; };
attachLogTools(els.logOutput, 'journal-echo.txt');

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

// ---------- Traitement spectral (dans un Worker) ----------
// Le calcul lourd vit dans echo-worker.js : la page reste fluide et le
// traitement continue à pleine vitesse même en arrière-plan.

/**
 * Démarre le worker et attend qu'il signale être prêt.
 * @returns le Worker, ou null si les Workers de type module sont indisponibles.
 *
 * La poignée de main est indispensable : un navigateur sans Worker de type
 * module échoue à l'EXÉCUTION, pas à la construction. Sans elle, on aurait déjà
 * transféré (donc détaché) les canaux audio, et le repli en page n'aurait plus
 * que des tableaux vides à traiter.
 */
function startWorker() {
  return new Promise(resolve => {
    let worker;
    try { worker = new Worker('/echo-worker.js', { type: 'module' }); }
    catch { return resolve(null); }

    const done = ok => { worker.onmessage = null; worker.onerror = null; resolve(ok ? worker : null); };
    const timer = setTimeout(() => { worker.terminate(); done(false); }, 10000);
    worker.onmessage = e => {
      if (e.data && e.data.type === 'ready') { clearTimeout(timer); done(true); }
    };
    worker.onerror = () => { clearTimeout(timer); worker.terminate(); done(false); };
  });
}

/** Lance la déréverbération. Repli en page si le worker n'a pas démarré. */
async function runDereverb(channels, sr, params, onProgress) {
  const worker = await startWorker();
  if (!worker) return fallbackInPage(channels, sr, params, onProgress);

  return new Promise((resolve, reject) => {
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') { onProgress(m.p); return; }
      if (m.type === 'done') { worker.terminate(); resolve(m.channels); return; }
      if (m.type === 'error') { worker.terminate(); reject(new Error(m.message)); }
    };
    worker.onerror = () => { worker.terminate(); reject(new Error('le traitement a échoué')); };
    // Canaux TRANSFÉRÉS : aucune copie, même sur un fichier d'une heure.
    worker.postMessage({ channels, sr, params }, channels.map(c => c.buffer));
  });
}

async function fallbackInPage(channels, sr, params, onProgress) {
  log('ℹ️ Worker indisponible : traitement dans la page (interface moins fluide).');
  const { dereverbAll } = await import('./echo-worker.js');
  return dereverbAll(channels, sr, params, onProgress);
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
    // Copies détachables : getChannelData renvoie une vue sur l'AudioBuffer,
    // qui ne peut pas être transférée telle quelle au worker.
    const inCh = Array.from({ length: nCh }, (_, c) => buf.getChannelData(c).slice());
    const outCh = await runDereverb(inCh, sr, { ...P }, p => progress.set(p));

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
