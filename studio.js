/* =============================================================================
   AUDIO STUDIO — chaîne de mastering voix, 100 % locale.

   Chaîne : porte de bruit -> coupe-bas -> EQ 7 bandes -> compresseur
            -> normalisation vers un volume cible (approx. LUFS via RMS-K).

   - La porte de bruit est maison (enveloppe attaque/relâche, jamais de mute
     brutal) car DynamicsCompressorNode ne sait pas faire de gate.
   - EQ et compresseur : nœuds natifs Web Audio dans un OfflineAudioContext.
   - Pré-écoute : les 10 premières secondes passent dans la MÊME chaîne en
     temps réel (AudioContext), pour régler avant de traiter tout le fichier.
   ========================================================================== */

import {
  ui, wireDropZone, makeStatus, makeProgress, fmtSize,
  decodeFile, bufferToWav, isVideo, replaceAudioInVideo, wavToM4a,
} from './media.js';

const els = ui(['dropZone','fileInput','preset','gateThr','gateVal','hp','eqBands',
  'comp','compVal','loud','loudVal','previewBtn','processBtn',
  'status','progressContainer','progressBar','compareBox','beforeAudio','afterAudio',
  'exportBox','dlWav','dlM4a','dlVideo','videoOut','dlVideoLink','logOutput']);

const setStatus = makeStatus(els.status);
const progress = makeProgress(els.progressContainer, els.progressBar);
const log = m => { els.logOutput.classList.remove('hidden'); els.logOutput.textContent += m + '\n'; };

let file = null, decoded = null, resultWav = null;
let urls = [];
const remember = u => (urls.push(u), u);
const freeUrls = () => { urls.forEach(u => URL.revokeObjectURL(u)); urls = []; };

// ---------- Réglages ----------
const EQ_FREQS = [80, 200, 500, 1000, 3000, 6000, 12000];
const P = { gate: -45, hp: true, gains: [0,0,0,0,0,0,0], comp: 5, loud: -16 };

const PRESETS = {
  voice:   { gate: -45, hp: true,  gains: [-4,-1, 0, 1, 3, 2, 0],  comp: 5, loud: -16 },
  podcast: { gate: -48, hp: true,  gains: [-2, 2,-1, 0, 2, 1,-1],  comp: 6, loud: -16 },
  music:   { gate: -70, hp: false, gains: [ 0, 0, 0, 0, 1, 1, 1],  comp: 2, loud: -14 },
  repair:  { gate: -55, hp: true,  gains: [-6,-2, 0, 2, 4, 3, 1],  comp: 8, loud: -16 },
};

const fmtHz = f => (f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`);
EQ_FREQS.forEach((f, i) => {
  const w = document.createElement('div');
  w.className = 'eq-band';
  w.innerHTML = `<input type="range" class="eq-slider" data-i="${i}" min="-12" max="12" step="1" value="0"
    orient="vertical" aria-label="Gain ${fmtHz(f)}"><b id="g${i}">0</b><span>${fmtHz(f)}</span>`;
  els.eqBands.appendChild(w);
});

function paint() {
  els.gateThr.value = P.gate;
  els.gateVal.textContent = P.gate <= -70 ? 'Désactivée' : `${P.gate} dB`;
  els.hp.checked = P.hp;
  EQ_FREQS.forEach((_, i) => {
    els.eqBands.querySelector(`[data-i="${i}"]`).value = P.gains[i];
    document.getElementById(`g${i}`).textContent = (P.gains[i] > 0 ? '+' : '') + P.gains[i];
  });
  els.comp.value = P.comp;
  els.compVal.textContent = P.comp === 0 ? 'Désactivée' : P.comp <= 3 ? 'Légère' : P.comp <= 6 ? 'Moyenne' : 'Forte';
  els.loud.value = P.loud;
  els.loudVal.textContent = `${P.loud} LUFS${P.loud === -16 ? ' (streaming)' : P.loud === -14 ? ' (réseaux sociaux)' : ''}`;
}
function custom() { els.preset.value = 'custom'; }

els.preset.addEventListener('change', () => { const p = PRESETS[els.preset.value]; if (p) { Object.assign(P, structuredClone(p)); paint(); } });
els.gateThr.addEventListener('input', () => { P.gate = +els.gateThr.value; custom(); paint(); });
els.hp.addEventListener('change', () => { P.hp = els.hp.checked; custom(); });
els.eqBands.addEventListener('input', e => {
  const i = +e.target.dataset.i; if (Number.isNaN(i)) return;
  P.gains[i] = +e.target.value; custom(); paint();
});
els.comp.addEventListener('input', () => { P.comp = +els.comp.value; custom(); paint(); });
els.loud.addEventListener('input', () => { P.loud = +els.loud.value; custom(); paint(); });
Object.assign(P, structuredClone(PRESETS.voice));
paint();

// ---------- Fichier ----------
wireDropZone(els.dropZone, els.fileInput, async f => {
  file = f; decoded = null; resultWav = null;
  freeUrls();
  ['compareBox','exportBox','videoOut','dlVideoLink'].forEach(k => els[k].classList.add('hidden'));
  setStatus(`⏳ Décodage de ${f.name}…`);
  els.processBtn.disabled = true; els.previewBtn.disabled = true;
  try {
    decoded = await decodeFile(f, setStatus);
    els.processBtn.disabled = false;
    els.previewBtn.disabled = false;
    setStatus(`✅ ${f.name} (${fmtSize(f.size)}, ${Math.round(decoded.duration)} s)${isVideo(f) ? ' — vidéo : l\u2019audio sera traité, l\u2019image conservée.' : ''}`);
  } catch (e) { setStatus('❌ ' + e.message, 'err'); }
});

// ---------- Porte de bruit (pré-traitement, échantillon par échantillon) ----------
function applyGate(channels, sr) {
  if (P.gate <= -70) return channels;
  const thr = Math.pow(10, P.gate / 20);
  const att = Math.exp(-1 / (0.003 * sr));   // ouverture 3 ms
  const rel = Math.exp(-1 / (0.120 * sr));   // fermeture 120 ms
  const hold = Math.round(0.08 * sr);        // maintien 80 ms
  const floorGain = 0.12;                    // jamais de silence absolu

  const n = channels[0].length;
  let env = 0, gain = 1, holdCnt = 0;
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (const c of channels) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
    env = peak > env ? peak + att * (env - peak) : peak + rel * (env - peak);
    const open = env > thr;
    if (open) holdCnt = hold;
    else if (holdCnt > 0) holdCnt--;
    const target = open || holdCnt > 0 ? 1 : floorGain;
    gain += (target - gain) * (target > gain ? 0.02 : 0.0015);
    if (gain !== 1) for (const c of channels) c[i] *= gain;
  }
  return channels;
}

// ---------- Chaîne Web Audio (partagée offline / temps réel) ----------
function buildChain(ctx, srcNode) {
  let node = srcNode;
  if (P.hp) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 85; hp.Q.value = 0.7;
    node.connect(hp); node = hp;
  }
  EQ_FREQS.forEach((f, i) => {
    if (!P.gains[i]) return;
    const b = ctx.createBiquadFilter();
    b.type = 'peaking'; b.frequency.value = f; b.Q.value = 1.0; b.gain.value = P.gains[i];
    node.connect(b); node = b;
  });
  if (P.comp > 0) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = -18 - P.comp;         // 0..10 -> -18..-28 dB
    c.knee.value = 24;
    c.ratio.value = 2 + P.comp * 0.6;         // 2..8
    c.attack.value = 0.006;
    c.release.value = 0.20;
    node.connect(c); node = c;
  }
  return node;
}

// ---------- Normalisation vers le volume cible ----------
// Approximation LUFS : RMS avec pré-filtre coupe-bas déjà appliqué (courbe K
// simplifiée). Suffisant pour viser -16/-14 à ±1 dB près.
function normalize(buffer, targetLufs) {
  const n = buffer.length, ch = buffer.numberOfChannels;
  let sum = 0;
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i += 4) sum += d[i] * d[i];   // sous-échantillonné x4
  }
  const rms = Math.sqrt(sum / (ch * Math.ceil(n / 4)));
  const lufs = 20 * Math.log10(rms + 1e-12) - 0.7;
  let gain = Math.pow(10, (targetLufs - lufs) / 20);

  // Limiteur de crête : la vraie crête ne doit pas dépasser -1 dBFS.
  let peak = 0;
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  const maxGain = 0.891 / (peak + 1e-9);   // -1 dBFS
  if (gain > maxGain) gain = maxGain;

  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] *= gain;
  }
  return { applied: 20 * Math.log10(gain) };
}

// ---------- Traitement complet ----------
els.processBtn.addEventListener('click', async () => {
  if (!decoded) return;
  els.processBtn.disabled = true; els.previewBtn.disabled = true;
  progress.show(true); progress.set(0.05);
  try {
    stopPreview();
    setStatus('🎚️ Traitement en cours…');
    const sr = decoded.sampleRate;
    const nCh = Math.min(2, decoded.numberOfChannels);

    // 1. porte de bruit (copie de travail)
    const work = Array.from({ length: nCh }, (_, c) => decoded.getChannelData(c).slice());
    applyGate(work, sr);
    progress.set(0.25);
    await new Promise(r => setTimeout(r));

    // 2-3. EQ + compresseur dans un OfflineAudioContext
    const ctx = new OfflineAudioContext(nCh, work[0].length, sr);
    const buf = ctx.createBuffer(nCh, work[0].length, sr);
    work.forEach((w, c) => buf.copyToChannel(w, c));
    const src = ctx.createBufferSource(); src.buffer = buf;
    buildChain(ctx, src).connect(ctx.destination);
    src.start();
    const rendered = await ctx.startRendering();
    progress.set(0.75);

    // 4. normalisation
    const { applied } = normalize(rendered, P.loud);
    log(`Normalisation : ${applied >= 0 ? '+' : ''}${applied.toFixed(1)} dB appliqués (cible ${P.loud} LUFS).`);
    progress.set(0.9);

    resultWav = bufferToWav(rendered);
    progress.set(1);

    els.beforeAudio.src = remember(URL.createObjectURL(file));
    els.afterAudio.src = remember(URL.createObjectURL(resultWav));
    els.compareBox.classList.remove('hidden');
    els.exportBox.classList.remove('hidden');
    els.dlWav.href = remember(URL.createObjectURL(resultWav));
    els.dlVideo.classList.toggle('hidden', !isVideo(file));
    setStatus(`✅ Terminé (${fmtSize(resultWav.size)} en WAV). Comparez avant/après.`);
  } catch (e) {
    console.error(e);
    setStatus('❌ ' + e.message, 'err');
  } finally {
    els.processBtn.disabled = false; els.previewBtn.disabled = false;
  }
});

// ---------- Pré-écoute 10 s en direct ----------
let liveCtx = null;
function stopPreview() {
  if (liveCtx) { liveCtx.close().catch(() => {}); liveCtx = null; }
  els.previewBtn.textContent = '🎧 Pré-écouter (10 s en direct)';
}
els.previewBtn.addEventListener('click', async () => {
  if (!decoded) return;
  if (liveCtx) { stopPreview(); return; }

  const sr = decoded.sampleRate;
  const nCh = Math.min(2, decoded.numberOfChannels);
  const len = Math.min(decoded.length, 10 * sr);
  // La porte est appliquée hors-ligne sur l'extrait (elle est échantillon par échantillon).
  const work = Array.from({ length: nCh }, (_, c) => decoded.getChannelData(c).slice(0, len));
  applyGate(work, sr);

  liveCtx = new (window.AudioContext || window.webkitAudioContext)();
  const buf = liveCtx.createBuffer(nCh, len, sr);
  work.forEach((w, c) => buf.copyToChannel(w, c));
  const src = liveCtx.createBufferSource(); src.buffer = buf;
  buildChain(liveCtx, src).connect(liveCtx.destination);
  src.onended = stopPreview;
  src.start();
  els.previewBtn.textContent = '⏹️ Arrêter la pré-écoute';
  setStatus('🎧 Pré-écoute avec les réglages actuels…');
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
    a.download = 'audio_studio.m4a';
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

window.addEventListener('beforeunload', () => { stopPreview(); freeUrls(); });
