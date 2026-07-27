/* =============================================================================
   TURBO · RENDU DES PARTIES (cœur du moteur)
   -----------------------------------------------------------------------------
   La passe unique sur le fichier : décodage matériel des seuls groupes d'images
   utiles, tri/rognage/conversion des images conservées, fondus, ré-encodage
   H.264 + AAC, multiplexage. turboRenderAll gère le repli matériel -> logiciel ;
   renderAllOnce fait le travail. C'est le plus gros module, et le seul qui
   orchestre tous les autres.
   ========================================================================== */

import {
  US, usOf, sleep, withTimeout, drainTo, errorSink, guarded,
  FLUSH_TIMEOUT_MS, IN_FLIGHT_MAX,
} from './turbo-util.js';
import {
  loadMP4Box, loadMuxer, createSampleStream,
  videoDescription, audioDescription, audioBitrate, createGopPrimer,
} from './turbo-mp4.js';
import { align16, MAX_FPS, pickVideoConfig } from './turbo-video.js';
import { applyEQ } from './turbo-audio.js';
import { mixBed, alphaAt } from './sfx.js';

/**
 * @param parts  [{ index, t0, t1, segs: [[s,e],...] }]  (secondes)
 * @param opts   { crf, eq, audioFadeSec, videoFadeSec, sfx: {type, gainDb} }
 * @param cb     { onPartStart, onPartDone, onProgress, shouldStop }
 */
/**
 * Rend toutes les parties, avec repli du MATERIEL vers le LOGICIEL.
 *
 * Les codecs materiels des telephones echouent parfois sur un flux qu'ils
 * jugent hors de leurs capacites, avec un laconique « Decoding error ». Plutot
 * que de retomber aussitot sur ffmpeg.wasm (~0,2x temps reel), on retente avec
 * les codecs LOGICIELS du navigateur : ils restent bien plus rapides que
 * x264 compile en WebAssembly.
 *
 * Le second essai relit le fichier depuis le debut et saute les parties deja
 * produites, donc rien n'est refait inutilement.
 */
export async function turboRenderAll(file, parts, opts, cb) {
  try {
    return await renderAllOnce(file, parts, opts, cb, 'prefer-hardware');
  } catch (e) {
    const dejaFait = parts.some(p => p.status === 'done');
    const codec = /decod|encod/i.test(e.message || '');
    if (dejaFait || !codec) throw e;   // rien a gagner a tout recommencer
    if (cb.onLog) {
      cb.onLog(`⚠️ Codec matériel en échec (${e.message}).`);
      cb.onLog('↩️ Nouvel essai avec les codecs logiciels du navigateur.');
    }
    return await renderAllOnce(file, parts, opts, cb, 'no-preference');
  }
}

async function renderAllOnce(file, parts, opts, cb, accel) {
  const MP4Box = await loadMP4Box();
  const { Muxer, ArrayBufferTarget } = await loadMuxer();
  const sink = errorSink();

  const stream = await createSampleStream(file, MP4Box, []);
  const vT = stream.info.videoTracks && stream.info.videoTracks[0];
  const aT = stream.info.audioTracks && stream.info.audioTracks[0];
  if (!vT) throw new Error("Aucune piste vidéo exploitable.");

  const wanted = [vT.id]; if (aT) wanted.push(aT.id);
  for (const id of wanted) stream.mp4.setExtractionOptions(id, null, { nbSamples: 50 });
  stream.mp4.start();

  const W = vT.track_width || vT.video.width;
  const H = vT.track_height || vT.video.height;

  // Conversion optionnelle vers un format de sortie FIXE (ex. 720×1296@30fps
  // pour les reseaux sociaux), demandee via opts.output = { width, height, fps }.
  // Sans elle : comportement historique, on garde la resolution source (rognee
  // au multiple de 16 exige par le materiel).
  const target = opts.output && opts.output.width && opts.output.height ? opts.output : null;

  // `VideoEncoder.isConfigSupported` peut repondre « supported » sans
  // verifier l'alignement sur 16 exige par beaucoup d'encodeurs MATERIELS
  // (Android/MediaCodec en tete) : l'echec ne se produit qu'AU RENDU, avec un
  // laconique « Encoding error » — turboRenderAll le rattrape (repli
  // logiciel), mais on perd l'acceleration materielle pour rien. Voir align16().
  const encW = align16(target ? target.width : W);
  const encH = align16(target ? target.height : H);

  // Rectangle SOURCE echantillonne pour remplir encW×encH dans emit() :
  //  - conversion : mise a l'echelle « cover » (on remplit tout le cadre puis
  //    on rogne ce qui depasse), rapport d'aspect preserve, source centree —
  //    exactement le cadrage attendu pour un passage paysage -> portrait ;
  //  - sinon : rognage historique du coin haut-gauche au multiple de 16.
  let srcX = 0, srcY = 0, srcW = W, srcH = H;
  if (target) {
    const scale = Math.max(encW / W, encH / H);
    srcW = Math.min(W, Math.round(encW / scale));
    srcH = Math.min(H, Math.round(encH / scale));
    srcX = Math.floor((W - srcW) / 2);
    srcY = Math.floor((H - srcH) / 2);
  } else {
    srcW = encW; srcH = encH;   // rognage coin haut-gauche (no-op si == W/H)
  }
  const needsCrop = target != null || encW !== W || encH !== H;

  const srcFps = Math.max(1, Math.round((vT.nb_samples * vT.timescale) / vT.duration)) || 30;
  // On ne SUR-echantillonne jamais (dupliquer des images n'apporte rien) : viser
  // 30 im/s plafonne a 30, une source plus lente reste a sa cadence.
  const capFps = Math.min(MAX_FPS, target && target.fps ? target.fps : MAX_FPS);
  const fps = Math.min(srcFps, capFps);
  // > 0 : les images en trop sont ignorees dans emit(), voir MAX_FPS.
  const minFrameGapUs = srcFps > capFps ? Math.round(US / capFps) : 0;

  const vDesc = videoDescription(stream.mp4, vT.id, MP4Box);
  if (!vDesc) throw new Error("Codec vidéo non pris en charge par le moteur turbo.");
  const { config: encCfg, downgraded } = await pickVideoConfig(encW, encH, fps, opts.crf, accel);
  if (cb.onLog) {
    const capNote = minFrameGapUs > 0
      ? ` (cadence source ${srcFps}fps plafonnée à ${capFps}fps : une image sur ${Math.round(srcFps / capFps)} environ est ignorée)`
      : '';
    const roundNote = encCfg.framerate !== fps ? ` — cadence ${fps}fps arrondie à ${encCfg.framerate}fps pour le matériel` : '';
    // Sur l'echec, encW/encH SONT deja la resolution tentee : inutile de le
    // repeter avec cropNote, qui ne sert qu'a expliquer pourquoi elle differe
    // de la resolution source dans le message de succes.
    const cropNote = target
      ? ` (conversion depuis ${W}×${H} : mise à l'échelle « remplir » puis rognage centré)`
      : needsCrop ? ` (source ${W}×${H}, rognée à un multiple de 16 requis par le matériel)` : '';
    cb.onLog(downgraded
      ? `⚠️ Pas d'encodeur matériel pour ${encW}×${encH}@${fps}fps sur cet appareil : ` +
        `repli sur un encodeur logiciel (${encCfg.codec}).${capNote} Le rendu sera nettement plus lent.`
      : `🎞️ Encodeur : ${encCfg.codec} (${encCfg.hardwareAcceleration}), ${encW}×${encH}@${encCfg.framerate}fps${roundNote}${capNote}${cropNote}.`);
  }

  const aSR = aT ? aT.audio.sample_rate : 0;
  const aCH = aT ? Math.min(2, aT.audio.channel_count) : 0;
  // Débit de la source, pour ré-encoder la voix au MÊME débit qu'à l'origine
  // (voir la config de l'AudioEncoder plus bas). Repli seulement si l'esds ne
  // le déclare pas.
  const aBitrateSrc = aT ? audioBitrate(stream.mp4, aT.id) : 0;

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
  //
  // Les sorties sont consommées DANS le callback, jamais accumulees.
  //
  // Elles etaient auparavant empilees dans un tableau vide par intermittence.
  // Or `await vdec.flush()` fait sortir d'un coup toutes les trames encore
  // retenues par le decodeur materiel, qui en bufferise beaucoup : sur une
  // minute et demie de video, cela fait des milliers de VideoFrame vivantes en
  // meme temps. Une VideoFrame non fermee retient de la memoire GPU, et les
  // decodeurs WebCodecs cessent de produire quand trop de trames restent
  // ouvertes — `flush()` ne se resolvait alors jamais, SANS erreur. Le
  // traitement restait bloque indefiniment sur « Partie 1/1 ».
  //
  // Les decodeurs sont partages entre les parties tandis que emit()/grabAudio()
  // dependent de la partie en cours : d'ou ces deux aiguillages, reaffectes au
  // debut de chaque partie.
  let emitFrame = null;       // (VideoFrame) => void
  let takeAudio = null;       // (AudioData)  => void

  // Rejoue le debut du GOP apres chaque flush : sans lui, la 2e partie et les
  // suivantes echouent sur « A key frame is required after flush() ».
  const primer = createGopPrimer();

  // Les callbacks des DECODEURS doivent etre proteges au meme titre que ceux
  // des encodeurs : depuis qu'ils appellent directement emit()/grabAudio(),
  // une exception levee la (une conversion copyTo refusee, par exemple) partait
  // dans une tache du navigateur et DISPARAISSAIT. Consequences observees : des
  // parties rendues sans aucun son, et des AudioData jamais fermees — donc une
  // pression memoire qui finissait par bloquer le decodeur.
  const vdec = new VideoDecoder({
    output: f => {
      try { if (emitFrame) emitFrame(f); else f.close(); }
      catch (e) { sink.fail(e, 'Traitement vidéo'); try { f.close(); } catch {} }
    },
    error: e => sink.fail(e, 'Décodage vidéo'),
  });
  vdec.configure({ codec: vT.codec, codedWidth: W, codedHeight: H, description: vDesc,
                   hardwareAcceleration: accel, optimizeForLatency: false });

  let adec = null;
  if (aT) {
    adec = new AudioDecoder({
      output: d => {
        try { if (takeAudio) takeAudio(d); else d.close(); }
        catch (e) { sink.fail(e, 'Traitement audio'); try { d.close(); } catch {} }
      },
      error: e => sink.fail(e, 'Décodage audio'),
    });
    adec.configure({
      codec: aT.codec.startsWith('mp4a') ? 'mp4a.40.2' : aT.codec,
      sampleRate: aSR, numberOfChannels: aT.audio.channel_count,
      description: audioDescription(stream.mp4, aT.id, aSR, aT.audio.channel_count) || undefined,
    });
  }

  let processedSec = 0;

  // Toile hors écran : assombrit les images du fondu, et/ou rogne au multiple
  // de 16 exigé par le matériel (voir encW/encH plus haut).
  const fadeUs = Math.round((opts.videoFadeSec || 0) * US);
  let canvas = null, ctx2d = null;
  if (fadeUs > 0 || needsCrop) {
    canvas = new OffscreenCanvas(encW, encH);
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
      video: { codec: 'avc', width: encW, height: encH },
      audio: aT ? { codec: 'aac', numberOfChannels: aCH, sampleRate: aSR } : undefined,
      fastStart: 'in-memory',
      // La toute premiere image d'une partie ne tombe presque jamais pile sur
      // le debut du segment : les images n'existent qu'aux bornes de trame,
      // alors que la coupe est calculee sur l'audio. mp4-muxer refuse par
      // defaut un premier paquet dont l'horodatage n'est pas nul :
      //   « The first chunk for your media track must have a timestamp of 0
      //     (received DTS=0.003333) »
      //
      // On NE prend PAS l'option « offset » que suggere ce message : elle
      // soustrait a chaque piste SA propre premiere valeur, donc elle
      // decalerait la video sans toucher a l'audio — exactement le genre de
      // desynchronisation corrige dans turboJoin. « cross-track-offset »
      // soustrait aux DEUX pistes le minimum des deux : le debut revient a
      // zero ET l'alignement relatif est preserve.
      firstTimestampBehavior: 'cross-track-offset',
    });

    const venc = new VideoEncoder({
      output: guarded(sink, 'Multiplexage vidéo', (chunk, meta) => muxer.addVideoChunk(chunk, meta)),
      error: e => sink.fail(e, 'Encodage vidéo'),
    });
    venc.configure(encCfg);

    let lastKey = -Infinity, firstFrame = true;
    // Avancement DANS la partie. Sans lui, `onProgress` n'etait appele qu'a la
    // fin de chaque partie : sur un fichier rendu en une seule partie, la barre
    // restait figee sur la valeur laissee par l'analyse, du debut a la fin. On
    // ne pouvait pas distinguer « ca travaille » de « c'est bloque ».
    let emittedUs = 0, lastReport = 0, framesOut = 0;
    // Cadence plafonnee a MAX_FPS (voir sa definition) : par partie, puisque
    // chaque partie repart d'un horodatage de sortie proche de zero.
    let lastKeptUs = -Infinity;
    const emit = frame => {
      const m = inRange(frame.timestamp);
      if (!m) { frame.close(); return; }
      const outTs = m.off + (frame.timestamp - m.s);

      if (minFrameGapUs > 0 && outTs - lastKeptUs < minFrameGapUs) { frame.close(); return; }
      lastKeptUs = outTs;

      const dur = minFrameGapUs > 0 ? minFrameGapUs : (frame.duration || Math.round(US / fps));

      emittedUs = Math.max(emittedUs, outTs + dur);
      const now = performance.now();
      if (cb.onProgress && now - lastReport > 150) {
        lastReport = now;
        cb.onProgress(processedSec + emittedUs / US);
      }

      // Fondu au noir très bref de part et d'autre de chaque raccord.
      const alpha = fadeUs ? alphaAt(outTs, fadePts, fadeUs) : 1;
      let out;
      if (alpha < 0.999) {
        ctx2d.globalAlpha = 1;
        ctx2d.fillStyle = '#000';
        ctx2d.fillRect(0, 0, encW, encH);
        ctx2d.globalAlpha = alpha;
        // Forme a 9 arguments : echantillonne le rectangle source (srcX,srcY,
        // srcW,srcH) vers tout le cadre encW×encH. En conversion, c'est une mise
        // a l'echelle « cover » ; sans conversion, srcW/srcH valent encW/encH
        // (rognage de quelques px, pas d'etirement), et le tout est un no-op
        // quand encW/encH valent W/H.
        ctx2d.drawImage(frame, srcX, srcY, srcW, srcH, 0, 0, encW, encH);
        out = new VideoFrame(canvas, { timestamp: outTs, duration: dur });
      } else if (needsCrop) {
        // IMPORTANT : la branche du fondu ci-dessus laisse globalAlpha < 1. Sans
        // ce retour a 1, l'image suivante (non fondue) etait dessinee semi
        // transparente par-dessus le contenu precedent de la toile — d'ou des
        // images sombres/noires apres chaque raccord des que la toile sert a
        // TOUTES les images (conversion active, ou source non alignee sur 16).
        ctx2d.globalAlpha = 1;
        ctx2d.drawImage(frame, srcX, srcY, srcW, srcH, 0, 0, encW, encH);
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
      framesOut++;
    };

    // Morceaux audio conservés, un tableau par canal
    const pieces = aT ? Array.from({ length: aCH }, () => []) : null;
    // Tampons réutilisés : sans eux on allouait un Float32Array par canal ET
    // par segment chevauchant, dans la boucle audio la plus chaude du moteur.
    const scratch = [];
    let interleaved = null;
    let audioSamples = 0;
    let planarRefused = false;   // le navigateur refuse la conversion planaire

    /**
     * Extrait les canaux d'un AudioData dans `scratch`, en float 32 planaire.
     *
     * Tous les navigateurs n'acceptent pas que `copyTo` CONVERTISSE vers
     * 'f32-planar' quand la sortie du décodeur est entrelacée. Le repli
     * récupère l'entrelacé et désentrelace ici. Sans lui, l'exception partait
     * dans une tâche du navigateur, invisible : la partie sortait sans aucun
     * son, et les AudioData n'étaient jamais fermées.
     */
    const extractChannels = data => {
      const n = data.numberOfFrames;
      const nCh = data.numberOfChannels;
      for (let c = 0; c < aCH; c++) {
        if (!scratch[c] || scratch[c].length < n) scratch[c] = new Float32Array(n);
      }
      if (!planarRefused) {
        try {
          for (let c = 0; c < aCH; c++) {
            data.copyTo(scratch[c].subarray(0, n), {
              planeIndex: Math.min(c, nCh - 1), format: 'f32-planar',
            });
          }
          return;
        } catch { planarRefused = true; }   // on ne réessaiera plus
      }
      const total = n * nCh;
      if (!interleaved || interleaved.length < total) interleaved = new Float32Array(total);
      data.copyTo(interleaved.subarray(0, total), { planeIndex: 0, format: 'f32' });
      for (let c = 0; c < aCH; c++) {
        const src = Math.min(c, nCh - 1), dst = scratch[c];
        for (let i = 0; i < n; i++) dst[i] = interleaved[i * nCh + src];
      }
    };

    const grabAudio = data => {
      try {
        const ts = data.timestamp, n = data.numberOfFrames;
        const end = ts + Math.round((n / aSR) * US);

        // Ce paquet touche-t-il un segment conservé ? Sinon, aucune copie.
        let touches = false;
        for (const m of map) { if (m.s < end && m.e > ts) { touches = true; break; } }
        if (!touches) return;

        extractChannels(data);

        for (const m of map) {
          const s = Math.max(ts, m.s), e = Math.min(end, m.e);
          if (e <= s) continue;
          const from = Math.round(((s - ts) / US) * aSR);
          const to = Math.min(n, Math.round(((e - ts) / US) * aSR));
          if (to <= from) continue;
          for (let c = 0; c < aCH; c++) pieces[c].push(scratch[c].slice(from, to));
          audioSamples += to - from;
        }
      } finally {
        // Fermeture garantie : une AudioData non fermee retient de la memoire.
        data.close();
      }
    };

    // --- Alimentation des décodeurs jusqu'à la fin de la partie -----
    // Les sorties des décodeurs partent directement vers cette partie.
    emitFrame = emit;
    takeAudio = grabAudio;

    const endUs = Math.round(part.t1 * US);
    let item;
    while ((item = await stream.peek())) {
      sink.check();                                  // erreur d'un codec ou du muxer
      const s = item.s;
      const ts = usOf(s.cts, s.timescale);
      // On decide la fin d'une partie sur la piste VIDEO. Mais dans un MP4 non
      // entrelace — toutes les images video ecrites AVANT tout l'audio, mise en
      // page produite par certains enregistreurs d'ecran / applis Android —
      // l'audio de la partie arrive APRES sa derniere image dans le flux. Rompre
      // sur la video laissait alors l'audio ENTIER non lu : le decodeur audio
      // n'etait jamais alimente, grabAudio ne tournait pas, et la partie sortait
      // muette (« aucun échantillon récupéré ») avant de retomber sur ffmpeg.
      //
      // Sur la DERNIERE partie, plus rien en aval n'a besoin du flux : on le lit
      // donc jusqu'au bout pour recuperer cet audio en retard. Passe endUs il n'y
      // a plus de segment conserve (silence final), donc aucune image n'est
      // « needed » : rien n'est redecode, on ne fait que draîner l'audio.
      //
      // Sur une partie NON finale, il FAUT s'arreter au raccord : les echantillons
      // suivants (video comme audio) appartiennent aux parties d'apres, qui
      // reprennent le flux la ou on l'a laisse. Un fichier non entrelace decoupe
      // en plusieurs parties reste ainsi confie a ffmpeg via ce meme garde-fou.
      if (ts >= endUs && item.id === vT.id && !isLast) break;
      await stream.take();

      if (item.id === vT.id) {
        if (needed[s.number]) {
          const chunk = {
            type: s.is_sync ? 'key' : 'delta', timestamp: ts,
            duration: usOf(s.duration, s.timescale), data: s.data,
          };
          // Après un flush, le décodeur exige une image clé : on lui rejoue le
          // début du groupe d'images en cours. Voir createGopPrimer().
          for (const prime of primer.accept(chunk)) {
            vdec.decode(new EncodedVideoChunk(prime));
          }
          vdec.decode(new EncodedVideoChunk(chunk));
        }
      } else if (aT && item.id === aT.id) {
        adec.decode(new EncodedAudioChunk({
          type: 'key', timestamp: ts, duration: usOf(s.duration, s.timescale), data: s.data,
        }));
      }

      // BARRIERE, pas un simple ralentissement. Un « if ... await sleep(4) »
      // ne fait que ralentir : on continuait a alimenter des milliers de
      // paquets alors que l'encodeur etait deja sature, et sa file interne
      // grossissait sans limite jusqu'au blocage. Ici on ATTEND que les files
      // redescendent, ce qui borne reellement la memoire en vol — et laisse
      // peu de travail au flush final, la ou aucun freinage n'est possible.
      // Reveil sur evenement, pas sondage : voir drainTo().
      if (venc.encodeQueueSize > IN_FLIGHT_MAX) await drainTo(venc, 'encodeQueueSize', IN_FLIGHT_MAX);
      if (vdec.decodeQueueSize > IN_FLIGHT_MAX) await drainTo(vdec, 'decodeQueueSize', IN_FLIGHT_MAX);
      sink.check();
    }

    // Un décodeur qui ne rend jamais la main bloquait le traitement pour
    // toujours, sans message : mieux vaut échouer et laisser app.js basculer
    // sur ffmpeg. Le délai est large — il ne doit se déclencher qu'en cas de
    // blocage réel, pas sur une machine lente.
    await withTimeout(vdec.flush(), FLUSH_TIMEOUT_MS, 'le décodeur vidéo ne répond plus');
    primer.afterFlush();   // le décodeur exigera une image clé
    if (adec) await withTimeout(adec.flush(), FLUSH_TIMEOUT_MS, 'le décodeur audio ne répond plus');

    // On débranche AVANT de fermer l'encodeur : une trame arrivée en retard
    // serait sinon poussée dans un encodeur fermé. Les sorties tardives sont
    // désormais simplement libérées (voir les callbacks des décodeurs).
    emitFrame = null;
    takeAudio = null;

    await withTimeout(venc.flush(), FLUSH_TIMEOUT_MS, "l'encodeur vidéo ne répond plus");
    sink.check();

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
        output: guarded(sink, 'Multiplexage audio', (chunk, meta) => muxer.addAudioChunk(chunk, meta)),
        error: e => sink.fail(e, 'Encodage audio'),
      });
      // VOIX ROBOTIQUE — la source est presque toujours DEJA de l'AAC, donc la
      // ré-encoder est un encodage EN TANDEM. Ré-encoder à un débit DIFFÉRENT de
      // l'original colore le timbre (pré-écho du MDCT amplifié par la 2e
      // génération) : c'est ce qu'on entend comme une voix « métallique /
      // robotique ». On garde donc les paramètres de départ inchangés — même
      // fréquence, mêmes canaux, et surtout MÊME débit que la source. Repli sur
      // 192 kb/s seulement si l'esds ne déclare aucun débit exploitable.
      const aBitrate = aBitrateSrc || 192_000;
      aenc.configure({ codec: 'mp4a.40.2', sampleRate: aSR, numberOfChannels: aCH, bitrate: aBitrate });

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
      sink.check();
    }

    venc.close();
    muxer.finalize();
    sink.check();       // ne jamais livrer un MP4 tronqué comme s'il était bon

    // Une partie muette alors que la source a du son est un ECHEC, pas un
    // resultat : mieux vaut basculer sur ffmpeg que livrer un fichier sans
    // audio sans rien dire. C'est exactement ce qui s'est produit tant que les
    // exceptions des callbacks de decodage etaient perdues.
    if (aT && audioSamples === 0) {
      throw new Error(
        `partie ${part.index + 1} rendue sans audio alors que la source en a ` +
        `(aucun échantillon récupéré sur ${map.length} segment(s))`);
    }
    if (cb.onLog) {
      const abNote = aT
        ? `, audio AAC ${Math.round((aBitrateSrc || 192_000) / 1000)} kb/s` +
          (aBitrateSrc ? ' (débit source conservé)' : ' (source non déclarée)')
        : '';
      cb.onLog(`   partie ${part.index + 1} : ${framesOut} image(s), ` +
               `${(audioSamples / (aSR || 1)).toFixed(1)} s d'audio${abNote}` +
               (planarRefused ? ' — audio désentrelacé sur repli' : ''));
    }

    const blob = new Blob([target.buffer], { type: 'video/mp4' });

    processedSec += partDurUs / US;
    cb.onProgress && cb.onProgress(processedSec);
    await cb.onPartDone(part, blob);
  }

  try { vdec.close(); } catch {}
  if (adec) { try { adec.close(); } catch {} }
}
