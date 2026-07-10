/* =============================================================================
   MEDIA.JS — boîte à outils partagée par Echo Remover, Audio Studio et Lyrics.
   - Décodage audio universel (fichiers audio OU vidéo) via Web Audio.
   - Export WAV instantané.
   - Réinjection de l'audio traité dans la vidéo d'origine (ffmpeg, -c:v copy).
   - Petits composants d'interface communs (dropzone, statut, progression).
   ========================================================================== */

const US_LIMIT_SEC = 30 * 60; // au-delà de 30 min on prévient (RAM du décodage)

// ==================== INTERFACE COMMUNE ====================
export function ui(ids) {
  const $ = id => document.getElementById(id);
  const els = {};
  for (const id of ids) els[id] = $(id);
  return els;
}

export function wireDropZone(dropZone, fileInput, onFile) {
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => fileInput.files[0] && onFile(fileInput.files[0]));
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) onFile(e.dataTransfer.files[0]);
  });
}

export function makeStatus(el) {
  return (msg, cls = '') => { el.className = cls; el.textContent = msg; };
}

export function makeProgress(container, bar) {
  return {
    show: on => container.classList.toggle('hidden', !on),
    set: p => { bar.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`; },
  };
}

export const fmtSize = b => `${(b / 1048576).toFixed(1)} Mo`;
export const fmtTime = s => {
  if (!isFinite(s) || s < 0) return '—';
  s = Math.round(s);
  const m = Math.floor(s / 60);
  return m ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
};
export const isVideo = f => /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name);

// ==================== DÉCODAGE ====================
/** Décode n'importe quel fichier audio ou vidéo en AudioBuffer. */
export async function decodeFile(file, onWarn) {
  if (onWarn) {
    // Estimation grossière de la durée pour avertir sur les très longs fichiers.
    const durGuess = await probeDuration(file).catch(() => 0);
    if (durGuess > US_LIMIT_SEC) {
      onWarn(`⚠️ Fichier de ~${Math.round(durGuess / 60)} min : le décodage peut demander beaucoup de mémoire.`);
    }
  }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buf = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf);
    return audio;
  } catch (e) {
    throw new Error("Impossible de décoder l'audio de ce fichier (" + (e.message || e) + ").");
  } finally {
    ctx.close().catch(() => {});
  }
}

export function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(isVideo(file) ? 'video' : 'audio');
    const u = URL.createObjectURL(file);
    el.preload = 'metadata';
    el.onloadedmetadata = () => { URL.revokeObjectURL(u); resolve(el.duration || 0); };
    el.onerror = () => { URL.revokeObjectURL(u); reject(new Error('metadata')); };
    el.src = u;
  });
}

// ==================== EXPORT ====================
/** AudioBuffer -> Blob WAV 16 bits (instantané, sans dépendance). */
export function bufferToWav(buffer) {
  const ch = Math.min(2, buffer.numberOfChannels);
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const bytes = 44 + n * ch * 2;
  const ab = new ArrayBuffer(bytes);
  const v = new DataView(ab);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };

  wr(0, 'RIFF'); v.setUint32(4, bytes - 8, true); wr(8, 'WAVE');
  wr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, ch, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  wr(36, 'data'); v.setUint32(40, n * ch * 2, true);

  const chans = Array.from({ length: ch }, (_, i) => buffer.getChannelData(i));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/** Crée un AudioBuffer à partir de canaux Float32Array. */
export function channelsToBuffer(channels, sampleRate) {
  const ctx = new OfflineAudioContext(channels.length, channels[0].length, sampleRate);
  const buf = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
  channels.forEach((c, i) => buf.copyToChannel(c, i));
  return buf;
}

// ==================== FFMPEG (léger, à la demande) ====================
// Utilisé uniquement pour réinjecter l'audio traité dans la vidéo d'origine
// (-c:v copy : la vidéo n'est PAS réencodée) ou convertir le WAV en M4A.
let _ff = null;
export async function getFF(log) {
  if (_ff) return _ff;
  const { FFmpeg } = await import('/vendor/ffmpeg/index.js');
  const ff = new FFmpeg();
  if (log) ff.on('log', ({ message }) => { if (!message.includes('frame=')) log(message); });
  const mt = self.crossOriginIsolated === true;
  const dir = mt ? '/vendor/core-mt' : '/vendor/core-st';
  const opts = {
    classWorkerURL: '/vendor/ffmpeg/worker.js',
    coreURL: `${dir}/ffmpeg-core.js`,
    wasmURL: `${dir}/ffmpeg-core.wasm`,
  };
  if (mt) opts.workerURL = `${dir}/ffmpeg-core.worker.js`;
  await ff.load(opts);
  _ff = ff;
  return ff;
}

async function runFF(ff, args) {
  const code = await ff.exec(args);
  if (typeof code === 'number' && code !== 0) throw new Error(`ffmpeg a échoué (code ${code})`);
}

/** Remplace la piste audio d'une vidéo par un WAV traité. Vidéo copiée telle quelle. */
export async function replaceAudioInVideo(videoFile, wavBlob, log, onProgress) {
  const ff = await getFF(log);
  if (onProgress) ff.on('progress', ({ progress }) => onProgress(progress));
  const { fetchFile } = await import('/vendor/util/index.js');

  const ext = (videoFile.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
  const inName = `in.${ext}`;
  let mounted = false;
  if (typeof ff.mount === 'function') {
    try {
      await ff.createDir('/src').catch(() => {});
      await ff.mount('WORKERFS', { blobs: [{ name: inName, data: videoFile }] }, '/src');
      mounted = true;
    } catch {}
  }
  if (!mounted) await ff.writeFile(inName, await fetchFile(videoFile));
  await ff.writeFile('proc.wav', await fetchFile(wavBlob));

  try {
    await runFF(ff, [
      '-i', mounted ? `/src/${inName}` : inName,
      '-i', 'proc.wav',
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '160k',
      '-shortest', '-movflags', '+faststart',
      'out.mp4',
    ]);
    const data = await ff.readFile('out.mp4');
    return new Blob([data.buffer], { type: 'video/mp4' });
  } finally {
    try { await ff.deleteFile('proc.wav'); } catch {}
    try { await ff.deleteFile('out.mp4'); } catch {}
    if (mounted) { try { await ff.unmount('/src'); } catch {} }
    else { try { await ff.deleteFile(inName); } catch {} }
  }
}

/** Convertit un WAV en M4A (AAC 192 kb/s), plus léger à partager. */
export async function wavToM4a(wavBlob, log, onProgress) {
  const ff = await getFF(log);
  if (onProgress) ff.on('progress', ({ progress }) => onProgress(progress));
  const { fetchFile } = await import('/vendor/util/index.js');
  await ff.writeFile('a.wav', await fetchFile(wavBlob));
  try {
    await runFF(ff, ['-i', 'a.wav', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', 'a.m4a']);
    const data = await ff.readFile('a.m4a');
    return new Blob([data.buffer], { type: 'audio/mp4' });
  } finally {
    try { await ff.deleteFile('a.wav'); } catch {}
    try { await ff.deleteFile('a.m4a'); } catch {}
  }
}

// ==================== FFT (radix-2, réels) ====================
// Petite FFT autonome pour le traitement spectral de l'Echo Remover.
export function fftForward(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
export function fftInverse(re, im) {
  for (let i = 0; i < im.length; i++) im[i] = -im[i];
  fftForward(re, im);
  const n = re.length;
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
}
