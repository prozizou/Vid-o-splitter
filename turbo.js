/* =============================================================================
   MOTEUR TURBO — WebCodecs (point d'entrée)
   -----------------------------------------------------------------------------
   Remplace ffmpeg.wasm (x264 logiciel, ~0,2× temps réel) par les codecs
   matériels du téléphone (VideoDecoder / VideoEncoder), soit 10× à 50× plus vite.

   Chaîne : mp4box.js (démultiplexage)
            -> VideoDecoder -> [tri / rognage / conversion] -> VideoEncoder
            -> AudioDecoder -> [égaliseur OfflineAudioContext] -> AudioEncoder
            -> mp4-muxer (remultiplexage)

   Ce fichier ne contient PLUS de logique : c'est une façade qui ré-exporte
   l'API publique. Le moteur est découpé en modules à responsabilité unique,
   pour qu'on puisse en lire un sans avoir à tout tenir en tête :

     turbo-util.js    constantes de temps, détection WebCodecs, plomberie async
                      (temporisation, barrières de file, collecteur d'erreurs).
     turbo-mp4.js     chargement mp4box/mp4-muxer, descriptions de codec, flux
                      d'échantillons paginé, primer de groupe d'images.
     turbo-video.js   configuration de l'encodeur vidéo (débit, cadence,
                      alignement 16, choix d'une config H.264 supportée).
     turbo-audio.js   analyse de sonie, filtre anti-sifflement, égaliseur voix.
     turbo-render.js  le cœur : la passe unique décodage -> rendu -> encodage.
     turbo-join.js    réunion des parties et fusion de fichiers, sans réencodage.

   Le moteur ne lève jamais d'exception silencieuse : en cas d'échec, l'appelant
   (app.js) affiche l'erreur (mode diagnostic) ou bascule sur ffmpeg.
   ========================================================================== */

// API consommée par app.js.
export { turboSupported } from './turbo-util.js';
export { turboAnalyze, WHINE_NOTCHES } from './turbo-audio.js';
export { turboRenderAll } from './turbo-render.js';
export { turboJoin, turboMerge } from './turbo-join.js';

// Exporté en plus pour la suite de tests (`npm test`), qui exerce ces briques
// pures et utilitaires en isolation.
export { withTimeout, drainTo } from './turbo-util.js';
export { snapshotSample, resolveDataStream, createGopPrimer } from './turbo-mp4.js';
export { nearestStdFps, align16 } from './turbo-video.js';
