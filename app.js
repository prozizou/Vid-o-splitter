import { FFmpeg } from '/vendor/ffmpeg/index.js';
import { turboSupported, turboAnalyze, turboRenderAll, turboJoin, turboMerge } from './turbo.js';
import { SFX_TYPES, makeBedWav } from './sfx.js';

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
  videoFadeSec:  0.06,   // fondu au noir de part et d'autre de chaque raccord
  sfxType:       'none', // son de transition (voir SFX_TYPES)
  sfxGainDb:     -18,    // volume du son de transition
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
const queueSection = $('queueSection'), queueList = $('queueList');
const queueTag = $('queueTag'), queueHint = $('queueHint'), queueClear = $('queueClear');

let sourceFiles = [];    // vidéos ajoutées par l'utilisateur, dans l'ordre de fusion
let videoFile = null;    // fichier réellement traité (source unique OU fusion des sources)
let mergedBlob = null;   // résultat de la fusion, mis en cache
let mergedSig = '';      // signature des sources ayant produit mergedBlob
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

// --- Transitions ---
const fadeSel = $('fade'), fadeVal = $('fadeVal');
const sfxSel = $('sfx'), sfxGain = $('sfxGain'), sfxGainVal = $('sfxGainVal'), sfxTest = $('sfxTest');

for (const [k, label] of Object.entries(SFX_TYPES)) {
  const o = document.createElement('option');
  o.value = k; o.textContent = label;
  sfxSel.appendChild(o);
}
sfxSel.value = CONFIG.sfxType;

const fadeLabel = v => (v === 0 ? 'Aucun' : v <= 0.05 ? `Très léger (${Math.round(v * 1000)} ms)`
                       : v <= 0.10 ? `Léger (${Math.round(v * 1000)} ms)` : `Marqué (${Math.round(v * 1000)} ms)`);
const fxTag = $('fxTag');
function paintFx() {
  const bits = [];
  if (CONFIG.videoFadeSec > 0) bits.push('Fondu');
  if (CONFIG.sfxType !== 'none') bits.push(SFX_TYPES[CONFIG.sfxType]);
  fxTag.textContent = bits.length ? bits.join(' + ') : 'Coupe franche';
  fxTag.classList.toggle('tag-on', bits.length > 0);
}
fadeSel.addEventListener('input', () => { CONFIG.videoFadeSec = +fadeSel.value; fadeVal.textContent = fadeLabel(CONFIG.videoFadeSec); paintFx(); });
fadeVal.textContent = fadeLabel(CONFIG.videoFadeSec);
fadeSel.value = CONFIG.videoFadeSec;

sfxSel.addEventListener('change', () => {
  CONFIG.sfxType = sfxSel.value;
  sfxTest.disabled = CONFIG.sfxType === 'none';
  sfxGain.disabled = CONFIG.sfxType === 'none';
  paintFx();
});
sfxGain.addEventListener('input', () => { CONFIG.sfxGainDb = +sfxGain.value; sfxGainVal.textContent = `${CONFIG.sfxGainDb} dB`; });
sfxGainVal.textContent = `${CONFIG.sfxGainDb} dB`;
sfxTest.disabled = true; sfxGain.disabled = true;
paintFx();

// Écoute du son choisi, sans rien traiter.
sfxTest.addEventListener('click', async () => {
  if (CONFIG.sfxType === 'none') return;
  const { renderSfx } = await import('./sfx.js');
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const s = renderSfx(CONFIG.sfxType, ctx.sampleRate);
  const buf = ctx.createBuffer(1, s.length, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const g = Math.pow(10, CONFIG.sfxGainDb / 20) * 6; // remonté pour l'écoute seule
  for (let i = 0; i < s.length; i++) d[i] = Math.max(-1, Math.min(1, s[i] * g));
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination); src.start();
  src.onended = () => ctx.close().catch(() => {});
});

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

// ==================== FICHIER(S) ====================
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
queueClear.addEventListener('click', () => { if (!running) { sourceFiles = []; sourcesChanged(); } });

// Signature d'un jeu de sources : sert de clé de reprise et de cache de fusion.
const srcSig = () => sourceFiles.map(fileKey).join('||');
const currentKey = () => sourceFiles.length <= 1
  ? (sourceFiles[0] ? fileKey(sourceFiles[0]) : '')
  : 'merge|' + srcSig();

// Ajoute des fichiers à la file, en ignorant les doublons (même nom/taille/date).
function addFiles(list) {
  if (running) return;
  const seen = new Set(sourceFiles.map(fileKey));
  let added = 0;
  for (const f of list) {
    if (!f.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name)) continue;
    const k = fileKey(f);
    if (seen.has(k)) continue;
    seen.add(k); sourceFiles.push(f); added++;
  }
  if (added) sourcesChanged();
}
function removeFile(i) { if (running) return; sourceFiles.splice(i, 1); sourcesChanged(); }
function moveFile(i, dir) {
  if (running) return;
  const j = i + dir;
  if (j < 0 || j >= sourceFiles.length) return;
  [sourceFiles[i], sourceFiles[j]] = [sourceFiles[j], sourceFiles[i]];
  sourcesChanged();
}

// Toute modification de la liste invalide la fusion et la session en cours.
async function sourcesChanged() {
  mergedBlob = null; mergedSig = '';
  videoFile = sourceFiles.length === 1 ? sourceFiles[0] : null;
  job = null;
  resetOutput();
  renderQueue();

  if (sourceFiles.length === 0) {
    processBtn.disabled = true;
    processBtn.textContent = '🔪 Détecter et couper les silences';
    setStatus('');
    return;
  }
  processBtn.disabled = false;
  processBtn.textContent = sourceFiles.length > 1
    ? '🔗 Fusionner puis couper les silences'
    : '🔪 Détecter et couper les silences';

  if (sourceFiles.length === 1) {
    setStatus(`✅ Vidéo chargée : ${sourceFiles[0].name} (${fmtSize(sourceFiles[0].size)})`);
  } else {
    setStatus(`✅ ${sourceFiles.length} vidéos — elles seront fusionnées dans l'ordre affiché.`);
  }

  // Estimation de la durée totale (indicatif, pour le mode « parties automatiques »).
  const sigAtProbe = srcSig();
  const durs = await Promise.all(sourceFiles.map(probeDuration));
  if (srcSig() !== sigAtProbe) return; // la liste a changé pendant la sonde
  const total = durs.reduce((a, d) => a + d, 0);
  queueHint.textContent = total > 0
    ? `Durée totale : ~${fmtTime(total)}${total > AUTO_CHUNK_ABOVE ? ' — traitement par parties.' : ''}`
    : '';
  await tryResume();
}

function renderQueue() {
  const n = sourceFiles.length;
  queueSection.classList.toggle('hidden', n < 2);
  queueTag.textContent = String(n);
  queueClear.classList.toggle('hidden', n === 0);
  queueList.innerHTML = '';
  sourceFiles.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.innerHTML = `
      <span class="queue-num">${i + 1}</span>
      <span class="queue-info">
        <span class="queue-name">${escapeHtml(f.name)}</span>
        <span class="queue-meta">${fmtSize(f.size)}</span>
      </span>
      <span class="queue-btns">
        <button type="button" class="qup" title="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="qdown" title="Descendre" ${i === n - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="qdel" title="Retirer">✕</button>
      </span>`;
    row.querySelector('.qup').addEventListener('click', () => moveFile(i, -1));
    row.querySelector('.qdown').addEventListener('click', () => moveFile(i, +1));
    row.querySelector('.qdel').addEventListener('click', () => removeFile(i));
    queueList.appendChild(row);
  });
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ==================== FUSION DES SOURCES ====================
// Produit UN seul MP4 à partir de toutes les vidéos ajoutées. Voie rapide :
// réempilage des paquets sans réencodage (turboMerge) quand les formats
// concordent. Repli : concaténation + réencodage uniforme via ffmpeg.
async function ensureMerged() {
  if (sourceFiles.length === 1) return sourceFiles[0];
  if (mergedBlob && mergedSig === srcSig()) return mergedBlob;

  setStatus(`🔗 Fusion de ${sourceFiles.length} vidéos…`);
  setPhase(0, 0.05, 'Fusion des vidéos'); paintProgress(0);

  let blob = null;
  if (engine === 'turbo') {
    try {
      blob = await turboMerge(sourceFiles, f => phaseProgress(f));
      log(`🔗 Fusion rapide (sans réencodage) de ${sourceFiles.length} vidéos.`);
    } catch (e) {
      if (e.message === 'INCOMPATIBLE') log('ℹ️ Formats vidéo différents : fusion avec réencodage (plus lent).');
      else log('⚠️ Fusion rapide impossible (' + e.message + '). Réencodage via ffmpeg.');
    }
  }
  if (!blob) {
    const ff = await getFFmpeg();
    blob = await ffmpegMerge(ff, sourceFiles);
    log(`🔗 Fusion (réencodage) de ${sourceFiles.length} vidéos terminée.`);
  }

  mergedBlob = new File([blob], 'fusion.mp4', { type: 'video/mp4', lastModified: Date.now() });
  mergedSig = srcSig();
  paintProgress(0.05);
  return mergedBlob;
}

// Repli robuste : met toutes les entrées au même format (échelle + fps + audio)
// puis les concatène. Réencode l'ensemble — c'est le prix d'accepter des formats
// hétérogènes (résolutions, codecs, WebM/MKV…).
async function ffmpegMerge(ff, files) {
  // Dimensions cible = première vidéo (sinon 1280×720 par défaut).
  let W = 0, H = 0;
  try { ({ w: W, h: H } = await probeSize(files[0])); } catch {}
  if (!W || !H) { W = 1280; H = 720; }
  W += W % 2; H += H % 2; // libx264 exige des dimensions paires
  const FPS = 30;

  const named = files.map((f, i) => {
    const ext = (f.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
    return { name: `m${String(i).padStart(2, '0')}.${ext}`, data: f };
  });

  const doMerge = async (dir) => {
    const inputs = [];
    named.forEach(n => inputs.push('-i', `${dir}/${n.name}`));
    const vf = [], af = [], cc = [];
    named.forEach((_, i) => {
      cc.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS},format=yuv420p[v${i}]`);
      cc.push(`[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`);
      vf.push(`[v${i}]`); af.push(`[a${i}]`);
    });
    const pairs = named.map((_, i) => `[v${i}][a${i}]`).join('');
    const graph = cc.join(';') + ';' + pairs + `concat=n=${named.length}:v=1:a=1[outv][outa]`;
    await run(ff, [
      ...inputs,
      '-filter_complex', graph,
      '-map', '[outv]', '-map', '[outa]',
      '-threads', '0',
      ...V_ARGS, '-crf', String(CONFIG.crf),
      ...A_ARGS,
      '-movflags', '+faststart',
      'merged.mp4',
    ]);
    const data = await ff.readFile('merged.mp4');
    try { await ff.deleteFile('merged.mp4'); } catch {}
    return new Blob([data.buffer], { type: 'video/mp4' });
  };

  if (canMount) {
    try {
      await mountBlobs(ff, '/merge', named);
      try { return await doMerge('/merge'); }
      finally { await unmountQuiet(ff, '/merge'); }
    } catch { log('ℹ️ Fusion directe impossible : copie en mémoire.'); }
  }
  const { fetchFile } = await import('/vendor/util/index.js');
  for (const n of named) await ff.writeFile(n.name, await fetchFile(n.data));
  try { return await doMerge('.'); }
  finally { for (const n of named) { try { await ff.deleteFile(n.name); } catch {} } }
}

function probeSize(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    const u = URL.createObjectURL(file);
    v.preload = 'metadata';
    v.onloadedmetadata = () => { URL.revokeObjectURL(u); resolve({ w: v.videoWidth, h: v.videoHeight }); };
    v.onerror = () => { URL.revokeObjectURL(u); reject(new Error('métadonnées illisibles')); };
    v.src = u;
  });
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
async function tryResume() {
  const meta = await dbGet(META, 'job');
  resumeBanner.classList.add('hidden');
  if (!meta || meta.key !== currentKey()) return;

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

function buildFilter(segs, offset, chain, opts) {
  const { fadeSec = 0, isFirst = true, isLast = true, hasBed = false } = opts || {};
  const parts = [];
  segs.forEach(([s, e], i) => {
    const S = Math.max(0, s - offset);
    const E = Math.max(S + 0.02, e - offset);
    const d = E - S;
    const f = Math.min(CONFIG.audioFadeSec, d / 2);

    // Fondu au noir : jamais sur le tout début du film ni sur sa toute fin.
    const vf = Math.min(fadeSec, d / 2.5);
    const fadeIn = vf > 0 && !(isFirst && i === 0);
    const fadeOut = vf > 0 && !(isLast && i === segs.length - 1);
    let vchain = `trim=start=${S.toFixed(4)}:end=${E.toFixed(4)},setpts=PTS-STARTPTS`;
    if (fadeIn) vchain += `,fade=t=in:st=0:d=${vf.toFixed(4)}`;
    if (fadeOut) vchain += `,fade=t=out:st=${(d - vf).toFixed(4)}:d=${vf.toFixed(4)}`;
    parts.push(`[0:v:0]${vchain}[v${i}]`);

    parts.push(
      `[0:a:0]atrim=start=${S.toFixed(4)}:end=${E.toFixed(4)},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=${f.toFixed(4)},afade=t=out:st=${(d - f).toFixed(4)}:d=${f.toFixed(4)}[a${i}]`
    );
  });
  const inputs = segs.map((_, i) => `[v${i}][a${i}]`).join('');
  let g = `${parts.join(';')};${inputs}concat=n=${segs.length}:v=1:a=1[outv][araw]`;
  g += chain.length ? `;[araw]${chain.join(',')}[aeq]` : ';[araw]anull[aeq]';

  if (hasBed) {
    // Le lit sonore est une 2e entrée : on aligne format et débit avant amix.
    // Attention : [a0]..[aN] sont déjà pris par les segments, d'où [mixA]/[mixB].
    const fmt = 'aformat=sample_rates=44100:channel_layouts=stereo';
    g += `;[aeq]${fmt}[mixA];[1:a]${fmt}[mixB];[mixA][mixB]amix=inputs=2:duration=first:normalize=0[outa]`;
  } else {
    g += ';[aeq]anull[outa]';
  }
  return g;
}

// ==================== RENDU D'UNE PARTIE ====================
async function renderChunk(ff, inPath, c) {
  const name = `part_${String(c.index).padStart(3, '0')}.mp4`;
  const isFirst = c.index === 0;
  const isLast = c.index === job.chunks.length - 1;

  // Instants des raccords dans la partie rendue (pour le son de transition).
  const sfxPts = [];
  let off = 0;
  c.segs.forEach(([s, e], i) => {
    if (!(isFirst && i === 0)) sfxPts.push(off);
    off += e - s;
  });
  const partDur = off;

  // Le lit sonore : un WAV silencieux de la durée de la partie, avec les
  // bruitages déjà placés. Une seule entrée supplémentaire pour ffmpeg.
  let bedWritten = false;
  const wantBed = CONFIG.sfxType !== 'none' && sfxPts.length > 0;
  if (wantBed) {
    const { fetchFile } = await import('/vendor/util/index.js');
    const wav = makeBedWav(partDur, 44100, sfxPts, CONFIG.sfxType, CONFIG.sfxGainDb);
    await ff.writeFile('bed.wav', await fetchFile(wav));
    bedWritten = true;
  }

  const argsFor = (chain, hasBed) => {
    const args = [
      '-ss', c.t0.toFixed(3),
      '-t', (c.t1 - c.t0).toFixed(3),
      '-i', inPath,
    ];
    if (hasBed) args.push('-i', 'bed.wav');
    args.push(
      '-filter_complex', buildFilter(c.segs, c.t0, chain, {
        fadeSec: CONFIG.videoFadeSec, isFirst, isLast, hasBed,
      }),
      '-map', '[outv]', '-map', '[outa]',
      '-threads', '0',
      ...V_ARGS, '-crf', String(CONFIG.crf),
      ...A_ARGS,
      '-movflags', '+faststart',
      name,
    );
    return args;
  };

  // Repli automatique : son+EQ -> son+biquad -> EQ seul -> rien.
  const ladder = [];
  if (EQ.linear) ladder.push({ chain: audioChain(true), bed: bedWritten });
  ladder.push({ chain: audioChain(false), bed: bedWritten, note: EQ.linear ? '⚠️ Phase linéaire indisponible : égaliseur classique utilisé.' : null });
  if (bedWritten) ladder.push({ chain: audioChain(false), bed: false, note: '⚠️ Mixage du son de transition impossible : partie rendue sans bruitage.' });
  ladder.push({ chain: [], bed: false, note: '⚠️ Filtres audio indisponibles : partie encodée sans traitement.' });

  try {
    let lastErr = null;
    for (let i = 0; i < ladder.length; i++) {
      const step = ladder[i];
      const prev = ladder[i - 1];
      if (prev && JSON.stringify(step.chain) === JSON.stringify(prev.chain) && step.bed === prev.bed) continue;
      try {
        await run(ff, argsFor(step.chain, step.bed));
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        try { await ff.deleteFile(name); } catch {}
        if (i === ladder.length - 1) throw e;
        log(ladder[i + 1].note || '⚠️ Nouvel essai avec des filtres simplifiés.');
      }
    }
    if (lastErr) throw lastErr;

    const data = await ff.readFile(name);
    try { await ff.deleteFile(name); } catch {}
    return new Blob([data.buffer], { type: 'video/mp4' });
  } finally {
    if (bedWritten) { try { await ff.deleteFile('bed.wav'); } catch {} }
  }
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
  if (!sourceFiles.length || running) return;
  running = true; paused = false;
  processBtn.disabled = true;
  pauseBtn.classList.remove('hidden');
  logOutput.textContent = '';
  showProgress(true); paintProgress(0);
  await askNotify();
  await keepAwake(true);

  let input = null, ff = null;
  try {

    // --- 0. Fusion des sources (transparente pour la suite) --------
    // Après cette étape, videoFile est UNE vidéo (source unique ou fusion),
    // et tout le pipeline ci-dessous fonctionne sans autre changement.
    videoFile = await ensureMerged();

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
      if (job && job.key === currentKey() && job.chunks.length === fresh.length) {
        fresh.forEach((f, i) => { job.chunks[i].segs = f.segs; });
      } else {
        await dbWipe();
        job = { key: currentKey(), duration, chunks: fresh };
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
          crf: CONFIG.crf,
          audioFadeSec: CONFIG.audioFadeSec,
          videoFadeSec: CONFIG.videoFadeSec,
          sfx: { type: CONFIG.sfxType, gainDb: CONFIG.sfxGainDb },
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
