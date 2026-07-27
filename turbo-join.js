/* =============================================================================
   TURBO · RÉUNION & FUSION (sans ré-encodage)
   -----------------------------------------------------------------------------
   turboJoin ré-empile les parties déjà encodées en un seul MP4 ; turboMerge fait
   de même pour plusieurs fichiers source, après avoir vérifié qu'ils partagent
   exactement le même format. Aucune image n'est ré-encodée : on ne fait que
   décaler des horodatages et recopier des paquets.
   ========================================================================== */

import { usOf } from './turbo-util.js';
import {
  loadMP4Box, loadMuxer, createSampleStream,
  videoDescription, audioDescription,
} from './turbo-mp4.js';

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
        // Meme raison que dans turboRenderAll : base commune aux deux pistes,
        // jamais une base par piste, qui les desynchroniserait.
        firstTimestampBehavior: 'cross-track-offset',
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
    // UN SEUL point de départ pour la partie suivante, commun aux deux pistes.
    // Les faire avancer séparément (vOffset = vEnd ; aOffset = aEnd) décalait
    // l'audio de l'image d'un peu moins d'une trame AAC (~21 ms) à CHAQUE
    // couture, et ces écarts s'additionnaient : ~250 ms de désynchronisation en
    // fin de film sur une douzaine de parties.
    vOffset = aOffset = Math.max(vEnd, aEnd);
  }

  muxer.finalize();
  return new Blob([target.buffer], { type: 'video/mp4' });
}

// ==================== FUSION DE PLUSIEURS VIDÉOS (sans réencodage) ====================
// Réempile les paquets de plusieurs fichiers source dans un seul MP4, en
// décalant les horodatages — exactement comme turboJoin, mais on VÉRIFIE d'abord
// que tous les fichiers partagent le MÊME format (codec, dimensions, config avcC,
// paramètres audio). Sinon on lève « INCOMPATIBLE » et app.js réencode via ffmpeg.
// Aucune image n'est ré-encodée : la fusion de clips d'un même appareil est quasi
// instantanée.
function _sameBytes(a, b) {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function turboMerge(files, onProgress) {
  if (!files || files.length === 0) throw new Error('Aucune vidéo à fusionner.');
  if (files.length === 1) return files[0];

  const MP4Box = await loadMP4Box();
  const { Muxer, ArrayBufferTarget } = await loadMuxer();

  let muxer = null, target = null;
  let vOffset = 0, aOffset = 0;
  let vMetaSent = false, aMetaSent = false;
  let ref = null; // format du premier fichier : tous les autres doivent y correspondre

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    const stream = await createSampleStream(file, MP4Box, []);
    const vT = stream.info.videoTracks && stream.info.videoTracks[0];
    if (!vT) throw new Error(`« ${file.name} » n'a pas de piste vidéo lisible.`);
    const aT = stream.info.audioTracks && stream.info.audioTracks[0];

    for (const id of [vT.id, aT && aT.id].filter(Boolean)) {
      stream.mp4.setExtractionOptions(id, null, { nbSamples: 50 });
    }
    stream.mp4.start();

    const vDesc = videoDescription(stream.mp4, vT.id, MP4Box);
    const aDesc = aT ? audioDescription(stream.mp4, aT.id, aT.audio.sample_rate, aT.audio.channel_count) : null;

    const sig = {
      w: vT.track_width, h: vT.track_height,
      vcodec: (vT.codec || '').split('.')[0],
      hasAudio: !!aT,
      asr: aT ? aT.audio.sample_rate : 0,
      ach: aT ? aT.audio.channel_count : 0,
      vDesc, aDesc,
    };

    if (!ref) {
      ref = sig;
      target = new ArrayBufferTarget();
      muxer = new Muxer({
        target,
        video: { codec: 'avc', width: vT.track_width, height: vT.track_height },
        audio: aT ? { codec: 'aac', numberOfChannels: Math.min(2, aT.audio.channel_count), sampleRate: aT.audio.sample_rate } : undefined,
        fastStart: 'in-memory',
        // Meme raison que dans turboRenderAll : base commune aux deux pistes,
        // jamais une base par piste, qui les desynchroniserait.
        firstTimestampBehavior: 'cross-track-offset',
      });
    } else {
      const compatible =
        sig.w === ref.w && sig.h === ref.h &&
        sig.vcodec === ref.vcodec &&
        _sameBytes(sig.vDesc, ref.vDesc) &&
        sig.hasAudio === ref.hasAudio &&
        (!sig.hasAudio || (sig.asr === ref.asr && sig.ach === ref.ach && _sameBytes(sig.aDesc, ref.aDesc)));
      if (!compatible) throw new Error('INCOMPATIBLE');
    }

    let vEnd = vOffset, aEnd = aOffset, item;
    while ((item = await stream.take())) {
      const s = item.s;
      const ts = usOf(s.cts, s.timescale);
      const dur = usOf(s.duration, s.timescale);
      if (item.id === vT.id) {
        const meta = vMetaSent ? undefined : { decoderConfig: { description: sig.vDesc } };
        vMetaSent = true;
        muxer.addVideoChunkRaw(s.data, s.is_sync ? 'key' : 'delta', vOffset + ts, dur, meta);
        vEnd = Math.max(vEnd, vOffset + ts + dur);
      } else if (aT && item.id === aT.id) {
        const meta = aMetaSent ? undefined : { decoderConfig: { description: sig.aDesc } };
        aMetaSent = true;
        muxer.addAudioChunkRaw(s.data, 'key', aOffset + ts, dur, meta);
        aEnd = Math.max(aEnd, aOffset + ts + dur);
      }
    }
    // Origine commune aux deux pistes : voir le commentaire de turboJoin.
    vOffset = aOffset = Math.max(vEnd, aEnd);
    if (onProgress) onProgress((fi + 1) / files.length);
  }

  muxer.finalize();
  return new Blob([target.buffer], { type: 'video/mp4' });
}
