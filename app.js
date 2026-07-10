import { FFmpeg } from '/vendor/ffmpeg/index.js';
import { turboSupported, turboAnalyze, turboRenderAll, turboJoin } from './turbo.js';

// ==================== CONFIGURATION ====================
const CONFIG = {
  windowSec:     0.03,   // fenêtre d'analyse audio
  minSilenceDur: 0.40,   // durée mini d'un silence pour être coupé
  minSegmentDur: 0.30,   // on jette les segments conservés trop courts
  padding:       0.08,   // marge conservée avant/après la voix
  sensitivity:   1.0,    // multiplicateur du seuil adaptatif
  audioFadeSec:  0.008,  // micro-fondu anti-clic à chaque raccord
  absFloor:      0.004,  // plancher d'amplitude absolu
  crf:           23,     // qualité vidéo : bas = meilleure qualité
  chunkMode:     'auto', // 'auto' | 'off' | durée d'une partie en secondes
};

const ANALYSIS_SR       = 8000; // Hz : piste mono basse fréquence pour l'analyse
const AUTO_CHUNK_ABOVE  = 300;  // au-delà de 5 min, découpe automatique
const AUTO_CHUNK_SEC    = 240;  // durée cible d'une partie en mode auto
const MAX_SEG_PER_CHUNK = 40;   // une partie ne dépasse jamais 40 segments

// Encodage forcé, identique sur toutes les parties : sinon la réunion
// sans réencodage échoue (paramètres de flux incompatibles).
const V_ARGS = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
const A_ARGS = ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2'];

// ==================== ÉGALISEUR ====================
const EQ_FREQS = [80, 200, 500, 1000, 3000, 6000, 12000];
const EQ_PRESETS = {
  flat:     { g: [0, 0, 0, 0, 0, 0, 0],        highpass: false, normalize: false },
  clear:    { g: [-6, -3, -1, 1, 3, 2, 0],     highpass: true,  normalize: false },
  podcast:  { g: [-3, 1, -2, 0, 2, 1, -1],     highpass: true,  normalize: true  },
  denoise:  { g: [-9, -3, 0, 1, 1, -3, -6],    highpass: true,  normalize: true  },
};
const EQ = {
  preset: 'flat',
  gains: [...EQ_PRESETS.flat.g],
  q: 1.0,
  highpass: false,
  normalize: false,
  linear: false,
};

// ==================== DOM ====================
const $ = id => document.getElementById(id);
const dropZone = $('dropZone'), fileInput = $('fileInput');
const processBtn = $('processBtn'), pauseBtn = $('pauseBtn'), joinBtn = $('joinBtn');
const statusDiv = $('status'), logOutput = $('logOutput');
const progressContainer = $('progressContainer'), progressBar = $('progressBar');
const progressMeta = $('progressMeta'), progressPct = $('progressPct');
const progressPhase = $('progressPhase'), progressEta = $('progressEta');
const partsSection = $('partsSection'), partsList = $('partsList'), partsTag = $('partsTag');
const preview = $('preview'), downloadLink = $('downloadLink');
const resumeBanner = $('resumeBanner');

let videoFile = null;
let ffmpeg = null;
let usingMT = false;
let canMount = false;
let running = false;
let paused = false;
let job = null;          // { key, chunks: [...], duration }
let engine = 'turbo';    // 'turbo' (WebCodecs) | 'compat' (ffmpeg.wasm)
let finalURL = null;

// ==================== UTILITAIRES ====================
// setTimeout est bridé à 1 s quand l'onglet passe en arrière-plan.
// MessageChannel ne l'est pas : la boucle d'analyse continue à pleine vitesse.
const _chan = new MessageChannel();
const _waiters = [];
_chan.port1.onmessage = () => { const w = _waiters.shift(); if (w) w(); };
const yieldNow = () => new Promise(r => { _waiters.push(r); _chan.port2.postMessage(0); });

const clamp01 = x => Math.max(0, Math.min(1, x || 0));
const fmtTime = s => {
  if (!isFinite(s) || s < 0) return '—';
  s = Math.round(s);
  const m = Math.floor(s / 60);
  return m ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
};
const fmtSize = b => `${(b / 1048576).toFixed(1)} Mo`;

function setStatus(msg, cls = '') { statusDiv.className = cls; statusDiv.textContent = msg; }
function log(msg) {
  logOutput.classList.remove('hidden');
  logOutput.textContent += msg + '\n';
  logOutput.scrollTop = logOutput.scrollHeight;
}

// ==================== PROGRESSION ====================
// Chaque commande ffmpeg rapporte sa propre progression : on la replace dans
// une phase globale, et on estime le temps restant sur les secondes traitées.
let phase = { base: 0, span: 1, label: '' };
let clock = { start: 0, doneSec: 0, totalSec: 0, curSec: 0, curFrac: 0 };

function setPhase(base, span, label) {
  phase = { base, span, label: label || phase.label };
  progressPhase.textContent = phase.label;
}
function paintProgress(p) {
  const v = clamp01(p);
  progressBar.style.width = `${(v * 100).toFixed(1)}%`;
  progressPct.textContent = `${Math.round(v * 100)} %`;
}
function phaseProgress(frac) {
  clock.curFrac = clamp01(frac);
  paintProgress(phase.base + clock.curFrac * phase.span);
  updateEta();
}
function updateEta() {
  if (!clock.start || !clock.totalSec) { progressEta.textContent = ''; return; }
  const done = clock.doneSec + clock.curSec * clock.curFrac;
  if (done < 3) { progressEta.textContent = 'estimation…'; return; }
  const elapsed = (performance.now() - clock.start) / 1000;
  const speed = done / elapsed;                       // secondes de vidéo par seconde
  const left = (clock.totalSec - done) / Math.max(speed, 1e-6);
  progressEta.textContent = `~${fmtTime(left)} restantes · ${speed.toFixed(2)}×`;
}
function showProgress(on) {
  progressContainer.classList.toggle('hidden', !on);
  progressMeta.classList.toggle('hidden', !on);
}

// ==================== ARRIÈRE-PLAN ====================
// Le navigateur ne peut PAS continuer si l'app est fermée. En revanche :
// - le Wake Lock empêche la mise en veille de l'écran ;
// - ffmpeg tourne dans un Worker, donc l'onglet en arrière-plan continue ;
// - chaque partie terminée est sauvegardée, donc rien n'est perdu si ça coupe.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release(); wakeLock = null;
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) keepAwake(true);
});

async function askNotify() {
  try { if (window.Notification && Notification.permission === 'default') await Notification.requestPermission(); } catch {}
}
async function notify(title, body) {
  try {
    if (!window.Notification || Notification.permission !== 'granted') return;
    const reg = navigator.serviceWorker && await navigator.serviceWorker.ready;
    if (reg && reg.showNotification) reg.showNotification(title, { body, icon: '/icons/icon-192.png', tag: 'vsc' });
    else new Notification(title, { body, icon: '/icons/icon-192.png' });
  } catch {}
}

// ==================== SAUVEGARDE (IndexedDB) ====================
// Les parties terminées survivent à une fermeture d'onglet ou à un plantage.
const DB_NAME = 'silence-cutter', PARTS = 'parts', META = 'meta';
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(PARTS)) d.createObjectStore(PARTS);
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbPut(store, key, val) {
  try {
    const d = await openDB();
    await new Promise((res, rej) => {
      const t = d.transaction(store, 'readwrite');
      t.objectStore(store).put(val, key);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  } catch {}
}
async function dbGet(store, key) {
  try {
    const d = await openDB();
    return await new Promise((res, rej) => {
      const t = d.transaction(store, 'readonly');
      const q = t.objectStore(store).get(key);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  } catch { return undefined; }
}
async function dbWipe() {
  try {
    const d = await openDB();
    await new Promise(res => {
      const t = d.transaction([PARTS, META], 'readwrite');
      t.objectStore(PARTS).clear(); t.objectStore(META).clear();
      t.oncomplete = res; t.onerror = res;
    });
  } catch {}
}
const fileKey = f => `${f.name}|${f.size}|${f.lastModified}`;

async function saveJobMeta() {
  if (!job) return;
  await dbPut(META, 'job', {
    key: job.key, duration: job.duration,
    chunks: job.chunks.map(c => ({ t0: c.t0, t1: c.t1, kept: c.kept, status: c.status === 'done' ? 'done' : 'pending' })),
  });
}

// ==================== RÉGLAGES (UI) ====================
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

const chunkSel = $('chunk');
chunkSel.addEventListener('change', () => { CONFIG.chunkMode = chunkSel.value; });
CONFIG.chunkMode = chunkSel.value;

// --- Choix du moteur ---
const engineSel = $('engine'), engineNote = $('engineNote');
const TURBO_OK = turboSupported();
function refreshEngine() {
  engine = engineSel.value === 'compat' || !TURBO_OK ? 'compat' : 'turbo';
  engineNote.textContent = engine === 'turbo'
    ? '⚡ Encodage par la puce vidéo du téléphone. 10× à 50× plus rapide.'
    : (TURBO_OK
        ? '🐢 Encodage logiciel ffmpeg. Plus lent, mais accepte tous les formats.'
        : '🐢 WebCodecs indisponible sur ce navigateur : moteur logiciel utilisé.');
}
if (!TURBO_OK) { engineSel.value = 'compat'; engineSel.disabled = true; }
engineSel.addEventListener('change', refreshEngine);
refreshEngine();

// --- Égaliseur ---
const eqPreset = $('eqPreset'), eqBands = $('eqBands'), eqTag = $('eqTag');
const eqHighpass = $('eqHighpass'), eqNormalize = $('eqNormalize'), eqLinear = $('eqLinear');

const fmtHz = f => (f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`);
EQ_FREQS.forEach((f, i) => {
  const wrap = document.createElement('div');
  wrap.className = 'eq-band';
  wrap.innerHTML =
    `<input type="range" class="eq-slider" data-i="${i}" min="-12" max="12" step="1" value="0" orient="vertical"
            aria-label="Gain ${fmtHz(f)}">
     <b id="eqG${i}">0</b><span>${fmtHz(f)}</span>`;
  eqBands.appendChild(wrap);
});
function paintEQ() {
  EQ_FREQS.forEach((_, i) => {
    eqBands.querySelector(`[data-i="${i}"]`).value = EQ.gains[i];
    $(`eqG${i}`).textContent = (EQ.gains[i] > 0 ? '+' : '') + EQ.gains[i];
  });
  eqHighpass.checked = EQ.highpass;
  eqNormalize.checked = EQ.normalize;
  eqLinear.checked = EQ.linear;
  eqPreset.value = EQ.preset;
  const active = EQ.gains.some(g => g !== 0) || EQ.highpass || EQ.normalize;
  eqTag.textContent = active ? (eqPreset.selectedOptions[0]?.textContent.split(' (')[0] || 'Actif') : 'Neutre';
  eqTag.classList.toggle('tag-on', active);
}
function applyPreset(name) {
  const p = EQ_PRESETS[name];
  if (!p) { EQ.preset = 'custom'; paintEQ(); return; }
  EQ.preset = name;
  EQ.gains = [...p.g];
  EQ.highpass = p.highpass;
  EQ.normalize = p.normalize;
  paintEQ();
}
eqPreset.addEventListener('change', () => applyPreset(eqPreset.value));
eqBands.addEventListener('input', e => {
  const i = +e.target.dataset.i;
  if (Number.isNaN(i)) return;
  EQ.gains[i] = +e.target.value;
  EQ.preset = 'custom';
  paintEQ();
});
eqHighpass.addEventListener('change', () => { EQ.highpass = eqHighpass.checked; EQ.preset = 'custom'; paintEQ(); });
eqNormalize.addEventListener('change', () => { EQ.normalize = eqNormalize.checked; EQ.preset = 'custom'; paintEQ(); });
eqLinear.addEventListener('change', () => { EQ.linear = eqLinear.checked; });
$('eqReset').addEventListener('click', () => applyPreset('flat'));
paintEQ();

// Chaîne de filtres audio appliquée APRÈS le recollage des segments.
function audioChain(linear) {
  const f = [];
  if (EQ.highpass) f.push('highpass=f=85');
  const active = EQ_FREQS.map((freq, i) => ({ freq, g: EQ.gains[i] })).filter(b => b.g !== 0);
  if (active.length) {
    if (linear) {
      // firequalizer = phase linéaire (pas de déphasage entre les bandes)
      const entries = active.map(b => `entry(${b.freq},${b.g})`).join(';');
      f.push(`firequalizer=gain_entry='${entries}'`);
    } else {
      active.forEach(b => f.push(`equalizer=f=${b.freq}:width_type=q:width=${EQ.q}:g=${b.g}`));
    }
  }
  if (EQ.normalize) f.push('dynaudnorm=f=250:g=7');
  return f;
}

// ==================== FICHIER ====================
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', handleFile);
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) { fileInput.files = e.dataTransfer.files; handleFile(); }
});

async function handleFile() {
  const file = fileInput.files[0];
  if (!file || running) return;
  videoFile = file;
  resetOutput();
  setStatus(`✅ Vidéo chargée : ${file.name} (${fmtSize(file.size)})`);
  processBtn.disabled = false;
  processBtn.textContent = '🔪 Détecter et couper les silences';

  const dur = await probeDuration(file);
  if (videoFile !== file) return;
  if (dur > AUTO_CHUNK_ABOVE) {
    setStatus(`✅ ${file.name} — ~${Math.round(dur / 60)} min. Traitement par parties.`);
  }
  await tryResume(file);
}

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

function resetOutput() {
  if (finalURL) { URL.revokeObjectURL(finalURL); finalURL = null; }
  preview.pause(); preview.removeAttribute('src'); preview.load();
  preview.classList.add('hidden');
  downloadLink.classList.add('hidden');
  partsSection.classList.add('hidden');
  partsList.innerHTML = '';
  joinBtn.classList.add('hidden');
  showProgress(false);
}

// ==================== REPRISE ====================
async function tryResume(file) {
  const meta = await dbGet(META, 'job');
  resumeBanner.classList.add('hidden');
  if (!meta || meta.key !== fileKey(file)) return;

  const chunks = [];
  let doneCount = 0;
  for (let i = 0; i < meta.chunks.length; i++) {
    const c = { ...meta.chunks[i], index: i, segs: null, blob: null, status: 'pending' };
    if (meta.chunks[i].status === 'done') {
      const b = await dbGet(PARTS, `${meta.key}:${i}`);
      if (b) { c.blob = b; c.status = 'done'; doneCount++; }
    }
    chunks.push(c);
  }
  if (!doneCount) return;

  resumeBanner.classList.remove('hidden');
  resumeBanner.innerHTML =
    `<b>Session précédente retrouvée.</b> ${doneCount}/${chunks.length} parties déjà traitées.
     <button class="btn btn-ghost" id="dropResume" type="button">Repartir de zéro</button>`;
  $('dropResume').addEventListener('click', async () => {
    await dbWipe(); job = null; resetOutput(); resumeBanner.classList.add('hidden');
  });

  job = { key: meta.key, duration: meta.duration, chunks };
  renderParts();
  processBtn.textContent = `▶️ Reprendre (${chunks.length - doneCount} parties restantes)`;
}

// ==================== MOTEUR FFMPEG ====================
function withTimeout(promise, ms, message) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => { if (!message.includes('frame=')) log(message); });
  ffmpeg.on('progress', ({ progress }) => phaseProgress(progress));

  usingMT = (self.crossOriginIsolated === true);
  const coreDir = usingMT ? '/vendor/core-mt' : '/vendor/core-st';
  log(usingMT ? '⚡ Mode multi-thread activé.' : 'ℹ️ Mode mono-thread (voir README).');

  const opts = {
    classWorkerURL: '/vendor/ffmpeg/worker.js',
    coreURL: `${coreDir}/ffmpeg-core.js`,
    wasmURL: `${coreDir}/ffmpeg-core.wasm`,
  };
  if (usingMT) opts.workerURL = `${coreDir}/ffmpeg-core.worker.js`;

  log('⚙️ Initialisation du moteur ffmpeg...');
  await withTimeout(ffmpeg.load(opts), 120000,
    "L'initialisation de ffmpeg a expiré. Vérifiez que /vendor a bien été généré au build.");
  canMount = typeof ffmpeg.mount === 'function' && typeof ffmpeg.createDir === 'function';
  log('✅ ffmpeg prêt.');
  return ffmpeg;
}

async function resetFFmpeg() {
  if (!ffmpeg) return;
  try { await ffmpeg.terminate(); } catch {}
  ffmpeg = null;
}

// ffmpeg.exec renvoie un code de sortie : on le transforme en exception.
async function run(ff, args) {
  const code = await ff.exec(args);
  if (typeof code === 'number' && code !== 0) throw new Error(`ffmpeg a échoué (code ${code})`);
}

// Monte des Blobs en lecture seule : ffmpeg les lit SANS les recopier dans le
// tas WebAssembly (limité à ~2 Go). C'est ce qui rend les vidéos longues possibles.
async function mountBlobs(ff, dir, blobs) {
  await ff.createDir(dir).catch(() => {});
  await ff.mount('WORKERFS', { blobs }, dir);
}
async function unmountQuiet(ff, dir) { try { await ff.unmount(dir); } catch {} }

async function openInput(ff) {
  const ext = (videoFile.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
  const name = `input.${ext}`;
  if (canMount) {
    try {
      await mountBlobs(ff, '/src', [{ name, data: videoFile }]);
      return { path: `/src/${name}`, cleanup: () => unmountQuiet(ff, '/src') };
    } catch { canMount = false; log('ℹ️ Lecture directe indisponible : copie en mémoire.'); }
  }
  const { fetchFile } = await import('/vendor/util/index.js');
  await ff.writeFile(name, await fetchFile(videoFile));
  return { path: name, cleanup: async () => { try { await ff.deleteFile(name); } catch {} } };
}

// ==================== ANALYSE AUDIO ====================
async function extractPCM(ff, inPath) {
  log('🎧 Extraction de la piste audio pour analyse...');
  await run(ff, ['-i', inPath, '-vn', '-ac', '1', '-ar', String(ANALYSIS_SR),
    '-f', 's16le', '-acodec', 'pcm_s16le', 'audio.raw']);
  let raw;
  try { raw = await ff.readFile('audio.raw'); }
  catch { throw new Error("Aucune piste audio exploitable dans cette vidéo."); }
  try { await ff.deleteFile('audio.raw'); } catch {}
  if (!raw || raw.length < 2) throw new Error("La piste audio est vide : rien à analyser.");
  return new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
}

// Enveloppe RMS calculée sur le PCM extrait par ffmpeg (moteur compatible).
function loudFromPCM(pcm, sr) {
  const len = pcm.length;
  const win = Math.max(1, Math.floor(sr * CONFIG.windowSec));
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

// À partir de l'enveloppe RMS : seuil adaptatif puis machine à états.
function segmentsFromLoud(loud, winSec, duration) {
  const nWin = loud.length;
  const sorted = Float32Array.from(loud).sort();
  const pct = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  let thr = Math.max(pct(0.10) * 2.5, pct(0.90) * 0.06);
  thr = Math.max(thr / CONFIG.sensitivity, CONFIG.absFloor);

  const minSilWin = Math.max(1, Math.round(CONFIG.minSilenceDur / winSec));
  const raw = [];
  let start = null, lastLoud = -1;
  for (let k = 0; k < nWin; k++) {
    if (loud[k] > thr) { if (start === null) start = k; lastLoud = k; }
    else if (start !== null && (k - lastLoud) >= minSilWin) { raw.push([start * winSec, (lastLoud + 1) * winSec]); start = null; }
  }
  if (start !== null) raw.push([start * winSec, Math.min(duration, (lastLoud + 1) * winSec)]);

  const padded = raw.map(([s, e]) => [Math.max(0, s - CONFIG.padding), Math.min(duration, e + CONFIG.padding)]);
  const merged = [];
  for (const [s, e] of padded) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const final = merged.filter(([s, e]) => e - s >= CONFIG.minSegmentDur);
  if (final.length === 0) final.push([0, duration]);

  const kept = final.reduce((a, [s, e]) => a + (e - s), 0);
  return { segments: final, duration, kept };
}

// ==================== PLAN DE DÉCOUPE ====================
// Une partie = un paquet de segments consécutifs. Les frontières tombent
// toujours dans un silence supprimé : aucune coupe au milieu d'un mot.
function planChunks(segments, duration) {
  let target;
  if (CONFIG.chunkMode === 'off') target = Infinity;
  else if (CONFIG.chunkMode === 'auto') target = duration > AUTO_CHUNK_ABOVE ? AUTO_CHUNK_SEC : Infinity;
  else target = parseFloat(CONFIG.chunkMode);

  const groups = [];
  if (!isFinite(target)) groups.push(segments);
  else {
    let cur = [];
    for (const seg of segments) {
      if (cur.length && (seg[1] - cur[0][0] > target || cur.length >= MAX_SEG_PER_CHUNK)) { groups.push(cur); cur = []; }
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

function buildFilter(segs, offset, chain) {
  const parts = [];
  segs.forEach(([s, e], i) => {
    const S = Math.max(0, s - offset);
    const E = Math.max(S + 0.02, e - offset);
    const d = E - S;
    const f = Math.min(CONFIG.audioFadeSec, d / 2);
    parts.push(`[0:v:0]trim=start=${S.toFixed(4)}:end=${E.toFixed(4)},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(
      `[0:a:0]atrim=start=${S.toFixed(4)}:end=${E.toFixed(4)},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=${f.toFixed(4)},afade=t=out:st=${(d - f).toFixed(4)}:d=${f.toFixed(4)}[a${i}]`
    );
  });
  const inputs = segs.map((_, i) => `[v${i}][a${i}]`).join('');
  let g = `${parts.join(';')};${inputs}concat=n=${segs.length}:v=1:a=1[outv][araw]`;
  g += chain.length ? `;[araw]${chain.join(',')}[outa]` : ';[araw]anull[outa]';
  return g;
}

// ==================== RENDU D'UNE PARTIE ====================
async function renderChunk(ff, inPath, c) {
  const name = `part_${String(c.index).padStart(3, '0')}.mp4`;
  const argsFor = chain => ([
    '-ss', c.t0.toFixed(3),
    '-t', (c.t1 - c.t0).toFixed(3),
    '-i', inPath,
    '-filter_complex', buildFilter(c.segs, c.t0, chain),
    '-map', '[outv]', '-map', '[outa]',
    '-threads', '0',
    ...V_ARGS, '-crf', String(CONFIG.crf),
    ...A_ARGS,
    '-movflags', '+faststart',
    name,
  ]);

  // Repli automatique : phase linéaire -> biquad -> aucun filtre audio.
  const ladder = [];
  if (EQ.linear) ladder.push({ chain: audioChain(true), note: null });
  ladder.push({ chain: audioChain(false), note: EQ.linear ? '⚠️ Phase linéaire indisponible : égaliseur classique utilisé.' : null });
  ladder.push({ chain: [], note: '⚠️ Égaliseur indisponible : partie encodée sans traitement audio.' });

  let lastErr;
  for (let i = 0; i < ladder.length; i++) {
    const step = ladder[i];
    if (i > 0 && JSON.stringify(step.chain) === JSON.stringify(ladder[i - 1].chain)) continue;
    try {
      await run(ff, argsFor(step.chain));
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      try { await ff.deleteFile(name); } catch {}
      if (i === ladder.length - 1) throw e;
      if (step.chain.length === 0) throw e;
      log(ladder[i + 1].note || '⚠️ Nouvel essai avec des filtres audio simplifiés.');
    }
  }
  if (lastErr) throw lastErr;

  const data = await ff.readFile(name);
  try { await ff.deleteFile(name); } catch {}
  // La partie quitte immédiatement le tas WebAssembly : le Blob vit côté
  // navigateur (déchargeable sur disque), la mémoire de ffmpeg reste basse.
  return new Blob([data.buffer], { type: 'video/mp4' });
}

// ==================== RÉUNION DES PARTIES ====================
async function joinParts(ff, chunks) {
  const named = chunks.map(c => ({ name: `p${String(c.index).padStart(3, '0')}.mp4`, data: c.blob }));

  const doJoin = async (dir) => {
    const list = named.map(n => `file '${dir}/${n.name}'`).join('\n') + '\n';
    await ff.writeFile('list.txt', new TextEncoder().encode(list));
    await run(ff, ['-f', 'concat', '-safe', '0', '-i', 'list.txt',
      '-c', 'copy', '-movflags', '+faststart', 'final.mp4']);
    try { await ff.deleteFile('list.txt'); } catch {}
    const data = await ff.readFile('final.mp4');
    try { await ff.deleteFile('final.mp4'); } catch {}
    return new Blob([data.buffer], { type: 'video/mp4' });
  };

  if (canMount) {
    try {
      await mountBlobs(ff, '/parts', named);
      try { return await doJoin('/parts'); }
      finally { await unmountQuiet(ff, '/parts'); }
    } catch { log('ℹ️ Réunion directe impossible : passage en mémoire.'); }
  }
  const { fetchFile } = await import('/vendor/util/index.js');
  for (const n of named) await ff.writeFile(n.name, await fetchFile(n.data));
  try { return await doJoin('.'); }
  finally { for (const n of named) { try { await ff.deleteFile(n.name); } catch {} } }
}

// ==================== LISTE DES PARTIES ====================
function renderParts() {
  if (!job) return;
  partsSection.classList.remove('hidden');
  partsList.innerHTML = '';
  job.chunks.forEach(c => partsList.appendChild(partRow(c)));
  refreshPartsTag();
}

function partRow(c) {
  const row = document.createElement('div');
  row.className = 'part';
  row.id = `part-${c.index}`;
  row.innerHTML = `
    <div class="part-head">
      <b>Partie ${c.index + 1}</b>
      <span class="part-time">${fmtTime(c.t0)} → ${fmtTime(c.t1)} · ${c.segs ? c.segs.length + ' segments' : ''}</span>
      <span class="part-status" id="ps-${c.index}"></span>
    </div>
    <div class="part-body" id="pb-${c.index}"></div>`;
  updatePartRow(c);
  return row;
}

function updatePartRow(c) {
  const st = $(`ps-${c.index}`), body = $(`pb-${c.index}`);
  if (!st) return;
  const labels = { pending: '⏳ En attente', running: '⚙️ En cours…', done: '✅ Prêt', error: '❌ Échec' };
  st.textContent = labels[c.status] || '';
  st.className = `part-status st-${c.status}`;

  if (c.status === 'done' && c.blob && !body.dataset.filled) {
    body.dataset.filled = '1';
    const url = URL.createObjectURL(c.blob);
    body.innerHTML = '';
    const v = document.createElement('video');
    v.controls = true; v.playsInline = true; v.preload = 'metadata'; v.src = url;
    v.className = 'part-preview';
    const a = document.createElement('a');
    a.className = 'btn btn-ghost btn-small';
    a.href = url; a.download = `partie_${c.index + 1}.mp4`;
    a.textContent = `⬇️ Enregistrer cette partie (${fmtSize(c.blob.size)})`;
    body.append(v, a);
  }
}

function refreshPartsTag() {
  const done = job.chunks.filter(c => c.status === 'done').length;
  partsTag.textContent = `${done}/${job.chunks.length}`;
  const all = done === job.chunks.length;
  joinBtn.classList.toggle('hidden', !done);
  joinBtn.disabled = !all || running;
  joinBtn.textContent = all
    ? '🧩 Réunir toutes les parties'
    : `🧩 Réunir (${job.chunks.length - done} partie(s) manquante(s))`;
}

// ==================== FLUX PRINCIPAL ====================
processBtn.addEventListener('click', async () => {
  if (!videoFile || running) return;
  running = true; paused = false;
  processBtn.disabled = true;
  pauseBtn.classList.remove('hidden');
  logOutput.textContent = '';
  showProgress(true); paintProgress(0);
  await askNotify();
  await keepAwake(true);

  let input = null, ff = null;
  try {

    // --- 1. Analyse (sautée si on reprend une session) --------------
    if (!job || job.chunks.some(c => !c.segs && c.status !== 'done')) {
      setStatus('🔍 Analyse audio en cours...');
      setPhase(0, 0.08, 'Analyse audio');

      let loud, winSec, duration;
      if (engine === 'turbo') {
        try {
          ({ loud, winSec, duration } = await turboAnalyze(videoFile, CONFIG.windowSec, phaseProgress));
        } catch (e) {
          log('⚠️ Analyse turbo impossible (' + e.message + '). Passage au moteur logiciel.');
          engine = 'compat';
        }
      }
      if (engine === 'compat') {
        ff = await getFFmpeg();
        input = await openInput(ff);
        const pcm = await extractPCM(ff, input.path);
        ({ loud, winSec, duration } = loudFromPCM(pcm, ANALYSIS_SR));
      }

      setPhase(0.08, 0.02, 'Détection des silences');
      const { segments, kept } = segmentsFromLoud(loud, winSec, duration);
      await yieldNow();
      log(`🎤 ${segments.length} segments — ${fmtTime(duration - kept)} de silence retiré sur ${fmtTime(duration)}.`);

      const fresh = planChunks(segments, duration);
      if (job && job.key === fileKey(videoFile) && job.chunks.length === fresh.length) {
        fresh.forEach((f, i) => { job.chunks[i].segs = f.segs; });
      } else {
        await dbWipe();
        job = { key: fileKey(videoFile), duration, chunks: fresh };
      }
      await saveJobMeta();
      renderParts();
    }

    const todo = job.chunks.filter(c => c.status !== 'done');
    if (!todo.length) { setStatus('✅ Toutes les parties sont déjà prêtes. Réunissez-les.'); return; }

    // --- 2. Traitement partie par partie ---------------------------
    clock = { start: performance.now(), doneSec: 0, totalSec: todo.reduce((a, c) => a + c.kept, 0), curSec: 0, curFrac: 0 };

    const finishPart = async (c, blob) => {
      c.blob = blob; c.status = 'done';
      await dbPut(PARTS, `${job.key}:${c.index}`, blob);
      await saveJobMeta();
      updatePartRow(c); refreshPartsTag();
      await yieldNow();
    };

    if (engine === 'turbo') {
      try {
        await turboRenderAll(videoFile, job.chunks, {
          crf: CONFIG.crf, fadeSec: CONFIG.audioFadeSec,
          eq: { freqs: EQ_FREQS, gains: EQ.gains, q: EQ.q, highpass: EQ.highpass, normalize: EQ.normalize },
        }, {
          shouldStop: () => paused,
          onPartStart: c => {
            c.status = 'running'; updatePartRow(c);
            setStatus(`⚡ Partie ${c.index + 1}/${job.chunks.length} — ${c.segs.length} segment(s)`);
            setPhase(0.10, 0.88, `Partie ${c.index + 1}/${job.chunks.length}`);
            clock.curSec = c.kept; clock.curFrac = 0;
          },
          onProgress: sec => {
            clock.doneSec = sec; clock.curSec = 0; clock.curFrac = 0;
            paintProgress(0.10 + 0.88 * (sec / Math.max(clock.totalSec, 1e-6)));
            updateEta();
          },
          onPartDone: finishPart,
        });
      } catch (e) {
        const doneAny = job.chunks.some(c => c.status === 'done');
        log('⚠️ Moteur turbo interrompu : ' + e.message);
        if (doneAny) throw e;
        log('↩️ Bascule sur le moteur logiciel ffmpeg.');
        engine = 'compat';
        engineSel.value = 'compat'; refreshEngine();
        job.chunks.forEach(c => { if (c.status !== 'done') c.status = 'pending'; updatePartRow(c); });
      }
    }

    if (engine === 'compat') {
      if (!ff) { ff = await getFFmpeg(); }
      if (!input) { input = await openInput(ff); }
      const left = job.chunks.filter(c => c.status !== 'done');
      const span = 0.88 / Math.max(left.length, 1);
      for (let k = 0; k < left.length; k++) {
        if (paused) { setStatus('⏸️ En pause. Les parties terminées sont conservées.'); break; }
        const c = left[k];
        c.status = 'running'; updatePartRow(c);
        setStatus(`⚙️ Partie ${c.index + 1}/${job.chunks.length} — ${c.segs.length} segment(s)`);
        setPhase(0.10 + k * span, span, `Partie ${c.index + 1}/${job.chunks.length}`);
        clock.curSec = c.kept; clock.curFrac = 0;
        try {
          await finishPart(c, await renderChunk(ff, input.path, c));
        } catch (e) {
          c.status = 'error'; updatePartRow(c); refreshPartsTag(); throw e;
        }
        clock.doneSec += c.kept; clock.curSec = 0; clock.curFrac = 0;
      }
    }

    if (!paused) paintProgress(1);
    const done = job.chunks.filter(c => c.status === 'done').length;
    if (!paused) {
      const speed = clock.totalSec && clock.start
        ? ` (${(clock.doneSec / ((performance.now() - clock.start) / 1000)).toFixed(1)}× temps réel)` : '';
      setStatus(`🎉 ${done}/${job.chunks.length} parties prêtes${speed}. Vérifiez les aperçus, puis réunissez-les.`);
      notify('Traitement terminé', `${done} partie(s) prêtes à être réunies.`);
    }
  } catch (err) {
    console.error(err);
    let msg = '❌ Erreur : ' + err.message;
    if (/memory|allocat|OOM|abort/i.test(err.message || '')) {
      msg = '❌ Mémoire saturée. Choisissez des parties plus courtes (2 min) puis relancez : les parties déjà prêtes sont conservées.';
      await resetFFmpeg();
    } else if (/Worker|import|module|fetch|network|Failed/i.test(err.message || '')) {
      msg += " — Échec de chargement du moteur ffmpeg. Vérifiez la connexion, puis réessayez.";
    }
    setStatus(msg, 'err');
    notify('Traitement interrompu', err.message);
  } finally {
    if (input) { try { await input.cleanup(); } catch {} }
    running = false; paused = false;
    pauseBtn.classList.add('hidden');
    pauseBtn.textContent = '⏸️ Mettre en pause';
    processBtn.disabled = false;
    if (job) {
      const left = job.chunks.filter(c => c.status !== 'done').length;
      processBtn.textContent = left ? `▶️ Reprendre (${left} partie(s) restantes)` : '🔁 Retraiter la vidéo';
      refreshPartsTag();
    }
    await keepAwake(false);
  }
});

pauseBtn.addEventListener('click', () => {
  if (!running) return;
  paused = true;
  pauseBtn.disabled = true;
  pauseBtn.textContent = '⏸️ Pause après la partie en cours…';
  setStatus('⏸️ Pause demandée : la partie en cours se termine…');
});

joinBtn.addEventListener('click', async () => {
  if (!job || running) return;
  const parts = job.chunks.filter(c => c.status === 'done' && c.blob);
  if (parts.length !== job.chunks.length) return;

  running = true;
  joinBtn.disabled = true; processBtn.disabled = true;
  showProgress(true); setPhase(0, 1, 'Réunion des parties'); paintProgress(0);
  clock = { start: 0, doneSec: 0, totalSec: 0, curSec: 0, curFrac: 0 };
  setStatus('🧩 Réunion des parties (copie directe, sans réencodage)...');
  await keepAwake(true);

  try {
    let blob;
    if (engine === 'turbo') {
      try { blob = await turboJoin(parts.map(c => c.blob)); }
      catch (e) { log('⚠️ Réunion turbo impossible (' + e.message + '). Passage à ffmpeg.'); }
    }
    if (!blob) {
      const ff = await getFFmpeg();
      blob = await joinParts(ff, parts);
    }
    paintProgress(1);

    if (finalURL) URL.revokeObjectURL(finalURL);
    finalURL = URL.createObjectURL(blob);
    preview.src = finalURL; preview.classList.remove('hidden'); preview.load();
    downloadLink.href = finalURL; downloadLink.classList.remove('hidden');
    setStatus(`🎉 Vidéo finale prête — ${fmtSize(blob.size)}.`);
    notify('Vidéo finale prête', `${fmtSize(blob.size)} — prête à enregistrer.`);
    preview.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    console.error(err);
    setStatus('❌ Réunion impossible : ' + err.message + ' — vos parties restent enregistrables une par une.', 'err');
  } finally {
    running = false;
    processBtn.disabled = false;
    refreshPartsTag();
    await keepAwake(false);
  }
});

window.addEventListener('beforeunload', e => {
  if (running) { e.preventDefault(); e.returnValue = ''; }
  if (finalURL) URL.revokeObjectURL(finalURL);
});
