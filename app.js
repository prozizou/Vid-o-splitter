// ffmpeg n'est PAS importé statiquement : en mode turbo il ne sert jamais, et
// un /vendor incomplet (build partiel) faisait échouer le chargement du module
// entier — donc la page entière, moteur turbo compris. Il est chargé à la
// demande dans getFFmpeg().
import { turboSupported, turboAnalyze, turboRenderAll, turboJoin, turboMerge, WHINE_NOTCHES, bitrateFor, align16, buildEqChain } from './turbo.js';
import { BGM_TYPES, renderBgm, makeBgWav } from './bgm.js';
import { BGM_AUDIO_TYPES, isBgmAudioType, preloadBgmAudio, renderBgmAudio, makeBgAudioWav } from './bgm-audio.js';
import { segmentsFromLoud, thresholdCurve, planChunks, loudFromPCM } from './silence.js';
import { fmtSize, fmtTime, probeDuration, attachLogTools } from './media.js';

// ==================== CONFIGURATION ====================
const CONFIG = {
  windowSec:     0.03,   // fenêtre d'analyse audio
  minSilenceDur: 0.40,   // durée mini d'un silence pour être coupé
  minSegmentDur: 0.30,   // on jette les segments conservés trop courts
  padding:       0.08,   // marge conservée avant/après la voix
  sensitivity:   1.0,    // multiplicateur du seuil adaptatif
  audioFadeSec:  0.008,  // micro-fondu anti-clic à chaque raccord
  absFloor:      0.004,  // plancher d'amplitude absolu
  crf:           23,     // qualité vidéo : bas = meilleure qualité (ajustée par le préréglage réseau social, voir SOCIAL_PRESETS)
  chunkMode:     'auto', // 'auto' | 'off' | durée d'une partie en secondes
  bgmType:       'none', // son de fond (voir BGM_TYPES)
  bgmGainDb:     -24,    // volume du son de fond : bas par défaut, c'est un fond, pas de la musique au premier plan
  socialPreset:  'tiktok', // réseau social visé (voir SOCIAL_PRESETS) : pilote la conversion ET la qualité suggérée
};

// Préréglages réseaux sociaux. La vidéo est convertie à ces dimensions/cadence
// AVANT que les silences ne soient coupés (mise à l'échelle « remplir » puis
// rognage centré, voir turbo-render.js). `output: null` = on garde la
// résolution/cadence source. `crf` est une suggestion appliquée au changement
// de préréglage (l'utilisateur peut ensuite l'ajuster manuellement).
// `maxSizeMB`/`maxDurationSec` sont indicatifs (non imposés par l'appli) : ils
// servent uniquement à comparer le résultat final et à avertir si besoin —
// les plateformes font évoluer ces limites, à prendre comme un ordre de
// grandeur plutôt qu'une garantie.
const SOCIAL_PRESETS = {
  tiktok: {
    label: 'TikTok',
    output: { width: 1080, height: 1920, fps: 30 },
    crf: 21,
    maxSizeMB: null,
    maxDurationSec: null,
    hint: 'Vertical 9:16 plein cadre, qualité élevée : TikTok tolère de gros fichiers pour un clip court.',
  },
  reels: {
    label: 'Instagram / Facebook Reels',
    output: { width: 1080, height: 1920, fps: 30 },
    crf: 22,
    maxSizeMB: null,
    maxDurationSec: 90,
    hint: 'Vertical 9:16. Un Reel dépasse rarement ~90 s (repère indicatif, pas une limite imposée ici).',
  },
  shorts: {
    label: 'YouTube Shorts',
    output: { width: 1080, height: 1920, fps: 30 },
    crf: 21,
    maxSizeMB: null,
    maxDurationSec: 180,
    hint: 'Vertical 9:16. Un Short dépasse rarement 3 min (repère indicatif, pas une limite imposée ici).',
  },
  whatsapp: {
    label: 'WhatsApp (statut / message)',
    output: { width: 720, height: 1280, fps: 30 },
    crf: 26,
    maxSizeMB: 16,
    maxDurationSec: 30,
    hint: 'Vertical 9:16, fichier volontairement compact : WhatsApp recompresse fortement au partage, autant lui donner un fichier déjà léger.',
  },
  facebook: {
    label: 'Facebook (publication horizontale)',
    output: { width: 1280, height: 720, fps: 30 },
    crf: 23,
    maxSizeMB: null,
    maxDurationSec: null,
    hint: 'Horizontal 16:9 classique pour le fil d\'actualité.',
  },
  source: {
    label: 'Conserver la source',
    output: null,
    crf: null,   // ne modifie pas le réglage qualité en cours
    maxSizeMB: null,
    maxDurationSec: null,
    hint: 'Résolution et cadence d\'origine : aucune conversion avant le découpage.',
  },
};

const ANALYSIS_SR       = 8000; // Hz : piste mono basse fréquence pour l'analyse
// Le découpage en parties dépend du MOTEUR, parce que ses deux raisons d'être
// n'ont pas le même poids selon la vitesse de rendu.
//
// ffmpeg encode à ~0,2× temps réel : sur une heure de vidéo, pouvoir reprendre
// après un plantage n'est pas un confort, c'est une nécessité. Et son
// `filter_complex` grossit de deux branches par segment conservé — au-delà
// d'une quarantaine, la commande devient ingérable.
//
// Le moteur turbo traite la même vidéo en quelques secondes, et un segment n'y
// coûte rien de structurel : juste une ligne de plus dans une table de
// correspondance. En revanche CHAQUE frontière de partie a un coût réel — un
// flush du décodeur (donc un groupe d'images à rejouer), un remultiplexage, et
// une couture de plus à l'assemblage. Autant en faire le moins possible.
const CHUNKING = {
  // Au-delà de cette durée, on découpe automatiquement.
  autoAbove: { turbo: 1200, compat: 300 },
  // Durée visée pour une partie.
  autoSec:   { turbo: 600,  compat: 240 },
  // Plafond de segments par partie. Sans objet en turbo.
  maxSeg:    { turbo: Infinity, compat: 40 },
};

// Réglages passés à silence.js (module pur, testé par `npm test`).
const silenceCfg = () => ({
  windowSec:     CONFIG.windowSec,
  minSilenceDur: CONFIG.minSilenceDur,
  minSegmentDur: CONFIG.minSegmentDur,
  padding:       CONFIG.padding,
  sensitivity:   CONFIG.sensitivity,
  absFloor:      CONFIG.absFloor,
});
const chunkOpts = () => ({
  chunkMode: CONFIG.chunkMode,
  autoAbove: CHUNKING.autoAbove[engine],
  autoSec: CHUNKING.autoSec[engine],
  maxSegPerChunk: CHUNKING.maxSeg[engine],
});

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
  // Sifflement electronique stable (~6,9 kHz / ~8,4 kHz) que certains
  // telephones injectent dans leurs propres enregistrements d'ecran, sous
  // charge CPU/GPU soutenue — capte par le micro, independant du contenu.
  // Case a part, PAS liee aux presets : ne concerne que les appareils
  // touches, contrairement aux reglages de timbre ci-dessus.
  whineNotch: false,
};

// ==================== DOM ====================
const $ = id => document.getElementById(id);
const dropZone = $('dropZone'), fileInput = $('fileInput');
const processBtn = $('processBtn'), pauseBtn = $('pauseBtn');
const statusDiv = $('status'), logOutput = $('logOutput');
const progressContainer = $('progressContainer'), progressBar = $('progressBar');
const progressMeta = $('progressMeta'), progressPct = $('progressPct');
const progressPhase = $('progressPhase'), progressEta = $('progressEta');
const partsSection = $('partsSection'), partsList = $('partsList'), partsTag = $('partsTag');
const finalInfoSection = $('finalInfoSection'), finalInfoBody = $('finalInfoBody'), finalSizeTag = $('finalSizeTag');
const preview = $('preview'), downloadLink = $('downloadLink');
const resumeBanner = $('resumeBanner');
const queueSection = $('queueSection'), queueList = $('queueList');
const queueTag = $('queueTag'), queueHint = $('queueHint'), queueClear = $('queueClear');
const analyzeBtn = $('analyzeBtn'), cutsSection = $('cutsSection');
const cutsCanvas = $('cutsCanvas'), cutsTag = $('cutsTag'), cutsHint = $('cutsHint');
const mixPreviewSection = $('mixPreviewSection'), mixPreviewBtn = $('mixPreviewBtn');
const mixPreviewAuto = $('mixPreviewAuto'), mixPreviewTag = $('mixPreviewTag'), mixPreviewAudio = $('mixPreviewAudio');

let sourceFiles = [];    // vidéos ajoutées par l'utilisateur, dans l'ordre de fusion
let videoFile = null;    // fichier réellement traité (source unique OU fusion des sources)
let mergedBlob = null;   // résultat de la fusion, mis en cache
let mergedSig = '';      // signature des sources ayant produit mergedBlob
let ffmpeg = null;
let usingMT = false;
let canMount = false;
let running = false;
let paused = false;
let finalizing = false;  // garde anti-réentrance de finalizeOutput(), distincte de `running`
let job = null;          // { key, chunks: [...], duration }
let engine = 'turbo';    // 'turbo' (WebCodecs) | 'compat' (ffmpeg.wasm)
let finalURL = null;
let analysis = null;     // { key, loud, winSec, duration } — enveloppe RMS mise en cache
let analyzing = false;
let storageWarned = false;

// Aperçu du rendu (voix + égaliseur + fond), voir ensureMixGraph/playMixPreview.
let mixCtx = null, mixSrcNode = null, mixBgSrcNode = null, mixAudioURL = null;
let mixStopTimer = null, mixPlaying = false, mixDebounce = null;

// ==================== UTILITAIRES ====================
// setTimeout est bridé à 1 s quand l'onglet passe en arrière-plan.
// MessageChannel ne l'est pas : la boucle d'analyse continue à pleine vitesse.
const _chan = new MessageChannel();
const _waiters = [];
_chan.port1.onmessage = () => { const w = _waiters.shift(); if (w) w(); };
const yieldNow = () => new Promise(r => { _waiters.push(r); _chan.port2.postMessage(0); });

const clamp01 = x => Math.max(0, Math.min(1, x || 0));

function setStatus(msg, cls = '') { statusDiv.className = cls; statusDiv.textContent = msg; }

// Boutons « Copier / Enregistrer » au-dessus du journal. C'est presque toujours
// lui qui explique un repli de moteur ou une lenteur, et le sélectionner à la
// main sur téléphone est pénible.
attachLogTools(logOutput, 'journal-splitter.txt');

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

// Une seule connexion, réutilisée : l'ancienne version en ouvrait une par
// lecture ET par écriture, sans jamais les fermer.
let _db = null;
function openDB() {
  if (_db) return _db;
  _db = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(PARTS)) d.createObjectStore(PARTS);
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { _db = null; rej(r.error); };
  }).catch(e => { _db = null; throw e; });
  return _db;
}

// Demande un stockage persistant : sans cela le navigateur (iOS en tête) peut
// évincer les parties déjà calculées sans prévenir.
(async () => {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {}
})();

/** @returns true si l'écriture a réellement abouti. */
async function dbPut(store, key, val) {
  try {
    const d = await openDB();
    await new Promise((res, rej) => {
      const t = d.transaction(store, 'readwrite');
      t.objectStore(store).put(val, key);
      t.oncomplete = res; t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('transaction annulée'));
    });
    return true;
  } catch (e) {
    // Avaler cette erreur — ce que faisait l'ancienne version — affichait
    // « ✅ Prêt » sur des parties qui n'étaient en réalité PAS sauvegardées.
    if (!storageWarned) {
      storageWarned = true;
      log(`⚠️ Sauvegarde impossible (${e && e.message ? e.message : 'espace insuffisant'}).`);
      log('   Les parties restent en mémoire : enregistrez-les au fur et à mesure,');
      log('   elles seront perdues si l\'onglet se ferme.');
    }
    return false;
  }
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
/** Présence d'une clé, SANS matérialiser le blob en mémoire (getKey). */
async function dbHas(store, key) {
  try {
    const d = await openDB();
    return await new Promise((res, rej) => {
      const t = d.transaction(store, 'readonly');
      const q = t.objectStore(store).getKey(key);
      q.onsuccess = () => res(q.result !== undefined); q.onerror = () => rej(q.error);
    });
  } catch { return false; }
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
    socialPreset: job.socialPreset, crf: job.crf, engine: job.engine,
    chunks: job.chunks.map(c => ({ t0: c.t0, t1: c.t1, kept: c.kept, status: c.status === 'done' ? 'done' : 'pending' })),
  });
}

// ==================== RÉGLAGES (UI) ====================
const bind = (id, valId, fmt, key, affectsCuts = false) => {
  const el = $(id);
  const upd = () => {
    CONFIG[key] = parseFloat(el.value);
    $(valId).textContent = fmt(el.value);
    if (affectsCuts) queueCutsRefresh();
  };
  el.addEventListener('input', upd); upd();
};
bind('sens', 'sensVal', v => `${(+v).toFixed(1)}×`, 'sensitivity', true);
bind('sil',  'silVal',  v => `${(+v).toFixed(2)} s`, 'minSilenceDur', true);
bind('pad',  'padVal',  v => `${(+v).toFixed(2)} s`, 'padding', true);
// affectsCuts=true : la qualité vidéo ne change pas le découpage, mais la
// taille de fichier ESTIMÉE affichée sous le sélecteur réseau social en
// dépend — queueCutsRefresh() est le mécanisme déjà en place pour recalculer
// sans surcoût perceptible (voir paintSizeEstimate(), appelée par refreshCuts()).
bind('crf',  'crfVal',  v => {
  const n = +v;
  if (n <= 20) return 'Haute (fichier + gros)';
  if (n <= 25) return 'Équilibrée';
  return 'Légère (fichier + petit)';
}, 'crf', true);

/** Fixe la qualité vidéo par programme (préréglage réseau social) en
 * réutilisant EXACTEMENT la logique de bind('crf', ...) ci-dessus, plutôt que
 * de dupliquer le formatage du libellé. */
function setCrf(n) {
  const el = $('crf');
  el.value = String(n);
  el.dispatchEvent(new Event('input'));
}

const chunkSel = $('chunk');
chunkSel.addEventListener('change', () => { CONFIG.chunkMode = chunkSel.value; queueCutsRefresh(); });
CONFIG.chunkMode = chunkSel.value;

// --- Réseau social visé (conversion + qualité avant découpage) ---
const socialSel = $('socialPreset'), socialHint = $('socialHint');
function paintSocialHint() {
  const preset = SOCIAL_PRESETS[CONFIG.socialPreset] || SOCIAL_PRESETS.source;
  socialHint.textContent = preset.hint;
}
if (socialSel) {
  socialSel.addEventListener('change', () => {
    CONFIG.socialPreset = socialSel.value;
    const preset = SOCIAL_PRESETS[CONFIG.socialPreset] || SOCIAL_PRESETS.source;
    if (preset.crf != null) setCrf(preset.crf);
    paintSocialHint();
    queueCutsRefresh();
  });
  CONFIG.socialPreset = socialSel.value;
  paintSocialHint();
  // Applique la qualité suggérée par le préréglage sélectionné par défaut dans
  // le HTML, pour que le curseur « Qualité vidéo » reflète ce préréglage dès
  // le chargement plutôt que la valeur générique déclarée dans le markup.
  const initialCrf = (SOCIAL_PRESETS[CONFIG.socialPreset] || SOCIAL_PRESETS.source).crf;
  if (initialCrf != null) setCrf(initialCrf);
}

// --- Son de fond ---
// Deux familles dans le même sélecteur : ambiances SYNTHÉTISÉES (BGM_TYPES,
// bgm.js — aucun fichier, calculées à la volée) et ambiances ENREGISTRÉES
// (BGM_AUDIO_TYPES, bgm-audio.js — vrais sons de forêt/oiseaux/jungle,
// chargés une fois depuis /audio puis mis en cache). Même curseur de volume,
// même case à cocher, seule la provenance du son change.
const bgmSel = $('bgm'), bgmGain = $('bgmGain'), bgmGainVal = $('bgmGainVal'), bgmTest = $('bgmTest');
const BGM_LABELS = { ...BGM_TYPES, ...BGM_AUDIO_TYPES };

{
  const noneOpt = document.createElement('option');
  noneOpt.value = 'none'; noneOpt.textContent = BGM_TYPES.none;
  bgmSel.appendChild(noneOpt);

  const synthGroup = document.createElement('optgroup');
  synthGroup.label = 'Synthétisées';
  for (const [k, label] of Object.entries(BGM_TYPES)) {
    if (k === 'none') continue;
    const o = document.createElement('option');
    o.value = k; o.textContent = label;
    synthGroup.appendChild(o);
  }
  bgmSel.appendChild(synthGroup);

  const natureGroup = document.createElement('optgroup');
  natureGroup.label = 'Nature (enregistrements)';
  for (const [k, label] of Object.entries(BGM_AUDIO_TYPES)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = label;
    natureGroup.appendChild(o);
  }
  bgmSel.appendChild(natureGroup);
}
bgmSel.value = CONFIG.bgmType;

const bgmTag = $('bgmTag');
function paintBgm() {
  const on = CONFIG.bgmType !== 'none';
  bgmTag.textContent = on ? BGM_LABELS[CONFIG.bgmType] : 'Aucun';
  bgmTag.classList.toggle('tag-on', on);
}

// Précharge (fetch + décodage) une ambiance enregistrée dès qu'elle est
// choisie, plutôt qu'au moment du rendu : l'utilisateur voit l'erreur tout
// de suite si le fichier est inaccessible, et le traitement démarre sans
// attente supplémentaire (le cache de bgm-audio.js est déjà chaud).
async function ensureBgmReady(type) {
  if (!isBgmAudioType(type)) return;
  const prevLabel = bgmTag.textContent;
  bgmSel.disabled = true; bgmTest.disabled = true;
  bgmTag.textContent = 'Chargement…';
  try {
    await preloadBgmAudio(type);
  } catch (e) {
    log(`⚠️ ${e.message || e}`);
    CONFIG.bgmType = 'none'; bgmSel.value = 'none';
  } finally {
    bgmSel.disabled = false;
    bgmTest.disabled = CONFIG.bgmType === 'none';
    paintBgm();
    scheduleAutoPreview();
  }
}

bgmSel.addEventListener('change', () => {
  CONFIG.bgmType = bgmSel.value;
  bgmTest.disabled = CONFIG.bgmType === 'none';
  bgmGain.disabled = CONFIG.bgmType === 'none';
  paintBgm();
  ensureBgmReady(CONFIG.bgmType); // rappelle scheduleAutoPreview() une fois chargé (voir sa fin)
  scheduleAutoPreview();
});
bgmGain.addEventListener('input', () => {
  CONFIG.bgmGainDb = +bgmGain.value; bgmGainVal.textContent = `${CONFIG.bgmGainDb} dB`;
  scheduleAutoPreview();
});
bgmGainVal.textContent = `${CONFIG.bgmGainDb} dB`;
bgmTest.disabled = true; bgmGain.disabled = true;
paintBgm();

// Écoute de l'ambiance choisie (3 s), sans rien traiter.
bgmTest.addEventListener('click', async () => {
  if (CONFIG.bgmType === 'none') return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const n = Math.round(ctx.sampleRate * 3);
  let s;
  if (isBgmAudioType(CONFIG.bgmType)) {
    await ensureBgmReady(CONFIG.bgmType);
    if (CONFIG.bgmType === 'none') { await ctx.close().catch(() => {}); return; } // préchargement en échec
    s = renderBgmAudio(CONFIG.bgmType, ctx.sampleRate, n);
  } else {
    const { renderBgm } = await import('./bgm.js');
    s = renderBgm(CONFIG.bgmType, ctx.sampleRate, n);
  }
  const buf = ctx.createBuffer(1, s.length, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const g = Math.pow(10, CONFIG.bgmGainDb / 20) * 6; // remonté pour l'écoute seule
  for (let i = 0; i < s.length; i++) d[i] = Math.max(-1, Math.min(1, s[i] * g));
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination); src.start();
  src.onended = () => ctx.close().catch(() => {});
});

// --- Choix du moteur ---
//
// MODE DIAGNOSTIC : le repli automatique vers ffmpeg a été retiré du pipeline
// turbo (analyse, rendu, réunion). Une erreur turbo remonte donc telle quelle
// au lieu d'être masquée par un second essai en logiciel — c'est voulu, le
// temps d'observer comment le moteur turbo se comporte réellement et quelles
// erreurs il produit. ffmpeg reste le SEUL chemin quand WebCodecs est absent
// du navigateur : ça, ce n'est pas un repli sur erreur, c'est une incapacité
// matérielle qu'aucun réglage ne change.
const engineSel = $('engine'), engineNote = $('engineNote');
const TURBO_OK = turboSupported();
function refreshEngine() {
  engine = TURBO_OK ? 'turbo' : 'compat';
  engineNote.textContent = TURBO_OK
    ? '⚡ Encodage par la puce vidéo du téléphone. Mode diagnostic : aucun repli vers ffmpeg, une erreur turbo s\'affiche telle quelle.'
    : '🐢 WebCodecs indisponible sur ce navigateur : moteur logiciel ffmpeg utilisé (seul chemin possible ici).';
}
if (!TURBO_OK) engineSel.disabled = true;
// Le découpage en parties dépend du moteur : l'aperçu doit suivre.
engineSel.addEventListener('change', () => { refreshEngine(); queueCutsRefresh(); });
refreshEngine();

// --- Égaliseur ---
const eqPreset = $('eqPreset'), eqBands = $('eqBands'), eqTag = $('eqTag');
const eqHighpass = $('eqHighpass'), eqNormalize = $('eqNormalize'), eqLinear = $('eqLinear');
const eqWhineNotch = $('eqWhineNotch');

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
  eqWhineNotch.checked = EQ.whineNotch;
  eqPreset.value = EQ.preset;
  const active = EQ.gains.some(g => g !== 0) || EQ.highpass || EQ.normalize || EQ.whineNotch;
  eqTag.textContent = active ? (eqPreset.selectedOptions[0]?.textContent.split(' (')[0] || 'Actif') : 'Neutre';
  eqTag.classList.toggle('tag-on', active);
}
function applyPreset(name) {
  const p = EQ_PRESETS[name];
  if (!p) { EQ.preset = 'custom'; paintEQ(); scheduleAutoPreview(); return; }
  EQ.preset = name;
  EQ.gains = [...p.g];
  EQ.highpass = p.highpass;
  EQ.normalize = p.normalize;
  paintEQ();
  scheduleAutoPreview();
}
eqPreset.addEventListener('change', () => applyPreset(eqPreset.value));
eqBands.addEventListener('input', e => {
  const i = +e.target.dataset.i;
  if (Number.isNaN(i)) return;
  EQ.gains[i] = +e.target.value;
  EQ.preset = 'custom';
  paintEQ();
  scheduleAutoPreview();
});
eqHighpass.addEventListener('change', () => { EQ.highpass = eqHighpass.checked; EQ.preset = 'custom'; paintEQ(); scheduleAutoPreview(); });
eqNormalize.addEventListener('change', () => { EQ.normalize = eqNormalize.checked; EQ.preset = 'custom'; paintEQ(); scheduleAutoPreview(); });
eqLinear.addEventListener('change', () => { EQ.linear = eqLinear.checked; }); // ffmpeg seulement : sans effet sur l'aperçu (Web Audio), pas de relecture
// Pas de EQ.preset = 'custom' ici : comme eqLinear, c'est un reglage
// independant du timbre choisi, pas une modification du preset.
eqWhineNotch.addEventListener('change', () => { EQ.whineNotch = eqWhineNotch.checked; paintEQ(); scheduleAutoPreview(); });
$('eqReset').addEventListener('click', () => applyPreset('flat'));
paintEQ();

// Chaîne de filtres audio appliquée APRÈS le recollage des segments.
function audioChain(linear) {
  const f = [];
  if (EQ.highpass) f.push('highpass=f=85');
  // Avant l'egaliseur/dynaudnorm : meme raison que dans turbo.js applyEQ,
  // inutile de laisser un normaliseur amplifier un sifflement qu'on retire.
  if (EQ.whineNotch) {
    WHINE_NOTCHES.forEach(({ freq, q }) => f.push(`bandreject=f=${freq}:width_type=q:w=${q}`));
  }
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

// ==================== APERÇU DU RENDU (voix + égaliseur + fond) ====================
// Une fois les coupes analysées, on peut vérifier à l'oreille le résultat
// AVANT de lancer un traitement complet : on rejoue un vrai passage conservé
// depuis la source originale, avec l'égaliseur et le son de fond actuels
// appliqués en direct (Web Audio), et on relit automatiquement à chaque
// réglage si « Ré-écouter automatiquement » est coché (voir scheduleAutoPreview,
// branché sur les curseurs bgm/eq ci-dessus).
//
// Volontairement approximatif sur un point : on joue un segment conservé TEL
// QUEL depuis la source (pas le recollage exact de toutes les parties gardées
// comme le fera le rendu final) — largement suffisant pour juger d'un réglage
// de timbre ou de volume, sans réimplémenter tout le pipeline de découpe.
const MIX_PREVIEW_MAX_SEC = 8;

/** Choisit le plus long passage conservé (le plus susceptible d'être de la
 * parole franche plutôt qu'un souffle qui frôle le seuil), borné à 8 s. */
function pickPreviewWindow() {
  if (!analysis) return null;
  const { loud, winSec, duration } = analysis;
  const { segments } = segmentsFromLoud(loud, winSec, duration, silenceCfg());
  if (!segments.length) return null;
  let best = segments[0];
  for (const s of segments) if (s[1] - s[0] > best[1] - best[0]) best = s;
  const [s0, e0] = best;
  return { start: s0, dur: Math.min(MIX_PREVIEW_MAX_SEC, e0 - s0) };
}

function setMixStatus(text) { mixPreviewTag.textContent = text; }

function stopMixPreview() {
  clearTimeout(mixStopTimer); mixStopTimer = null;
  if (mixPlaying) { try { mixPreviewAudio.pause(); } catch {} mixPlaying = false; }
  if (mixBgSrcNode) { try { mixBgSrcNode.stop(); } catch {} mixBgSrcNode = null; }
  mixPreviewBtn.textContent = '▶️ Écouter un extrait avec ces réglages';
}

/** Referme tout (contexte + URL objet) : à appeler quand la source change,
 * puisque le graphe est lié au fichier chargé au premier aperçu. */
function resetMixGraph() {
  stopMixPreview();
  if (mixSrcNode) { try { mixSrcNode.disconnect(); } catch {} mixSrcNode = null; }
  if (mixCtx) { mixCtx.close().catch(() => {}); mixCtx = null; }
  if (mixAudioURL) { URL.revokeObjectURL(mixAudioURL); mixAudioURL = null; }
  mixPreviewAudio.removeAttribute('src');
}

async function ensureMixGraph() {
  if (mixCtx && mixSrcNode) return;
  mixCtx = new (window.AudioContext || window.webkitAudioContext)();
  const file = await ensureMerged();
  if (mixAudioURL) URL.revokeObjectURL(mixAudioURL);
  mixAudioURL = URL.createObjectURL(file);
  mixPreviewAudio.src = mixAudioURL;
  mixSrcNode = mixCtx.createMediaElementSource(mixPreviewAudio);
}

async function playMixPreview() {
  if (!sourceFiles.length || !analysis) return;
  const win = pickPreviewWindow();
  if (!win) { setMixStatus('Aucun passage conservé à prévisualiser.'); return; }

  stopMixPreview();
  await ensureMixGraph();

  // Chaîne EQ reconstruite à chaque écoute (topologie identique à applyEQ,
  // voir buildEqChain dans turbo-audio.js — même highpass/notch/bandes/
  // compresseur que le rendu réel, pour que l'aperçu ne mente jamais).
  try { mixSrcNode.disconnect(); } catch {}
  const eqOut = buildEqChain(mixCtx, mixSrcNode, {
    freqs: EQ_FREQS, gains: EQ.gains, q: EQ.q, highpass: EQ.highpass, normalize: EQ.normalize, whineNotch: EQ.whineNotch,
  });
  eqOut.connect(mixCtx.destination);

  if (CONFIG.bgmType !== 'none') {
    if (isBgmAudioType(CONFIG.bgmType)) {
      try { await preloadBgmAudio(CONFIG.bgmType); } catch { /* silence si indisponible, pas d'erreur bloquante ici */ }
    }
    const n = Math.round(mixCtx.sampleRate * win.dur);
    const bg = isBgmAudioType(CONFIG.bgmType)
      ? renderBgmAudio(CONFIG.bgmType, mixCtx.sampleRate, n)
      : renderBgm(CONFIG.bgmType, mixCtx.sampleRate, n);
    if (bg.length) {
      const bgBuf = mixCtx.createBuffer(1, bg.length, mixCtx.sampleRate);
      bgBuf.copyToChannel(bg, 0);
      const bgSrc = mixCtx.createBufferSource();
      bgSrc.buffer = bgBuf;
      const bgGain = mixCtx.createGain();
      bgGain.gain.value = Math.pow(10, CONFIG.bgmGainDb / 20);
      bgSrc.connect(bgGain); bgGain.connect(mixCtx.destination);
      bgSrc.start();
      mixBgSrcNode = bgSrc;
    }
  }

  mixPreviewAudio.currentTime = win.start;
  try { await mixPreviewAudio.play(); }
  catch (e) { setMixStatus('Lecture bloquée par le navigateur : cliquez le bouton.'); return; }
  mixPlaying = true;
  mixPreviewBtn.textContent = '⏹️ Arrêter';
  setMixStatus(`▶️ ${fmtTime(win.start)} – ${fmtTime(win.start + win.dur)}`);
  mixStopTimer = setTimeout(stopMixPreview, win.dur * 1000 + 150);
}

mixPreviewBtn.addEventListener('click', () => { mixPlaying ? stopMixPreview() : playMixPreview().catch(e => setMixStatus('❌ ' + (e.message || e))); });

// Debounce : plusieurs réglages bougés vite (glisser un curseur) ne doivent
// relancer la lecture qu'une fois, pas à chaque valeur intermédiaire.
function scheduleAutoPreview() {
  if (!mixPreviewAuto.checked || mixPreviewSection.classList.contains('hidden')) return;
  clearTimeout(mixDebounce);
  mixDebounce = setTimeout(() => { playMixPreview().catch(() => {}); }, 400);
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
  analysis = null;
  sourceDims = null;   // dimensions sondées pour l'estimation : périmées si la source change
  cutsSection.classList.add('hidden');
  mixPreviewSection.classList.add('hidden');
  resetMixGraph(); // le graphe d'aperçu est lié au fichier chargé : périmé si la source change
  resetOutput();
  renderQueue();

  if (sourceFiles.length === 0) {
    processBtn.disabled = true;
    analyzeBtn.disabled = true;
    processBtn.textContent = '🔪 Détecter et couper les silences';
    setStatus('');
    return;
  }
  processBtn.disabled = false;
  analyzeBtn.disabled = false;
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
  const durs = await Promise.all(sourceFiles.map(f => probeDuration(f).catch(() => 0)));
  if (srcSig() !== sigAtProbe) return; // la liste a changé pendant la sonde
  const total = durs.reduce((a, d) => a + d, 0);
  queueHint.textContent = total > 0
    ? `Durée totale : ~${fmtTime(total)}${total > CHUNKING.autoAbove[engine] ? ' — traitement par parties.' : ''}`
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

function resetOutput() {
  if (finalURL) { URL.revokeObjectURL(finalURL); finalURL = null; }
  releasePartUrls();
  preview.pause(); preview.removeAttribute('src'); preview.load();
  preview.classList.add('hidden');
  downloadLink.classList.add('hidden');
  partsSection.classList.add('hidden');
  partsList.innerHTML = '';
  finalInfoSection.classList.add('hidden');
  finalInfoBody.innerHTML = '';
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
    // On vérifie seulement que la partie EXISTE. La charger ici remettait
    // toutes les parties déjà calculées en mémoire au simple dépôt du fichier.
    if (meta.chunks[i].status === 'done' && await dbHas(PARTS, `${meta.key}:${i}`)) {
      c.status = 'done'; doneCount++;
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

  job = {
    key: meta.key, duration: meta.duration, chunks,
    // Repli sur les réglages courants pour une sauvegarde antérieure à ces
    // champs (absents de meta.* avant leur ajout).
    socialPreset: meta.socialPreset || CONFIG.socialPreset,
    crf: meta.crf ?? CONFIG.crf,
    engine: meta.engine || engine,
  };
  renderParts();
  if (doneCount === chunks.length) {
    processBtn.textContent = '🔁 Retraiter la vidéo';
    // Job entièrement terminé mais jamais assemblé (page rechargée avant la
    // réunion, ou reprise d'une session ancienne) : on complète tout de suite,
    // sans attendre un clic sur « Traiter ».
    await finalizeOutput(true);
  } else {
    processBtn.textContent = `▶️ Reprendre (${chunks.length - doneCount} parties restantes)`;
  }
}

// ==================== MOTEUR FFMPEG ====================
function withTimeout(promise, ms, message) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  const { FFmpeg } = await import('/vendor/ffmpeg/index.js');
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

async function openInput(ff, file = videoFile) {
  const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
  const name = `input.${ext}`;
  if (canMount) {
    try {
      await mountBlobs(ff, '/src', [{ name, data: file }]);
      return { path: `/src/${name}`, cleanup: () => unmountQuiet(ff, '/src') };
    } catch { canMount = false; log('ℹ️ Lecture directe indisponible : copie en mémoire.'); }
  }
  const { fetchFile } = await import('/vendor/util/index.js');
  await ff.writeFile(name, await fetchFile(file));
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

// ==================== APERÇU DES COUPES ====================
// L'enveloppe RMS est calculée UNE fois puis mise en cache : bouger un curseur
// ne relance jamais le décodage, seulement `segmentsFromLoud` (quelques ms).
// Avant, régler la sensibilité coûtait un cycle de traitement complet.

/** Calcule l'enveloppe RMS (ou renvoie celle déjà en cache). */
async function ensureAnalysis() {
  const file = await ensureMerged();
  const key = currentKey();
  if (analysis && analysis.key === key) return analysis;

  let loud, winSec, duration;
  if (engine === 'turbo') {
    // Mode diagnostic : aucun repli. Une erreur ici remonte jusqu'au bouton
    // « Traiter », avec son message exact.
    ({ loud, winSec, duration } = await turboAnalyze(file, CONFIG.windowSec, phaseProgress));
  } else {
    const ff = await getFFmpeg();
    const input = await openInput(ff, file);
    try {
      const pcm = await extractPCM(ff, input.path);
      ({ loud, winSec, duration } = loudFromPCM(pcm, ANALYSIS_SR, CONFIG.windowSec));
    } finally { try { await input.cleanup(); } catch {} }
  }

  analysis = { key, loud, winSec, duration };
  return analysis;
}

// ==================== ESTIMATION DE TAILLE (avant traitement) ====================
// Dimensions sources sondées à la demande (pas de décodage complet), pour
// estimer une taille de fichier quand « Conserver la source » est choisi.
let sourceDims = null;
async function ensureSourceDims() {
  if (sourceDims || !sourceFiles.length) return sourceDims;
  try { sourceDims = await probeSize(sourceFiles[0]); } catch { sourceDims = null; }
  return sourceDims;
}

const AUDIO_BITRATE_ESTIMATE = 128_000; // débit audio typique d'une voix, pour l'estimation seulement

/** Estimation grossière (avant traitement) de la taille du fichier final. */
async function paintSizeEstimate(keptSec) {
  const el = $('sizeEstimate');
  if (!el) return;
  const preset = SOCIAL_PRESETS[CONFIG.socialPreset] || SOCIAL_PRESETS.source;
  let w, h, fps;
  if (preset.output) {
    ({ width: w, height: h, fps } = preset.output);
  } else {
    const dims = await ensureSourceDims();
    w = dims ? dims.w : 1280; h = dims ? dims.h : 720; fps = 30;
  }
  const vBitrate = bitrateFor(align16(w), align16(h), fps, CONFIG.crf);
  const bytes = ((vBitrate + AUDIO_BITRATE_ESTIMATE) / 8) * keptSec;
  let note = ` ≈ ${fmtSize(bytes)} estimés (${align16(w)}×${align16(h)}@${fps}fps).`;
  if (preset.maxSizeMB && bytes / 1048576 > preset.maxSizeMB) {
    note += ` ⚠️ Dépasse le repère indicatif ${preset.label} (~${preset.maxSizeMB} Mo) : qualité vidéo plus légère conseillée.`;
  }
  el.textContent = note.trim();
}

/** Recalcule les segments à partir du cache et redessine. Ne décode rien. */
function refreshCuts() {
  if (!analysis) return;
  const { loud, winSec, duration } = analysis;
  const { segments, kept } = segmentsFromLoud(loud, winSec, duration, silenceCfg());
  const parts = planChunks(segments, duration, chunkOpts());
  drawCuts(segments);
  paintSizeEstimate(kept).catch(() => {});   // ne bloque jamais l'aperçu des coupes

  const removed = duration - kept;
  const pct = duration > 0 ? Math.round((removed / duration) * 100) : 0;
  cutsTag.textContent = `${segments.length} segments`;
  cutsHint.textContent =
    `${fmtTime(removed)} de silence retiré sur ${fmtTime(duration)} (−${pct} %) → ` +
    `${fmtTime(kept)} de vidéo finale, en ${parts.length} partie(s). ` +
    `Zones claires = conservées, zones sombres = supprimées.`;

  // En moteur compatible, une partie s'arrête aussi au bout d'un certain nombre
  // de segments : sans cette phrase, l'utilisateur qui demande « 4 minutes » et
  // obtient des parties de 90 s n'a aucun moyen de comprendre pourquoi.
  const maxSeg = CHUNKING.maxSeg[engine];
  if (isFinite(maxSeg) && parts.some(p => p.segs.length >= maxSeg)) {
    cutsHint.textContent +=
      ` Certaines parties sont plus courtes que demandé : avec le moteur compatible,` +
      ` une partie ne dépasse jamais ${maxSeg} segments.`;
  }
}

/** Dessine l'enveloppe, le seuil et les zones conservées. */
function drawCuts(segments) {
  const { loud, winSec, duration } = analysis;
  const ctx = cutsCanvas.getContext('2d');
  const W = cutsCanvas.width, H = cutsCanvas.height;
  const thr = thresholdCurve(loud, winSec, silenceCfg());

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, W, H);

  // Zones conservées en fond clair.
  ctx.fillStyle = 'rgba(56, 189, 248, 0.16)';
  for (const [s, e] of segments) {
    const x0 = (s / duration) * W, x1 = (e / duration) * W;
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), H);
  }

  // Enveloppe RMS : une colonne par pixel, sur le maximum de la tranche.
  // L'échelle est en racine carrée, sinon la parole normale est écrasée en bas.
  let peak = 0;
  for (let i = 0; i < loud.length; i++) if (loud[i] > peak) peak = loud[i];
  const norm = v => Math.sqrt(Math.min(1, v / (peak || 1)));
  const perPx = loud.length / W;

  ctx.fillStyle = '#7dd3fc';
  for (let x = 0; x < W; x++) {
    const from = Math.floor(x * perPx), to = Math.max(from + 1, Math.floor((x + 1) * perPx));
    let m = 0;
    for (let i = from; i < to && i < loud.length; i++) if (loud[i] > m) m = loud[i];
    const h = norm(m) * (H - 8);
    ctx.fillRect(x, H - h, 1, h);
  }

  // Courbe de seuil : elle est adaptative, la voir aide à régler la sensibilité.
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < W; x++) {
    const i = Math.min(thr.length - 1, Math.floor(x * perPx));
    const y = H - norm(thr[i]) * (H - 8);
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

analyzeBtn.addEventListener('click', async () => {
  if (running || analyzing || !sourceFiles.length) return;
  analyzing = true;
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = '⏳ Analyse…';
  showProgress(true); setPhase(0, 1, 'Analyse audio'); paintProgress(0);
  try {
    await ensureAnalysis();
    cutsSection.classList.remove('hidden');
    mixPreviewSection.classList.remove('hidden');
    refreshCuts();
    paintProgress(1);
    setStatus('👀 Aperçu prêt. Ajustez les réglages : l\'aperçu se met à jour sans rien recalculer.');
    cutsSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    console.error(e);
    setStatus('❌ Analyse impossible : ' + e.message, 'err');
  } finally {
    analyzing = false;
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = '🔍 Aperçu des coupes';
    showProgress(false);
  }
});

// Les curseurs qui changent la détection redessinent l'aperçu, au rythme de
// l'écran (une seule fois par trame, même en glissant vite).
let cutsQueued = false;
function queueCutsRefresh() {
  if (!analysis || cutsQueued) return;
  cutsQueued = true;
  requestAnimationFrame(() => { cutsQueued = false; refreshCuts(); });
}

function buildFilter(segs, offset, chain, hasBg) {
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
  g += chain.length ? `;[araw]${chain.join(',')}[aeq]` : ';[araw]anull[aeq]';

  if (hasBg) {
    // Le son de fond est une 2e entrée : on aligne format et débit avant amix.
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

  // Son de fond : un WAV continu couvrant toute la durée conservée de la
  // partie. Une seule entrée supplémentaire pour ffmpeg, mixée via amix.
  let bgWritten = false;
  if (CONFIG.bgmType !== 'none') {
    const partDur = c.segs.reduce((a, [s, e]) => a + (e - s), 0);
    const { fetchFile } = await import('/vendor/util/index.js');
    // Ambiances enregistrées (bgm-audio.js) vs synthétisées (bgm.js) : même
    // WAV mono en sortie, source différente. makeBgAudioWav précharge si le
    // cache n'était pas déjà chaud (ne devrait pas arriver, voir processBtn).
    const wav = isBgmAudioType(CONFIG.bgmType)
      ? await makeBgAudioWav(partDur, 44100, CONFIG.bgmType, CONFIG.bgmGainDb)
      : makeBgWav(partDur, 44100, CONFIG.bgmType, CONFIG.bgmGainDb);
    await ff.writeFile('bg.wav', await fetchFile(wav));
    bgWritten = true;
  }

  const argsFor = (chain, hasBg) => {
    const args = [
      '-ss', c.t0.toFixed(3),
      '-t', (c.t1 - c.t0).toFixed(3),
      '-i', inPath,
    ];
    if (hasBg) args.push('-i', 'bg.wav');
    args.push(
      '-filter_complex', buildFilter(c.segs, c.t0, chain, hasBg),
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
  if (EQ.linear) ladder.push({ chain: audioChain(true), bg: bgWritten });
  ladder.push({ chain: audioChain(false), bg: bgWritten, note: EQ.linear ? '⚠️ Phase linéaire indisponible : égaliseur classique utilisé.' : null });
  if (bgWritten) ladder.push({ chain: audioChain(false), bg: false, note: '⚠️ Mixage du son de fond impossible : partie rendue sans ambiance.' });
  ladder.push({ chain: [], bg: false, note: '⚠️ Filtres audio indisponibles : partie encodée sans traitement.' });

  try {
    let lastErr = null;
    for (let i = 0; i < ladder.length; i++) {
      const step = ladder[i];
      const prev = ladder[i - 1];
      if (prev && JSON.stringify(step.chain) === JSON.stringify(prev.chain) && step.bg === prev.bg) continue;
      try {
        await run(ff, argsFor(step.chain, step.bg));
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
    if (bgWritten) { try { await ff.deleteFile('bg.wav'); } catch {} }
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

// Object URL des aperçus de parties : ils étaient créés pour CHAQUE partie et
// jamais révoqués. Ils sont désormais créés à la demande et libérés.
const partUrls = new Map();
function releasePartUrls() {
  for (const url of partUrls.values()) URL.revokeObjectURL(url);
  partUrls.clear();
}
function partUrl(index, blob) {
  const old = partUrls.get(index);
  if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(blob);
  partUrls.set(index, url);
  return url;
}

/** Récupère le MP4 d'une partie : mémoire si présent, sinon IndexedDB. */
async function loadPartBlob(c) {
  if (c.blob) return c.blob;
  const b = await dbGet(PARTS, `${job.key}:${c.index}`);
  if (!b) throw new Error(`la partie ${c.index + 1} est introuvable dans la sauvegarde`);
  return b;
}

function updatePartRow(c) {
  const st = $(`ps-${c.index}`), body = $(`pb-${c.index}`);
  if (!st) return;
  const labels = { pending: '⏳ En attente', running: '⚙️ En cours…', done: '✅ Prêt', error: '❌ Échec' };
  st.textContent = labels[c.status] || '';
  st.className = `part-status st-${c.status}`;

  if (c.status === 'done' && !body.dataset.filled) {
    body.dataset.filled = '1';
    body.innerHTML = '';
    // On n'ouvre PAS les 12 parties d'un coup : sur une vidéo d'une heure, cela
    // remettait plusieurs Go en mémoire avant même le moindre clic.
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-ghost btn-small';
    open.textContent = '▶️ Ouvrir cette partie';
    open.addEventListener('click', async () => {
      open.disabled = true;
      try {
        const blob = await loadPartBlob(c);
        const url = partUrl(c.index, blob);
        body.innerHTML = '';
        const v = document.createElement('video');
        v.controls = true; v.playsInline = true; v.preload = 'metadata'; v.src = url;
        v.className = 'part-preview';
        const a = document.createElement('a');
        a.className = 'btn btn-ghost btn-small';
        a.href = url; a.download = `partie_${c.index + 1}.mp4`;
        a.textContent = `⬇️ Enregistrer cette partie (${fmtSize(blob.size)})`;
        body.append(v, a);
      } catch (e) {
        open.disabled = false;
        setStatus('❌ ' + e.message, 'err');
      }
    });
    body.append(open);
  }
}

function refreshPartsTag() {
  const done = job.chunks.filter(c => c.status === 'done').length;
  partsTag.textContent = `${done}/${job.chunks.length}`;
}

// ==================== FLUX PRINCIPAL ====================
processBtn.addEventListener('click', async () => {
  if (!sourceFiles.length || running) return;
  stopMixPreview(); // pas d'aperçu qui joue par-dessus le vrai traitement
  running = true; paused = false;
  processBtn.disabled = true;
  pauseBtn.classList.remove('hidden');
  logOutput.textContent = '';
  showProgress(true); paintProgress(0);
  await askNotify();
  await keepAwake(true);

  let input = null, ff = null;
  try {

    // --- Son de fond « nature » : préchargé AVANT le rendu -----------
    // Le moteur turbo mélange le son de fond de façon SYNCHRONE (mixBgAudio,
    // voir turbo-render.js) : le fichier doit déjà être décodé et en cache
    // quand le rendu démarre. Normalement déjà fait (sélection du panneau),
    // ce n'est ici qu'un filet de sécurité (reprise de session, par ex.).
    if (isBgmAudioType(CONFIG.bgmType)) {
      setStatus('🎧 Préparation du son de fond…');
      try {
        await preloadBgmAudio(CONFIG.bgmType);
      } catch (e) {
        log(`⚠️ Son de fond indisponible, désactivé pour ce traitement : ${e.message || e}`);
        CONFIG.bgmType = 'none'; bgmSel.value = 'none'; paintBgm();
      }
    }

    // --- 0. Fusion des sources (transparente pour la suite) --------
    // Après cette étape, videoFile est UNE vidéo (source unique ou fusion),
    // et tout le pipeline ci-dessous fonctionne sans autre changement.
    videoFile = await ensureMerged();

    // --- 1. Analyse (sautée si déjà en cache ou si on reprend une session) ---
    // Si l'aperçu a déjà été demandé, ensureAnalysis() rend la main aussitôt :
    // le fichier n'est décodé qu'une fois, aperçu et traitement compris.
    if (!job || job.chunks.some(c => !c.segs && c.status !== 'done')) {
      setStatus('🔍 Analyse audio en cours...');
      setPhase(0, 0.08, 'Analyse audio');

      const { loud, winSec, duration } = await ensureAnalysis();

      setPhase(0.08, 0.02, 'Détection des silences');
      const { segments, kept } = segmentsFromLoud(loud, winSec, duration, silenceCfg());
      await yieldNow();
      log(`🎤 ${segments.length} segments — ${fmtTime(duration - kept)} de silence retiré sur ${fmtTime(duration)}.`);

      // L'aperçu reflète ce qui va réellement être produit.
      cutsSection.classList.remove('hidden');
      mixPreviewSection.classList.remove('hidden');
      refreshCuts();

      const fresh = planChunks(segments, duration, chunkOpts());
      if (job && job.key === currentKey() && job.chunks.length === fresh.length) {
        fresh.forEach((f, i) => { job.chunks[i].segs = f.segs; });
      } else {
        await dbWipe();
        // Réglages figés au moment où LE JOB EST CRÉÉ, pas relus depuis CONFIG
        // à chaque appel : sinon changer le réseau social ou le CRF entre une
        // pause et une reprise produirait des parties encodées avec des
        // réglages différents dans un même fichier final.
        job = {
          key: currentKey(), duration, chunks: fresh,
          socialPreset: CONFIG.socialPreset, crf: CONFIG.crf, engine,
        };
      }
      await saveJobMeta();
      renderParts();
    }

    const todo = job.chunks.filter(c => c.status !== 'done');
    if (!todo.length) {
      setStatus('✅ Toutes les parties sont déjà prêtes.');
      await finalizeOutput(false);
      return;
    }

    // --- 2. Traitement partie par partie ---------------------------
    clock = { start: performance.now(), doneSec: 0, totalSec: todo.reduce((a, c) => a + c.kept, 0), curSec: 0, curFrac: 0 };

    const finishPart = async (c, blob) => {
      c.status = 'done';
      const saved = await dbPut(PARTS, `${job.key}:${c.index}`, blob);
      // Sauvegardée : on relâche la mémoire, elle sera relue à la demande.
      // Non sauvegardée (quota) : on la garde, sinon elle serait perdue.
      c.blob = saved ? null : blob;
      await saveJobMeta();
      updatePartRow(c); refreshPartsTag();
      await yieldNow();
    };

    if (engine === 'turbo') {
      try {
        await turboRenderAll(videoFile, job.chunks, {
          crf: job.crf,
          output: (SOCIAL_PRESETS[job.socialPreset] || SOCIAL_PRESETS.source).output,
          audioFadeSec: CONFIG.audioFadeSec,
          bgm: { type: CONFIG.bgmType, gainDb: CONFIG.bgmGainDb },
          eq: { freqs: EQ_FREQS, gains: EQ.gains, q: EQ.q, highpass: EQ.highpass, normalize: EQ.normalize, whineNotch: EQ.whineNotch },
        }, {
          onLog: log,          // diagnostics par partie (images, durée d'audio)
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
        // Mode diagnostic : aucun repli vers ffmpeg. L'erreur turbo remonte
        // telle quelle jusqu'au bloc catch de plus haut, qui l'affiche.
        log('⚠️ Moteur turbo interrompu : ' + e.message);
        throw e;
      }
    } else {
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
      if (engine === 'turbo' && clock.totalSec && clock.start) {
        const x = clock.doneSec / ((performance.now() - clock.start) / 1000);
        // Sous 2x, l'encodage n'est presque sûrement pas matériel : autant le
        // dire, plutôt que de laisser croire que c'est la vitesse attendue.
        if (x < 2) log(`ℹ️ Vitesse ${x.toFixed(1)}× : l'encodage n'a probablement pas été matériel.`);
      }
      log(`✅ ${done}/${job.chunks.length} partie(s) prête(s)${speed}.`);
      // Assemblage automatique : plus besoin d'un clic sur « Réunir les
      // parties ». finalizeOutput() prend la main sur le statut affiché et
      // notifie elle-même une fois la vidéo finale prête — une seule
      // notification, plus pertinente que « parties prêtes » suivie aussitôt
      // de « vidéo prête ».
      await finalizeOutput(false);
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

// ==================== RENDU FINAL (assemblage automatique) ====================
// Remplace l'ancien bouton manuel « Réunir toutes les parties » : dès que
// toutes les parties d'un job sont prêtes, la vidéo finale est assemblée sans
// action de l'utilisateur. Le cas à UNE seule partie (le plus courant : une
// vidéo de moins de 20 min reste en une seule partie en moteur turbo) saute
// même l'étape de réunion — cette partie unique EST déjà la vidéo finale.

/** Détail des réglages + taille réelle, affichés une fois la vidéo assemblée. */
function renderFinalInfo(blob, jobRef, keptSec) {
  const preset = SOCIAL_PRESETS[jobRef.socialPreset] || SOCIAL_PRESETS.source;
  const convertit = jobRef.engine === 'turbo' && preset.output;
  const dims = convertit
    ? { w: align16(preset.output.width), h: align16(preset.output.height), fps: preset.output.fps }
    : null;

  const rows = [
    ['Réseau visé', escapeHtml(preset.label)],
    ['Moteur', jobRef.engine === 'turbo' ? 'Turbo (WebCodecs)' : 'Compatible (ffmpeg)'],
    dims
      ? ['Résolution × cadence', `${dims.w}×${dims.h} @ ${dims.fps} fps`]
      : ['Résolution × cadence', jobRef.engine === 'turbo'
          ? 'Source conservée'
          : 'Source conservée (conversion réseau social non appliquée par le moteur compatible)'],
    ['Qualité vidéo (CRF)', String(jobRef.crf)],
    ['Durée finale', fmtTime(keptSec)],
    ['Taille du fichier', fmtSize(blob.size)],
  ];
  finalInfoBody.innerHTML = rows
    .map(([k, v]) => `<div class="final-row"><span>${k}</span><b>${v}</b></div>`)
    .join('');

  let note = '';
  if (preset.maxSizeMB) {
    const sizeMB = blob.size / 1048576;
    note = sizeMB <= preset.maxSizeMB
      ? `✅ Sous le repère indicatif ${preset.label} (~${preset.maxSizeMB} Mo).`
      : `⚠️ Dépasse le repère indicatif ${preset.label} (~${preset.maxSizeMB} Mo) : réduisez la qualité vidéo (CRF plus élevé) ou raccourcissez la vidéo.`;
  }
  if (preset.maxDurationSec && keptSec > preset.maxDurationSec) {
    note += (note ? '<br>' : '') +
      `ℹ️ ${fmtTime(keptSec)} dépasse le repère indicatif ${preset.label} (~${fmtTime(preset.maxDurationSec)}). ` +
      `Le Splitter ne raccourcit que les silences, pas la durée totale.`;
  }
  if (note) finalInfoBody.innerHTML += `<small class="hint">${note}</small>`;

  finalSizeTag.textContent = fmtSize(blob.size);
  finalInfoSection.classList.remove('hidden');
}

/**
 * Assemble toutes les parties prêtes en un seul fichier final.
 * @param standalone  true si appelée HORS du flux principal (ex. reprise d'un
 *   job déjà entièrement terminé) : gère alors elle-même running/processBtn.
 * @returns vrai si un fichier final a été produit.
 */
async function finalizeOutput(standalone) {
  // Garde dédiée, distincte de `running` : les appels NON autonomes viennent
  // du flux principal, qui a DÉJÀ mis running=true avant d'arriver ici — un
  // garde-fou sur `running` bloquerait alors systématiquement l'assemblage.
  // `finalizing` protège seulement contre un appel réentrant sur cette
  // fonction elle-même ; un appel autonome refuse en plus de démarrer si une
  // autre opération (running) est déjà en cours.
  if (!job || finalizing || (standalone && running)) return false;
  const done = job.chunks.filter(c => c.status === 'done');
  if (!done.length || done.length !== job.chunks.length) return false;

  finalizing = true;
  if (standalone) { running = true; processBtn.disabled = true; }
  showProgress(true); setPhase(0, 1, 'Assemblage final'); paintProgress(0);
  clock = { start: 0, doneSec: 0, totalSec: 0, curSec: 0, curFrac: 0 };
  setStatus('🧩 Assemblage de la vidéo finale (copie directe, sans réencodage)...');
  await keepAwake(true);

  let blobs = null;
  try {
    // Les parties ne sont relues qu'ici, au moment où elles servent vraiment.
    blobs = [];
    for (const c of done) blobs.push(await loadPartBlob(c));

    // Une seule partie : rien à réunir, c'est déjà la vidéo finale.
    let blob;
    if (blobs.length === 1) {
      blob = blobs[0];
    } else if (job.engine === 'turbo') {
      // Mode diagnostic : aucun repli vers ffmpeg ici non plus.
      blob = await turboJoin(blobs);
    } else {
      const ff = await getFFmpeg();
      blob = await joinParts(ff, done.map((c, i) => ({ index: c.index, blob: blobs[i] })));
    }
    blobs = null;   // libère les parties source avant de garder le résultat
    paintProgress(1);

    if (finalURL) URL.revokeObjectURL(finalURL);
    finalURL = URL.createObjectURL(blob);
    preview.src = finalURL; preview.classList.remove('hidden'); preview.load();
    downloadLink.href = finalURL; downloadLink.classList.remove('hidden');
    const keptSec = job.chunks.reduce((a, c) => a + c.kept, 0);
    renderFinalInfo(blob, job, keptSec);
    setStatus(`🎉 Vidéo finale prête — ${fmtSize(blob.size)}.`);
    notify('Vidéo finale prête', `${fmtSize(blob.size)} — prête à enregistrer.`);
    preview.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  } catch (err) {
    console.error(err);
    setStatus('❌ Assemblage impossible : ' + err.message + ' — vos parties restent enregistrables une par une.', 'err');
    return false;
  } finally {
    finalizing = false;
    if (standalone) {
      running = false;
      processBtn.disabled = false;
      processBtn.textContent = '🔁 Retraiter la vidéo';
    }
    refreshPartsTag();
    await keepAwake(false);
  }
}

window.addEventListener('beforeunload', e => {
  if (running) { e.preventDefault(); e.returnValue = ''; }
  if (finalURL) URL.revokeObjectURL(finalURL);
  releasePartUrls();
});
