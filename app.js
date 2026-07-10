import { FFmpeg } from '/vendor/ffmpeg/index.js';

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
  chunkMode:     'auto', // 'auto' | 'off' | durée d'une tranche en secondes
};

// --- Découpage en tranches ---
const ANALYSIS_SR       = 8000; // Hz : audio mono basse fréquence pour l'analyse
const AUTO_CHUNK_ABOVE  = 300;  // au-delà de 5 min, on découpe automatiquement
const AUTO_CHUNK_SEC    = 240;  // durée cible d'une tranche en mode auto
const MAX_SEG_PER_CHUNK = 40;   // une tranche ne dépasse jamais 40 segments

// Encodage forcé, identique sur toutes les tranches : sinon la reconstruction
// sans réencodage échoue (paramètres de flux incompatibles).
const V_ARGS = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
const A_ARGS = ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2'];

// ==================== DOM ====================
const $ = id => document.getElementById(id);
const dropZone = $('dropZone'), fileInput = $('fileInput'), processBtn = $('processBtn');
const statusDiv = $('status'), progressContainer = $('progressContainer'), progressBar = $('progressBar');
const logOutput = $('logOutput'), downloadLink = $('downloadLink'), preview = $('preview');

let videoFile = null;
let currentURL = null;   // pour révoquer l'ancien blob
let ffmpeg = null;       // instance réutilisée
let usingMT = false;
let canMount = false;    // WORKERFS : lecture du fichier sans copie en mémoire

// ==================== RÉGLAGES ====================
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
  probeAndInform(file);
}

// Lit uniquement les métadonnées pour connaître la durée.
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

async function probeAndInform(file) {
  const dur = await probeDuration(file);
  if (videoFile !== file || !dur) return;
  if (dur > AUTO_CHUNK_ABOVE) {
    const min = Math.round(dur / 60);
    setStatus(`✅ ${file.name} — ~${min} min. Traitement par tranches puis reconstruction.`);
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

// ==================== PROGRESSION ====================
// ffmpeg émet une progression par commande : on la replace dans une phase globale.
let phase = { base: 0, span: 1 };
const clamp01 = x => Math.max(0, Math.min(1, x || 0));
function setPhase(base, span) { phase = { base, span }; }
function setProgress(p) { progressBar.style.width = `${Math.round(clamp01(p) * 100)}%`; }
function phaseProgress(p) { setProgress(phase.base + clamp01(p) * phase.span); }

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
  canMount = typeof ffmpeg.mount === 'function' && typeof ffmpeg.createDir === 'function';
  log('✅ ffmpeg prêt.');
  return ffmpeg;
}

// Redémarre le moteur à zéro si une tranche a saturé la mémoire.
async function resetFFmpeg() {
  if (!ffmpeg) return;
  try { await ffmpeg.terminate(); } catch {}
  ffmpeg = null;
}

// Monte un Blob en lecture seule : ffmpeg lit le fichier SANS le recopier dans
// le tas WebAssembly (limité à ~2 Go). C'est ce qui rend les vidéos longues possibles.
async function mountBlob(ff, blob, dir, name) {
  await ff.createDir(dir).catch(() => {});
  await ff.mount('WORKERFS', { blobs: [{ name, data: blob }] }, dir);
  return `${dir}/${name}`;
}
async function unmountQuiet(ff, dir) { try { await ff.unmount(dir); } catch {} }

async function openInput(ff) {
  const ext = (videoFile.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
  const name = `input.${ext}`;
  if (canMount) {
    try {
      const path = await mountBlob(ff, videoFile, '/src', name);
      log('📎 Fichier lu directement (sans copie en mémoire).');
      return { path, cleanup: () => unmountQuiet(ff, '/src') };
    } catch {
      canMount = false;
      log('ℹ️ Lecture directe indisponible : copie du fichier en mémoire.');
    }
  }
  const { fetchFile } = await import('/vendor/util/index.js');
  await ff.writeFile(name, await fetchFile(videoFile));
  return { path: name, cleanup: async () => { try { await ff.deleteFile(name); } catch {} } };
}

// ==================== ANALYSE AUDIO ====================
// On extrait une piste mono 8 kHz avec ffmpeg (quelques Mo, même sur 1 h de vidéo)
// au lieu de décoder toute la vidéo via Web Audio (plusieurs Go de PCM).
async function extractPCM(ff, inPath) {
  log('🎧 Extraction de la piste audio pour analyse...');
  await ff.exec([
    '-i', inPath,
    '-vn', '-ac', '1', '-ar', String(ANALYSIS_SR),
    '-f', 's16le', '-acodec', 'pcm_s16le',
    'audio.raw'
  ]);
  let raw;
  try { raw = await ff.readFile('audio.raw'); }
  catch { throw new Error("Aucune piste audio exploitable dans cette vidéo."); }
  try { await ff.deleteFile('audio.raw'); } catch {}
  if (!raw || raw.length < 2) throw new Error("La piste audio est vide : rien à analyser.");
  return new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
}

// Renvoie la liste des segments [start, end] à CONSERVER.
async function detectSegments(pcm) {
  const sr = ANALYSIS_SR;
  const len = pcm.length;
  const dur = len / sr;

  const win = Math.max(1, Math.floor(sr * CONFIG.windowSec));
  const winSec = win / sr;
  const nWin = Math.ceil(len / win);
  const loud = new Float32Array(nWin);

  let wi = 0;
  for (let i = 0; i < len; i += win) {
    const end = Math.min(i + win, len);
    let sum = 0, n = 0;
    for (let j = i; j < end; j++) { const s = pcm[j] / 32768; sum += s * s; n++; }
    loud[wi++] = Math.sqrt(sum / n);
    if ((wi & 1023) === 0) { phaseProgress(i / len); await new Promise(r => setTimeout(r)); }
  }

  // Seuil ADAPTATIF, calculé sur le bruit de fond réel du fichier.
  const sorted = Float32Array.from(loud).sort();
  const pct = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const noiseFloor = pct(0.10);
  const loudRef    = pct(0.90);
  let thr = Math.max(noiseFloor * 2.5, loudRef * 0.06);
  thr = Math.max(thr / CONFIG.sensitivity, CONFIG.absFloor);

  // Machine à états : un silence plus court que minSilenceDur ne coupe pas.
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
  return { segments: final, duration: dur, kept };
}

// ==================== PLAN DE DÉCOUPE ====================
// Une tranche = un paquet de segments consécutifs. Les frontières tombent
// toujours à l'intérieur d'un silence supprimé : aucune image n'est perdue,
// et aucune coupe ne tombe au milieu d'un mot.
function planChunks(segments, duration) {
  let target;
  if (CONFIG.chunkMode === 'off') target = Infinity;
  else if (CONFIG.chunkMode === 'auto') target = duration > AUTO_CHUNK_ABOVE ? AUTO_CHUNK_SEC : Infinity;
  else target = parseFloat(CONFIG.chunkMode);

  if (!isFinite(target)) return [segments];

  const chunks = [];
  let cur = [];
  for (const seg of segments) {
    if (cur.length && (seg[1] - cur[0][0] > target || cur.length >= MAX_SEG_PER_CHUNK)) {
      chunks.push(cur); cur = [];
    }
    cur.push(seg);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// filter_complex d'une tranche : coupe chaque segment puis les recolle.
// `offset` = début de la tranche dans la source (les temps deviennent relatifs).
function buildFilter(segs, offset) {
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
  return `${parts.join(';')};${inputs}concat=n=${segs.length}:v=1:a=1[outv][outa]`;
}

// ==================== TRAITEMENT ====================
// Vidéo courte : une seule passe, on encode directement le MP4 final.
async function renderSingle(ff, inPath, segs) {
  log(`✂️ Assemblage de ${segs.length} segment(s)...`);
  const t0 = segs[0][0];
  await ff.exec([
    '-ss', t0.toFixed(3),
    '-t', (segs[segs.length - 1][1] - t0).toFixed(3),
    '-i', inPath,
    '-filter_complex', buildFilter(segs, t0),
    '-map', '[outv]', '-map', '[outa]',
    '-threads', '0',
    ...V_ARGS, '-crf', String(CONFIG.crf),
    ...A_ARGS,
    '-movflags', '+faststart',
    'output.mp4'
  ]);
  const data = await ff.readFile('output.mp4');
  try { await ff.deleteFile('output.mp4'); } catch {}
  return new Blob([data.buffer], { type: 'video/mp4' });
}

// Encode UNE tranche en MPEG-TS. `tsOffset` décale les horodatages du cumul des
// tranches déjà rendues : bout à bout, le flux reste continu (pas de décalage A/V).
async function renderChunk(ff, inPath, segs, tsOffset, index) {
  const t0 = segs[0][0];
  const t1 = segs[segs.length - 1][1];
  const name = `part_${index}.ts`;
  await ff.exec([
    '-ss', t0.toFixed(3),
    '-t', (t1 - t0).toFixed(3),
    '-i', inPath,
    '-filter_complex', buildFilter(segs, t0),
    '-map', '[outv]', '-map', '[outa]',
    '-threads', '0',
    ...V_ARGS, '-crf', String(CONFIG.crf),
    ...A_ARGS,
    '-output_ts_offset', tsOffset.toFixed(6),
    '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'mpegts', name
  ]);
  const data = await ff.readFile(name);
  try { await ff.deleteFile(name); } catch {}
  // La tranche quitte immédiatement le tas WebAssembly : le Blob vit côté
  // navigateur (déchargeable sur disque), la mémoire de ffmpeg reste basse.
  return new Blob([data.buffer], { type: 'video/mp2t' });
}

// Reconstruction : les tranches TS ont des horodatages continus, on les colle
// bout à bout puis on remuxe en MP4 sans réencoder (rapide et sans perte).
async function joinChunks(ff, blobs) {
  const joined = new Blob(blobs, { type: 'video/mp2t' });

  const remux = async (inPath) => {
    await ff.exec([
      '-i', inPath,
      '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      'output.mp4'
    ]);
    const data = await ff.readFile('output.mp4');
    try { await ff.deleteFile('output.mp4'); } catch {}
    return new Blob([data.buffer], { type: 'video/mp4' });
  };

  if (canMount) {
    try {
      const path = await mountBlob(ff, joined, '/join', 'joined.ts');
      try { return await remux(path); }
      finally { await unmountQuiet(ff, '/join'); }
    } catch {
      log('ℹ️ Remuxage direct impossible : reconstruction en mémoire.');
    }
  }
  const { fetchFile } = await import('/vendor/util/index.js');
  await ff.writeFile('joined.ts', await fetchFile(joined));
  try { return await remux('joined.ts'); }
  finally { try { await ff.deleteFile('joined.ts'); } catch {} }
}

function publish(blob) {
  if (currentURL) URL.revokeObjectURL(currentURL);
  currentURL = URL.createObjectURL(blob);
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
  progressContainer.classList.remove('hidden'); setProgress(0);

  let input = null;
  try {
    const ff = await getFFmpeg();
    input = await openInput(ff);

    // --- 1. Analyse -------------------------------------------------
    setStatus('🔍 Analyse audio en cours...');
    setPhase(0, 0.08);
    const pcm = await extractPCM(ff, input.path);
    setPhase(0.08, 0.04);
    const { segments, duration, kept } = await detectSegments(pcm);

    const saved = duration - kept;
    setStatus(`🎤 ${segments.length} segment(s) — ${saved.toFixed(0)} s de silence retirés sur ${duration.toFixed(0)} s.`);

    // --- 2. Plan de découpe -----------------------------------------
    const chunks = planChunks(segments, duration);
    if (chunks.length > 1) log(`📐 Découpage en ${chunks.length} tranches.`);

    // --- 3. Traitement ----------------------------------------------
    let result;
    if (chunks.length === 1) {
      setPhase(0.12, 0.88);
      result = await renderSingle(ff, input.path, chunks[0]);
    } else {
      const span = 0.80 / chunks.length;
      const parts = [];
      let tsOffset = 0;
      for (let i = 0; i < chunks.length; i++) {
        const segs = chunks[i];
        setStatus(`⚙️ Tranche ${i + 1}/${chunks.length} — ${segs.length} segment(s)...`);
        setPhase(0.12 + i * span, span);
        parts.push(await renderChunk(ff, input.path, segs, tsOffset, i));
        tsOffset += segs.reduce((a, [s, e]) => a + (e - s), 0);
      }
      // --- 4. Reconstruction ----------------------------------------
      setStatus('🧩 Reconstruction de la vidéo finale...');
      log(`🧩 Reconstruction à partir de ${parts.length} tranches...`);
      setPhase(0.92, 0.08);
      result = await joinChunks(ff, parts);
    }

    setProgress(1);
    publish(result);
    setStatus(`🎉 Terminé — ${(result.size / 1048576).toFixed(1)} Mo. Vérifiez l'aperçu, puis enregistrez.`);
  } catch (err) {
    console.error(err);
    let msg = '❌ Erreur : ' + err.message;
    if (/memory|allocat|OOM|abort/i.test(err.message || '')) {
      msg = '❌ Mémoire saturée. Choisissez des tranches plus courtes (2 min) puis relancez.';
      await resetFFmpeg();
    } else if (/Worker|import|module|fetch|network|Failed/i.test(err.message || '')) {
      msg += " — Échec de chargement du moteur ffmpeg. Vérifiez la connexion, puis réessayez.";
    }
    setStatus(msg, 'err');
  } finally {
    if (input) { try { await input.cleanup(); } catch {} }
    processBtn.disabled = false;
  }
});

window.addEventListener('beforeunload', () => { if (currentURL) URL.revokeObjectURL(currentURL); });
