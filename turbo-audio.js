/* =============================================================================
   TURBO · AUDIO (analyse + égaliseur)
   -----------------------------------------------------------------------------
   Analyse de sonie sans ffmpeg (enveloppe RMS, jamais tout le PCM en mémoire),
   fréquences du filtre anti-sifflement d'écran, et l'égaliseur voix (filtres
   biquad natifs dans un OfflineAudioContext). Le RÉ-encodage AAC lui-même vit
   dans turbo-render.js, au plus près de la boucle qui produit les échantillons.
   ========================================================================== */

import { usOf, sleep, errorSink, guarded } from './turbo-util.js';
import { loadMP4Box, createSampleStream, audioDescription, aacDecoderCodec } from './turbo-mp4.js';

export async function turboAnalyze(file, windowSec, onProgress) {
  const MP4Box = await loadMP4Box();
  const sink = errorSink();
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
    output: guarded(sink, 'Analyse audio', data => {
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
    }),
    error: e => sink.fail(e, 'Décodage audio'),
  });
  dec.configure({
    codec: aTrack.codec.startsWith('mp4a') ? aacDecoderCodec(aTrack.codec) : aTrack.codec,
    sampleRate: sr, numberOfChannels: ch,
    description: audioDescription(stream.mp4, aTrack.id, sr, ch) || undefined,
  });

  let item, lastPaint = 0;
  while ((item = await stream.take())) {
    sink.check();
    if (item.id !== aTrack.id) continue;
    const s = item.s;
    dec.decode(new EncodedAudioChunk({
      type: 'key', timestamp: usOf(s.cts, s.timescale),
      duration: usOf(s.duration, s.timescale), data: s.data,
    }));
    if (dec.decodeQueueSize > 60) await sleep(2);
    // La progression touche au DOM : inutile de la repeindre à chaque paquet.
    if (onProgress && loud.length && performance.now() - lastPaint > 100) {
      lastPaint = performance.now();
      onProgress(Math.min(1, (loud.length * windowSec) / duration));
    }
  }
  await dec.flush();
  dec.close();
  sink.check();
  if (accN) loud.push(Math.sqrt(acc / accN));

  return { loud: Float32Array.from(loud), winSec: win / sr, duration };
}

// Deux sifflements electroniques stables, mesures par analyse spectrale sur
// un enregistrement d'ecran reel : le telephone sous charge soutenue (CPU/GPU
// qui tournent en continu pour capturer l'ecran) genere une interference
// electrique captee par le micro integre, INDEPENDANTE du contenu — presente
// meme dans les silences, a frequence fixe (verifie stable a +/-2% sur 5 min
// de flux). Rien a voir avec le decoupage/reencodage : c'est deja dans ce que
// le micro a enregistre. Un Q de 8 donne une bande assez large pour suivre la
// derive observee (+/- 200 Hz environ selon l'appareil) sans mordre sur la
// voix, dont l'essentiel de l'energie reste bien en dessous de 6 kHz.
// Exportee : app.js s'en sert aussi pour construire le filtre ffmpeg
// equivalent (bandreject), utilise quand WebCodecs est absent du navigateur.
export const WHINE_NOTCHES = [
  { freq: 6930, q: 8 },
  { freq: 8440, q: 8 },
];

// ==================== ÉGALISEUR (OfflineAudioContext) ====================
// Filtres biquad natifs du navigateur : rapides et de bonne qualité.

/**
 * Chaîne highpass -> anti-sifflement -> bandes -> compresseur, à partir de
 * `node` (déjà connecté à sa source). `ctx` peut être un OfflineAudioContext
 * (rendu, voir applyEQ ci-dessous) ou un AudioContext temps réel (aperçu du
 * mix AVANT traitement, voir ensureMixGraph dans app.js) : l'API des noeuds
 * biquad est identique dans les deux cas. Partagée entre les deux pour que
 * l'aperçu entende EXACTEMENT le même traitement que le rendu final — jamais
 * une approximation qui divergerait au fil des évolutions de l'un des deux.
 */
export function buildEqChain(ctx, node, eq) {
  if (eq.highpass) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 85; hp.Q.value = 0.7;
    node.connect(hp); node = hp;
  }
  // Avant l'egaliseur/le compresseur : inutile de laisser un eventuel
  // compresseur amplifier un sifflement qu'on est de toute facon en train de
  // retirer.
  if (eq.whineNotch) {
    for (const { freq, q } of WHINE_NOTCHES) {
      const notch = ctx.createBiquadFilter();
      notch.type = 'notch'; notch.frequency.value = freq; notch.Q.value = q;
      node.connect(notch); node = notch;
    }
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
  return node;
}

async function applyEQ(channels, sampleRate, eq) {
  const active = eq.gains.some(g => g !== 0) || eq.highpass || eq.normalize || eq.whineNotch;
  if (!active || !channels[0].length) return channels;

  const n = channels[0].length;
  const ctx = new OfflineAudioContext(channels.length, n, sampleRate);
  const buf = ctx.createBuffer(channels.length, n, sampleRate);
  channels.forEach((c, i) => buf.copyToChannel(c, i));

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const node = buildEqChain(ctx, src, eq);
  node.connect(ctx.destination);
  src.start();

  const out = await ctx.startRendering();
  return Array.from({ length: out.numberOfChannels }, (_, i) => out.getChannelData(i));
}

export { applyEQ };
