/* =============================================================================
   MOTEUR TURBO — WebCodecs
   -----------------------------------------------------------------------------
   Remplace ffmpeg.wasm (x264 logiciel, ~0,2× temps réel) par les codecs
   matériels du téléphone (VideoDecoder / VideoEncoder), soit 10× à 50× plus vite.

   Chaîne : mp4box.js (démultiplexage)
            -> VideoDecoder -> [tri des segments] -> VideoEncoder   (matériel)
            -> AudioDecoder -> [égaliseur OfflineAudioContext] -> AudioEncoder
            -> mp4-muxer (remultiplexage)

   Tout est fait en UNE seule passe sur le fichier, dans l'ordre des parties.
   Les GOP entièrement situés dans un silence ne sont même pas décodés.

   Ce module ne lève jamais d'exception silencieuse : en cas d'échec, l'appelant
   (app.js) bascule automatiquement sur le moteur ffmpeg.
   ========================================================================== */

import { mixBed, alphaAt } from './sfx.js';

const MUXER_URL = '/vendor/mp4-muxer/mp4-muxer.mjs';
const MP4BOX_URL = '/vendor/mp4box/mp4box.all.js';

const US = 1_000_000; // microsecondes par seconde

// ==================== DISPONIBILITÉ ====================
export function turboSupported() {
  return typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined'
      && typeof AudioDecoder !== 'undefined' && typeof AudioEncoder !== 'undefined'
      && typeof VideoFrame !== 'undefined' && typeof AudioData !== 'undefined';
}

// ==================== CHARGEMENT DES DÉPENDANCES ====================
let _mp4box, _muxer;
function loadMP4Box() {
  if (_mp4box) return _mp4box;
  _mp4box = new Promise((res, rej) => {
    if (self.MP4Box) return res(self.MP4Box);
    const s = document.createElement('script');
    s.src = MP4BOX_URL;
    s.onload = () => (self.MP4Box ? res(self.MP4Box) : rej(new Error('mp4box non chargé')));
    s.onerror = () => rej(new Error('mp4box introuvable dans /vendor'));
    document.head.appendChild(s);
  });
  return _mp4box;
}
function loadMuxer() { return _muxer || (_muxer = import(MUXER_URL)); }

// ==================== OUTILS ====================
const sleep = (ms = 0) => new Promise(r => setTimeout(r, ms));
const usOf = (cts, timescale) => Math.round((cts / timescale) * US);

// Récupère la « description » du codec (avcC / hvcC) exigée par VideoDecoder.
function videoDescription(mp4file, trackId, MP4Box) {
  const trak = mp4file.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (!box) continue;
    const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer, 8); // on saute l'en-tête de boîte
  }
  return null;
}

// AudioSpecificConfig (esds) ; sinon on la reconstruit à partir du profil AAC-LC.
const SR_INDEX = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
function audioDescription(mp4file, trackId, sampleRate, channels) {
  try {
    const trak = mp4file.getTrackById(trackId);
    const esds = trak.mdia.minf.stbl.stsd.entries[0].esds;
    const desc = esds.esd.descs[0].descs[0];
    if (desc && desc.data && desc.data.length) return new Uint8Array(desc.data);
  } catch {}
  const i = SR_INDEX.indexOf(sampleRate);
  if (i < 0) return null;
  const objType = 2; // AAC-LC
  const b0 = (objType << 3) | (i >> 1);
  const b1 = ((i & 1) << 7) | (channels << 3);
  return new Uint8Array([b0, b1]);
}

// ==================== FLUX D'ÉCHANTILLONS ====================
// Lit le fichier par tranches de 4 Mo et livre les échantillons dans l'ordre.
// La lecture se met en pause dès que la file d'attente est pleine : la mémoire
// ne dépasse jamais quelques dizaines de Mo, même sur un fichier de 2 Go.
async function createSampleStream(file, MP4Box, wanted) {
  const mp4 = MP4Box.createFile();
  const queue = [];
  let notify = null, finished = false, failed = null;

  const ready = new Promise((res, rej) => {
    mp4.onReady = info => res(info);
    mp4.onError = e => { failed = new Error('Fichier illisible : ' + e); rej(failed); };
  });
  mp4.onSamples = (id, _u, samples) => {
    for (const s of samples) queue.push({ id, s });
    mp4.releaseUsedSamples(id, samples[samples.length - 1].number + 1);
    if (notify) { notify(); notify = null; }
  };

  (async () => {
    const CH = 4 * 1024 * 1024;
    let off = 0;
    try {
      while (off < file.size) {
        while (queue.length > 400) await sleep(4);
        const buf = await file.slice(off, Math.min(off + CH, file.size)).arrayBuffer();
        buf.fileStart = off;
        mp4.appendBuffer(buf);
        off += CH;
      }
      mp4.flush();
    } catch (e) { failed = e; }
    finished = true;
    if (notify) { notify(); notify = null; }
  })();

  const info = await ready;
  for (const id of wanted) mp4.setExtractionOptions(id, null, { nbSamples: 50 });
  mp4.start();

  let pushback = null;
  return {
    mp4, info,
    peek: async () => (pushback ||= await pull()),
    take: async () => { if (pushback) { const p = pushback; pushback = null; return p; } return pull(); },
  };

  async function pull() {
    while (!queue.length) {
      if (failed) throw failed;
      if (finished) return null;
      await new Promise(r => { notify = r; });
    }
    return queue.shift();
  }
}

// ==================== ANALYSE AUDIO (sans ffmpeg) ====================
// Calcule directement l'enveloppe RMS : on ne stocke jamais le PCM entier.
export async function turboAnalyze(file, windowSec, onProgress) {
  const MP4Box = await loadMP4Box();
  const probe = MP4Box.createFile();
  // Passe 1 minimale : on a juste besoin de la piste audio.
  const stream = await createSampleStream(file, MP4Box, []);
  const aTrack = stream.info.audioTracks && stream.info.audioTracks[0];
  if (!aTrack) throw new Error("Aucune piste audio dans cette vidéo.");
  stream.mp4.setExtractionOptions(aTrack.id, null, { nbSamples: 50 });
  stream.mp4.start();

  const sr = aTrack.audio.sample_rate;
  const ch = aTrack.audio.channel_count;
  const duration = aTrack.duration / aTrack.timescale;
  const win = Math.max(1, Math.floor(sr * windowSec));

  const loud = [];
  let acc = 0, accN = 0;

  const dec = new AudioDecoder({
    output: data => {
      const n = data.numberOfFrames;
      const buf = new Float32Array(n);
      const mix = new Float32Array(n);
      for (let c = 0; c < Math.min(ch, data.numberOfChannels); c++) {
        data.copyTo(buf, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < n; i++) mix[i] += buf[i] / ch;
      }
      data.close();
      for (let i = 0; i < n; i++) {
        acc += mix[i] * mix[i]; accN++;
        if (accN === win) { loud.push(Math.sqrt(acc / accN)); acc = 0; accN = 0; }
      }
    },
    error: e => { throw e; },
  });
  dec.configure({
    codec: aTrack.codec.startsWith('mp4a') ? 'mp4a.40.2' : aTrack.codec,
    sampleRate: sr, numberOfChannels: ch,
    description: audioDescription(stream.mp4, aTrack.id, sr, ch) || undefined,
  });

  let item;
  while ((item = await stream.take())) {
    if (item.id !== aTrack.id) continue;
    const s = item.s;
    dec.decode(new EncodedAudioChunk({
      type: 'key', timestamp: usOf(s.cts, s.timescale),
      duration: usOf(s.duration, s.timescale), data: s.data,
    }));
    if (dec.decodeQueueSize > 60) await sleep(2);
    if (onProgress && loud.length) onProgress(Math.min(1, (loud.length * windowSec) / duration));
  }
  await dec.flush();
  dec.close();
  if (accN) loud.push(Math.sqrt(acc / accN));
  void probe;

  return { loud: Float32Array.from(loud), winSec: win / sr, duration };
}

// ==================== ÉGALISEUR (OfflineAudioContext) ====================
// Filtres biquad natifs du navigateur : rapides et de bonne qualité.
async function applyEQ(channels, sampleRate, eq) {
  const active = eq.gains.some(g => g !== 0) || eq.highpass || eq.normalize;
  if (!active || !channels[0].length) return channels;

  const n = channels[0].length;
  const ctx = new OfflineAudioContext(channels.length, n, sampleRate);
  const buf = ctx.createBuffer(channels.length, n, sampleRate);
  channels.forEach((c, i) => buf.copyToChannel(c, i));

  const src = ctx.createBufferSource();
  src.buffer = buf;
  let node = src;

  if (eq.highpass) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 85; hp.Q.value = 0.7;
    node.connect(hp); node = hp;
  }
  eq.freqs.forEach((f, i) => {
    if (!eq.gains[i]) return;
    const b = ctx.createBiquadFilter();
    b.type = 'peaking'; b.frequency.value = f; b.Q.value = eq.q; b.gain.value = eq.gains[i];
    node.connect(b); node = b;
  });
  if (eq.normalize) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24; comp.knee.value = 30; comp.ratio.value = 4;
    comp.attack.value = 0.01; comp.release.value = 0.25;
    const makeup = ctx.createGain(); makeup.gain.value = 1.6;
    node.connect(comp); comp.connect(makeup); node = makeup;
  }
  node.connect(ctx.destination);
  src.start();

  const out = await ctx.startRendering();
  return Array.from({ length: out.numberOfChannels }, (_, i) => out.getChannelData(i));
}

// ==================== CONFIGURATION DE L'ENCODEUR ====================
const CODEC_CANDIDATES = ['avc1.640033', 'avc1.640028', 'avc1.4d0028', 'avc1.42e01e'];

function bitrateFor(w, h, fps, crf) {
  // 0,08 bit/pixel à CRF 23, doublé tous les 6 points de CRF en moins.
  const bpp = 0.08 * Math.pow(2, (23 - crf) / 6);
  return Math.max(400_000, Math.round(w * h * fps * bpp));
}

async function pickVideoConfig(w, h, fps, crf) {
  const base = {
    width: w, height: h, framerate: fps,
    bitrate: bitrateFor(w, h, fps, crf),
    avc: { format: 'avc' },
    hardwareAcceleration: 'prefer-hardware',
  };
  for (const codec of CODEC_CANDIDATES) {
    try {
      const cfg = { ...base, codec };
      const s = await VideoEncoder.isConfigSupported(cfg);
      if (s.supported) return s.config || cfg;
    } catch {}
  }
  // Dernier essai : on laisse le navigateur choisir l'accélération.
  for (const codec of CODEC_CANDIDATES) {
    try {
      const cfg = { ...base, codec, hardwareAcceleration: 'no-preference' };
      const s = await VideoEncoder.isConfigSupported(cfg);
      if (s.supported) return s.config || cfg;
    } catch {}
  }
  throw new Error("Aucun encodeur H.264 disponible sur cet appareil.");
}

// ==================== RENDU DE TOUTES LES PARTIES ====================
/**
 * @param parts  [{ index, t0, t1, segs: [[s,e],...] }]  (secondes)
 * @param opts   { crf, eq, audioFadeSec, videoFadeSec, sfx: {type, gainDb} }
 * @param cb     { onPartStart, onPartDone, onProgress, shouldStop }
 */
export async function turboRenderAll(file, parts, opts, cb) {
  const MP4Box = await loadMP4Box();
  const { Muxer, ArrayBufferTarget } = await loadMuxer();

  const stream = await createSampleStream(file, MP4Box, []);
  const vT = stream.info.videoTracks && stream.info.videoTracks[0];
  const aT = stream.info.audioTracks && stream.info.audioTracks[0];
  if (!vT) throw new Error("Aucune piste vidéo exploitable.");

  const wanted = [vT.id]; if (aT) wanted.push(aT.id);
  for (const id of wanted) stream.mp4.setExtractionOptions(id, null, { nbSamples: 50 });
  stream.mp4.start();

  const W = vT.track_width || vT.video.width;
  const H = vT.track_height || vT.video.height;
  const fps = Math.max(1, Math.round((vT.nb_samples * vT.timescale) / vT.duration)) || 30;

  const vDesc = videoDescription(stream.mp4, vT.id, MP4Box);
  if (!vDesc) throw new Error("Codec vidéo non pris en charge par le moteur turbo.");
  const encCfg = await pickVideoConfig(W, H, fps, opts.crf);

  const aSR = aT ? aT.audio.sample_rate : 0;
  const aCH = aT ? Math.min(2, aT.audio.channel_count) : 0;

  // --- Quels GOP faut-il décoder ? ---------------------------------
  // Un GOP entièrement dans un silence n'est jamais décodé : gain énorme.
  const keep = parts.flatMap(p => p.segs);
  const vSamples = stream.mp4.getTrackById(vT.id).samples;
  const needed = new Uint8Array(vSamples.length);
  {
    let gopStart = 0;
    const flush = (from, to) => {
      const t0 = vSamples[from].cts / vT.timescale;
      const t1 = (vSamples[to].cts + vSamples[to].duration) / vT.timescale;
      const used = keep.some(([s, e]) => s < t1 && e > t0);
      if (used) for (let i = from; i <= to; i++) needed[i] = 1;
    };
    for (let i = 1; i < vSamples.length; i++) {
      if (vSamples[i].is_sync) { flush(gopStart, i - 1); gopStart = i; }
    }
    flush(gopStart, vSamples.length - 1);
  }

  // --- Décodeurs (partagés entre les parties, jamais réinitialisés) --
  let pending = [];           // trames décodées en attente de tri
  const vdec = new VideoDecoder({
    output: f => pending.push(f),
    error: e => { throw new Error('Décodage vidéo : ' + e.message); },
  });
  vdec.configure({ codec: vT.codec, codedWidth: W, codedHeight: H, description: vDesc,
                   hardwareAcceleration: 'prefer-hardware', optimizeForLatency: false });

  let audioPending = [];
  let adec = null;
  if (aT) {
    adec = new AudioDecoder({
      output: d => audioPending.push(d),
      error: e => { throw new Error('Décodage audio : ' + e.message); },
    });
    adec.configure({
      codec: aT.codec.startsWith('mp4a') ? 'mp4a.40.2' : aT.codec,
      sampleRate: aSR, numberOfChannels: aT.audio.channel_count,
      description: audioDescription(stream.mp4, aT.id, aSR, aT.audio.channel_count) || undefined,
    });
  }

  let processedSec = 0;

  // Toile hors écran : sert uniquement à assombrir les images du fondu.
  const fadeUs = Math.round((opts.videoFadeSec || 0) * US);
  let canvas = null, ctx2d = null;
  if (fadeUs > 0) {
    canvas = new OffscreenCanvas(W, H);
    ctx2d = canvas.getContext('2d', { alpha: false });
  }

  // --- Boucle sur les parties ---------------------------------------
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    const isFirst = pi === 0, isLast = pi === parts.length - 1;
    if (cb.shouldStop && cb.shouldStop()) break;
    if (part.status === 'done') { processedSec += part.kept; continue; }
    cb.onPartStart && cb.onPartStart(part);

    // Table de correspondance : temps source -> temps de sortie (µs)
    const map = [];
    let off = 0;
    for (const [s, e] of part.segs) {
      map.push({ s: Math.round(s * US), e: Math.round(e * US), off: Math.round(off * US) });
      off += e - s;
    }
    const partDurUs = Math.round(off * US);
    const inRange = ts => map.find(m => ts >= m.s && ts < m.e);

    // Instants des raccords, en sortie. On ne fond pas le tout début du film
    // ni sa toute fin : seulement les coupes internes et les coutures de parties.
    const fadePts = [];
    map.forEach((m, i) => { if (!(i === 0 && isFirst)) fadePts.push(m.off); });
    if (!isLast) fadePts.push(partDurUs);
    const sfxPtsSec = map
      .filter((_, i) => !(i === 0 && isFirst))
      .map(m => m.off / US);

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: 'avc', width: W, height: H },
      audio: aT ? { codec: 'aac', numberOfChannels: aCH, sampleRate: aSR } : undefined,
      fastStart: 'in-memory',
    });

    const venc = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: e => { throw new Error('Encodage vidéo : ' + e.message); },
    });
    venc.configure(encCfg);

    let lastKey = -Infinity, firstFrame = true;
    const emit = frame => {
      const m = inRange(frame.timestamp);
      if (!m) { frame.close(); return; }
      const outTs = m.off + (frame.timestamp - m.s);
      const dur = frame.duration || Math.round(US / fps);

      // Fondu au noir très bref de part et d'autre de chaque raccord.
      const alpha = fadeUs ? alphaAt(outTs, fadePts, fadeUs) : 1;
      let out;
      if (alpha < 0.999) {
        ctx2d.globalAlpha = 1;
        ctx2d.fillStyle = '#000';
        ctx2d.fillRect(0, 0, W, H);
        ctx2d.globalAlpha = alpha;
        ctx2d.drawImage(frame, 0, 0, W, H);
        out = new VideoFrame(canvas, { timestamp: outTs, duration: dur });
      } else {
        out = new VideoFrame(frame, { timestamp: outTs, duration: dur });
      }
      frame.close();
      const key = firstFrame || (outTs - lastKey) >= 2 * US;
      if (key) lastKey = outTs;
      firstFrame = false;
      venc.encode(out, { keyFrame: key });
      out.close();
    };

    // Morceaux audio conservés, un tableau par canal
    const pieces = aT ? Array.from({ length: aCH }, () => []) : null;
    const grabAudio = data => {
      const ts = data.timestamp, n = data.numberOfFrames;
      const end = ts + Math.round((n / aSR) * US);
      for (const m of map) {
        const s = Math.max(ts, m.s), e = Math.min(end, m.e);
        if (e <= s) continue;
        const from = Math.round(((s - ts) / US) * aSR);
        const to = Math.round(((e - ts) / US) * aSR);
        const count = to - from;
        if (count <= 0) continue;
        for (let c = 0; c < aCH; c++) {
          const tmp = new Float32Array(n);
          data.copyTo(tmp, { planeIndex: Math.min(c, data.numberOfChannels - 1), format: 'f32-planar' });
          pieces[c].push(tmp.subarray(from, to).slice());
        }
      }
      data.close();
    };

    // --- Alimentation des décodeurs jusqu'à la fin de la partie -----
    const endUs = Math.round(part.t1 * US);
    let item;
    while ((item = await stream.peek())) {
      const s = item.s;
      const ts = usOf(s.cts, s.timescale);
      if (ts >= endUs && item.id === vT.id) break;   // la partie suivante commence
      await stream.take();

      if (item.id === vT.id) {
        if (needed[s.number]) {
          vdec.decode(new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta', timestamp: ts,
            duration: usOf(s.duration, s.timescale), data: s.data,
          }));
        }
      } else if (aT && item.id === aT.id) {
        adec.decode(new EncodedAudioChunk({
          type: 'key', timestamp: ts, duration: usOf(s.duration, s.timescale), data: s.data,
        }));
      }

      if (vdec.decodeQueueSize > 24 || pending.length > 24) {
        while (pending.length) emit(pending.shift());
        while (audioPending.length) grabAudio(audioPending.shift());
        if (venc.encodeQueueSize > 24) await sleep(4);
      }
    }

    await vdec.flush();
    if (adec) await adec.flush();
    while (pending.length) emit(pending.shift());
    while (audioPending.length) grabAudio(audioPending.shift());
    await venc.flush();

    // --- Audio : fondus, égaliseur, encodage -----------------------
    if (aT && pieces[0].length) {
      const fade = Math.max(1, Math.round((opts.audioFadeSec || 0.008) * aSR));
      for (const chan of pieces) {
        for (const p of chan) {
          const f = Math.min(fade, p.length >> 1);
          for (let i = 0; i < f; i++) { p[i] *= i / f; p[p.length - 1 - i] *= i / f; }
        }
      }
      let channels = pieces.map(chan => {
        const total = chan.reduce((a, p) => a + p.length, 0);
        const out = new Float32Array(total);
        let o = 0; for (const p of chan) { out.set(p, o); o += p.length; }
        return out;
      });
      pieces.forEach(c => (c.length = 0));
      channels = await applyEQ(channels, aSR, opts.eq);

      // Le son de transition passe APRÈS l'égaliseur : il n'est pas coloré.
      if (opts.sfx && opts.sfx.type !== 'none') {
        mixBed(channels, aSR, sfxPtsSec, opts.sfx.type, opts.sfx.gainDb);
      }

      const aenc = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: e => { throw new Error('Encodage audio : ' + e.message); },
      });
      aenc.configure({ codec: 'mp4a.40.2', sampleRate: aSR, numberOfChannels: aCH, bitrate: 128_000 });

      const BLOCK = 1024;
      for (let i = 0; i < channels[0].length; i += BLOCK) {
        const n = Math.min(BLOCK, channels[0].length - i);
        const planar = new Float32Array(n * aCH);
        for (let c = 0; c < aCH; c++) planar.set(channels[c].subarray(i, i + n), c * n);
        aenc.encode(new AudioData({
          format: 'f32-planar', sampleRate: aSR, numberOfFrames: n,
          numberOfChannels: aCH, timestamp: Math.round((i / aSR) * US), data: planar,
        }));
        if (aenc.encodeQueueSize > 32) await sleep(2);
      }
      await aenc.flush();
      aenc.close();
    }

    venc.close();
    muxer.finalize();
    const blob = new Blob([target.buffer], { type: 'video/mp4' });

    processedSec += partDurUs / US;
    cb.onProgress && cb.onProgress(processedSec);
    await cb.onPartDone(part, blob);
  }

  try { vdec.close(); } catch {}
  if (adec) { try { adec.close(); } catch {} }
}

// ==================== RÉUNION DES PARTIES (sans réencodage) ====================
// On démultiplexe chaque partie et on ré-empile les paquets déjà encodés dans un
// seul MP4, en décalant les horodatages. Aucune image n'est ré-encodée.
export async function turboJoin(blobs) {
  const MP4Box = await loadMP4Box();
  const { Muxer, ArrayBufferTarget } = await loadMuxer();

  let muxer = null, target = null;
  let vOffset = 0, aOffset = 0;
  let vMetaSent = false, aMetaSent = false;

  for (const blob of blobs) {
    const stream = await createSampleStream(blob, MP4Box, []);
    const vT = stream.info.videoTracks[0];
    const aT = stream.info.audioTracks && stream.info.audioTracks[0];
    for (const id of [vT.id, aT && aT.id].filter(Boolean)) {
      stream.mp4.setExtractionOptions(id, null, { nbSamples: 50 });
    }
    stream.mp4.start();

    if (!muxer) {
      target = new ArrayBufferTarget();
      muxer = new Muxer({
        target,
        video: { codec: 'avc', width: vT.track_width, height: vT.track_height },
        audio: aT ? { codec: 'aac', numberOfChannels: Math.min(2, aT.audio.channel_count), sampleRate: aT.audio.sample_rate } : undefined,
        fastStart: 'in-memory',
      });
    }
    const vDesc = videoDescription(stream.mp4, vT.id, MP4Box);
    const aDesc = aT ? audioDescription(stream.mp4, aT.id, aT.audio.sample_rate, aT.audio.channel_count) : null;

    let vEnd = vOffset, aEnd = aOffset, item;
    while ((item = await stream.take())) {
      const s = item.s;
      const ts = usOf(s.cts, s.timescale);
      const dur = usOf(s.duration, s.timescale);
      if (item.id === vT.id) {
        const meta = vMetaSent ? undefined : { decoderConfig: { description: vDesc } };
        vMetaSent = true;
        muxer.addVideoChunkRaw(s.data, s.is_sync ? 'key' : 'delta', vOffset + ts, dur, meta);
        vEnd = Math.max(vEnd, vOffset + ts + dur);
      } else if (aT && item.id === aT.id) {
        const meta = aMetaSent ? undefined : { decoderConfig: { description: aDesc } };
        aMetaSent = true;
        muxer.addAudioChunkRaw(s.data, 'key', aOffset + ts, dur, meta);
        aEnd = Math.max(aEnd, aOffset + ts + dur);
      }
    }
    vOffset = vEnd; aOffset = aEnd;
  }

  muxer.finalize();
  return new Blob([target.buffer], { type: 'video/mp4' });
}
