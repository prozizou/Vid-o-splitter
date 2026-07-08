import { FFmpeg } from '/vendor/ffmpeg/index.js';
import { fetchFile } from '/vendor/util/index.js';

// ==================== CONFIGURATION ====================
const CONFIG = {
  windowSec:     0.03,   // taille de fenêtre d'analyse audio
  minSilenceDur: 0.40,   // durée mini d'un silence pour être coupé (slider)
  minSegmentDur: 0.30,   // on jette les segments conservés trop courts
  padding:       0.08,   // marge conservée avant/après la voix (slider)
  sensitivity:   1.0,    // multiplicateur du seuil adaptatif (slider)
  audioFadeSec:  0.008,  // micro-fondu anti-clic à chaque raccord
  absFloor:      0.004,  // plancher d'amplitude absolu
  crf:           23,     // qualité vidéo (slider) : bas = meilleure qualité
  maxSegments:   500     // au-delà, on prévient (filter_complex trop lourd)
};

const LONG_VIDEO_SEC = 1800; // 30 min : au-delà, avertissement mémoire

// ==================== DOM ====================
const $ = id => document.getElementById(id);
const dropZone = $('dropZone'), fileInput = $('fileInput'), processBtn = $('processBtn');
const statusDiv = $('status'), progressContainer = $('progressContainer'), progressBar = $('progressBar');
const logOutput = $('logOutput'), downloadLink = $('downloadLink'), preview = $('preview');

let videoFile = null;
let currentURL = null;   // pour révoquer l'ancien blob
let ffmpeg = null;       // instance réutilisée

// ==================== SLIDERS ====================
const bind = (id, valId, fmt, key) => {
  const el = $(id);
  const upd = () => { CONFIG[key] = parseFloat(el.value); $(valId).textContent = fmt(el.value); };
  el.addEventListener('input', upd); upd();
};
bind('sens', 'sensVal', v => `${(+v).toFixed(1)}×`, 'sensitivity');
bind('sil',  'silVal',  v => `${(+v).toFixed(2)} s`, 'minSilenceDur');
bind('pad',  'padVal',  v => `${(+v).toFixed(2)} s`, 'padding');
bind('crf',  'crfVal',  v => {
  const n = +v;
  if (n <= 20) return 'Haute (fichier + gros)';
  if (n <= 25) return 'Équilibrée';
  return 'Légère (fichier + petit)';
}, 'crf');

// ==================== FICHIER ====================
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', handleFile);
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) { fileInput.files = e.dataTransfer.files; handleFile(); }
});

function handleFile() {
  const file = fileInput.files[0];
  if (!file) return;
  videoFile = file;
  setStatus(`✅ Vidéo chargée : ${file.name} (${(file.size / 1048576).toFixed(1)} Mo)`);
  processBtn.disabled = false;
  hideResult();
  probeAndWarn(file); // avertissement mémoire pour les vidéos longues
}

// Lit juste les métadonnées (pas tout le fichier) pour connaître la durée.
function probeDuration(file) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    const u = URL.createObjectURL(file);
    v.preload = 'metadata';
    v.onloadedmetadata = () => { URL.revokeObjectURL(u); resolve(v.duration || 0); };
    v.onerror = () => { URL.revokeObjectURL(u); resolve(0); };
    v.src = u;
  });
}

async function probeAndWarn(file) {
  const dur = await probeDuration(file);
  if (videoFile !== file) return; // un autre fichier a été chargé entre-temps
  if (dur > LONG_VIDEO_SEC) {
    const min = Math.round(dur / 60);
    setStatus(`⚠️ Vidéo de ~${min} min : le traitement peut être long et saturer la mémoire du navigateur. Envisagez de la découper en 2–3 parties.`, 'warn');
  }
}

function hideResult() {
  downloadLink.classList.add('hidden');
  preview.pause();
  preview.removeAttribute('src');
  preview.load();
  preview.classList.add('hidden');
}

function setStatus(msg, cls = '') { statusDiv.className = cls; statusDiv.textContent = msg; }
function log(msg) {
  logOutput.classList.remove('hidden');
  logOutput.textContent += msg + '\n';
  logOutput.scrollTop = logOutput.scrollHeight;
}

// ==================== DÉTECTION DES SILENCES ====================
// Renvoie une liste de segments [start, end] à CONSERVER.
async function detectSegments(onProgress) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error("Ce navigateur ne supporte pas l'analyse audio (AudioContext). Essayez Chrome ou Edge à jour.");
  const audioCtx = new AudioCtx();
  let audioBuffer;
  try {
    const arr = await videoFile.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(arr);
  } catch (e) {
    audioCtx.close();
    throw new Error("Impossible de décoder l'audio. La vidéo possède-t-elle bien une piste audio ? (" + e.message + ")");
  }
  const sr = audioBuffer.sampleRate;
  const dur = audioBuffer.duration;
  const len = audioBuffer.length;
  const ch = audioBuffer.numberOfChannels;

  if (!len || !dur) { audioCtx.close(); throw new Error("Piste audio vide."); }

  // Mixdown mono (moyenne des canaux) → plus robuste que « canal 0 » uniquement
  const data = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const cd = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) data[i] += cd[i] / ch;
  }
  audioCtx.close();

  // Énergie RMS par fenêtre — boucle découpée pour ne pas geler l'UI
  const win = Math.max(1, Math.floor(sr * CONFIG.windowSec));
  const winSec = win / sr;
  const nWin = Math.ceil(len / win);
  const loud = new Float32Array(nWin);
  let wi = 0;
  for (let i = 0; i < len; i += win) {
    const end = Math.min(i + win, len);
    let sum = 0, n = 0;
    for (let j = i; j < end; j++) { const s = data[j]; sum += s * s; n++; }
    loud[wi++] = Math.sqrt(sum / n);
    if ((wi & 2047) === 0) { onProgress(i / len); await new Promise(r => setTimeout(r)); }
  }

  // Seuil ADAPTATIF : à partir du bruit de fond réel du fichier
  const sorted = Float32Array.from(loud).sort();
  const pct = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const noiseFloor = pct(0.10);   // ~ bruit de fond
  const loudRef    = pct(0.90);   // ~ niveau de la voix
  let thr = Math.max(noiseFloor * 2.5, loudRef * 0.06);
  thr = Math.max(thr / CONFIG.sensitivity, CONFIG.absFloor);

  // Machine à états : on bride les silences courts (< minSilenceDur)
  const minSilWin = Math.max(1, Math.round(CONFIG.minSilenceDur / winSec));
  const raw = [];
  let start = null, lastLoud = -1;
  for (let k = 0; k < nWin; k++) {
    if (loud[k] > thr) {
      if (start === null) start = k;
      lastLoud = k;
    } else if (start !== null && (k - lastLoud) >= minSilWin) {
      raw.push([start * winSec, (lastLoud + 1) * winSec]);
      start = null;
    }
  }
  if (start !== null) raw.push([start * winSec, Math.min(dur, (lastLoud + 1) * winSec)]);

  // Marge + fusion des segments qui se chevauchent après marge
  const padded = raw.map(([s, e]) => [Math.max(0, s - CONFIG.padding), Math.min(dur, e + CONFIG.padding)]);
  const merged = [];
  for (const [s, e] of padded) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const final = merged.filter(([s, e]) => e - s >= CONFIG.minSegmentDur);
  if (final.length === 0) final.push([0, dur]); // sécurité : on garde tout

  const kept = final.reduce((a, [s, e]) => a + (e - s), 0);
  return { segments: final, duration: dur, kept, threshold: thr };
}

// Empêche un blocage infini : rejette si l'initialisation dépasse le délai.
function withTimeout(promise, ms, message) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

let usingMT = false;

// ==================== FFMPEG (fichiers auto-hébergés, same-origin) ====================
async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => { if (!message.includes('frame=')) log(message); });
  ffmpeg.on('progress', ({ progress }) => {
    const p = Math.max(0, Math.min(1, progress || 0));
    progressBar.style.width = `${Math.round(p * 100)}%`;
  });

  // Multi-thread possible UNIQUEMENT si la page est « cross-origin isolated »
  // (en-têtes COOP/COEP servis par Vercel). Sinon on retombe sur le mono-thread.
  usingMT = (self.crossOriginIsolated === true);
  const coreDir = usingMT ? '/vendor/core-mt' : '/vendor/core-st';
  log(usingMT
    ? '⚡ Mode multi-thread activé (tous les cœurs).'
    : 'ℹ️ Mode mono-thread (isolation cross-origin absente — voir README).');

  const opts = {
    classWorkerURL: '/vendor/ffmpeg/worker.js',
    coreURL: `${coreDir}/ffmpeg-core.js`,
    wasmURL: `${coreDir}/ffmpeg-core.wasm`,
  };
  if (usingMT) opts.workerURL = `${coreDir}/ffmpeg-core.worker.js`;

  log('⚙️ Initialisation du moteur ffmpeg...');
  await withTimeout(
    ffmpeg.load(opts), 120000,
    "L'initialisation de ffmpeg a expiré. Vérifiez que le dossier /vendor a bien été généré au build."
  );
  log('✅ ffmpeg prêt.');
  return ffmpeg;
}

function buildFilter(segments) {
  const parts = [];
  segments.forEach(([s, e], i) => {
    const d = e - s;
    const f = Math.min(CONFIG.audioFadeSec, d / 2);
    parts.push(`[0:v]trim=start=${s.toFixed(4)}:end=${e.toFixed(4)},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(
      `[0:a]atrim=start=${s.toFixed(4)}:end=${e.toFixed(4)},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=${f.toFixed(4)},afade=t=out:st=${(d - f).toFixed(4)}:d=${f.toFixed(4)}[a${i}]`
    );
  });
  const inputs = segments.map((_, i) => `[v${i}][a${i}]`).join('');
  return `${parts.join(';')};${inputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`;
}

async function processWithFFmpeg(segments) {
  const ff = await getFFmpeg();
  const ext = (videoFile.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
  const inName = `input.${ext}`;

  await ff.writeFile(inName, await fetchFile(videoFile));
  const filter = buildFilter(segments);

  log(`✂️ Assemblage de ${segments.length} segment(s)${usingMT ? ' (multi-thread)' : ''}...`);
  await ff.exec([
    '-i', inName,
    '-filter_complex', filter,
    '-map', '[outv]', '-map', '[outa]',
    '-threads', '0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(CONFIG.crf),
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    'output.mp4'
  ]);

  const data = await ff.readFile('output.mp4');
  // Nettoyage du FS virtuel pour libérer la mémoire
  try { await ff.deleteFile(inName); await ff.deleteFile('output.mp4'); } catch {}

  if (currentURL) URL.revokeObjectURL(currentURL); // évite les fuites entre 2 traitements
  currentURL = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));

  // Prévisualisation : on joue le rendu AVANT tout export
  preview.src = currentURL;
  preview.classList.remove('hidden');
  preview.load();

  downloadLink.href = currentURL;
  downloadLink.classList.remove('hidden');
}

// ==================== FLUX PRINCIPAL ====================
processBtn.addEventListener('click', async () => {
  if (!videoFile) return;
  processBtn.disabled = true;
  hideResult();
  logOutput.classList.add('hidden'); logOutput.textContent = '';
  progressContainer.classList.remove('hidden'); progressBar.style.width = '0%';
  setStatus('🔍 Analyse audio en cours...');

  try {
    const { segments, duration, kept } = await detectSegments(r => {
      progressBar.style.width = `${Math.round(r * 100)}%`;
    });

    const saved = duration - kept;
    setStatus(`🎤 ${segments.length} segment(s) — ${saved.toFixed(1)} s de silence retirés sur ${duration.toFixed(1)} s.`);

    if (segments.length > CONFIG.maxSegments) {
      setStatus(`⚠️ ${segments.length} segments : augmentez « silence minimum » pour alléger le traitement.`, 'warn');
    }
    if (duration > 120 || segments.length > 60) {
      log(`⚠️ Vidéo de ${Math.round(duration)} s / ${segments.length} segments : l'encodage sur mobile peut prendre plusieurs minutes. Astuce : testez d'abord avec un clip court (10–20 s) pour valider.`);
    }

    progressBar.style.width = '0%';
    await processWithFFmpeg(segments);
    setStatus('🎉 Terminé ! Cliquez pour télécharger.');
  } catch (err) {
    console.error(err);
    let msg = '❌ Erreur : ' + err.message;
    if (/Worker|import|module|fetch|network|Failed/i.test(err.message)) {
      msg += ' — Problème de chargement de ffmpeg depuis le CDN. Vérifiez votre connexion (ffmpeg.wasm se télécharge au premier lancement) et réessayez.';
    }
    setStatus(msg, 'err');
  } finally {
    processBtn.disabled = false;
  }
});

window.addEventListener('beforeunload', () => { if (currentURL) URL.revokeObjectURL(currentURL); });
