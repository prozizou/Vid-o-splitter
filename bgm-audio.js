/* =============================================================================
   BGM-AUDIO.JS — sons de fond « nature », à partir de VRAIS enregistrements
   (forêt, chants d'oiseaux, jungle), en complément des ambiances synthétisées
   de bgm.js (bruit rose, pluie, nappe, vagues).

   Contrairement à bgm.js, ce module N'EST PAS pur : décoder un fichier audio
   exige fetch() + AudioContext, deux API du navigateur absentes de l'environ-
   nement de test Node (`npm test`). C'est pourquoi les briques réutilisables
   (mélange, écriture WAV, bouclage en fondu-enchaîné, ré-échantillonnage)
   vivent dans bgm.js, testées sans dépendance ; seul le décodage et le cache
   vivent ici.

   Les fichiers sont servis en same-origin (voir /audio, build.sh, sw.js) —
   rien n'est téléchargé depuis un autre domaine, la CSP `connect-src 'self'`
   (vercel.json) l'empêcherait de toute façon.
   ========================================================================== */

import { mixInto, pcmMonoToWavBlob, loopToLength, resampleLinear, trimSilence, dbToLin } from './bgm.js';

export const BGM_AUDIO_TYPES = {
  birds:  "Forêt — chants d'oiseaux",
  jungle: 'Jungle tropicale',
};

const SOURCES = {
  birds:  '/audio/bgm-foret.m4a',
  jungle: '/audio/bgm-jungle.m4a',
};

export function isBgmAudioType(type) {
  return Object.prototype.hasOwnProperty.call(BGM_AUDIO_TYPES, type);
}

// type -> { samples: Float32Array mono, sr: number }
const cache = new Map();
// type -> Promise<void>, le temps du chargement (évite de fetch/décoder deux
// fois si l'utilisateur clique "Écouter" pendant que le préchargement tourne).
const pending = new Map();

/**
 * Charge et décode l'ambiance `type` si ce n'est pas déjà fait. À appeler
 * (et attendre) AVANT tout rendu : renderBgmAudio est synchrone et ne peut
 * pas décoder à la volée — voir app.js (sélection dans le panneau, et juste
 * avant de lancer le traitement).
 */
export async function preloadBgmAudio(type) {
  if (!isBgmAudioType(type) || cache.has(type)) return;
  if (pending.has(type)) return pending.get(type);

  const p = (async () => {
    const res = await fetch(SOURCES[type]);
    if (!res.ok) {
      throw new Error(`Impossible de charger l'ambiance « ${BGM_AUDIO_TYPES[type]} » (HTTP ${res.status}).`);
    }
    const ab = await res.arrayBuffer();
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    // Le contexte hors-ligne ne sert qu'à décoder : sa longueur/durée n'a pas
    // d'importance, decodeAudioData renvoie l'AudioBuffer complet du fichier,
    // ré-échantillonné à la fréquence DU CONTEXTE (44100 Hz ici, la même que
    // le WAV de fond côté moteur ffmpeg).
    const octx = new OfflineCtx(1, 1, 44100);
    const buf = await octx.decodeAudioData(ab);

    // Sous-mixage mono (moyenne des canaux) : un lit sonore de fond n'a pas
    // besoin de stéréo, et ça simplifie le mélange (même signal partout,
    // comme les ambiances synthétisées de bgm.js).
    const n = buf.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels;
    }
    // Les deux enregistrements fournis commencent par plusieurs secondes de
    // silence numérique pur (carton d'intro) : sans ce nettoyage, l'écoute
    // (3 s, voir bgmTest dans app.js) tombe quasi systématiquement dedans, et
    // le bouclage (loopToLength) réintroduit ce trou à chaque répétition
    // plutôt qu'une seule fois. Coupé UNE fois ici, en cache.
    const trimmed = trimSilence(mono, buf.sampleRate);
    cache.set(type, { samples: trimmed, sr: buf.sampleRate });
  })();

  pending.set(type, p);
  try {
    await p;
  } finally {
    pending.delete(type);
  }
}

/** true si `type` est déjà décodé et prêt à être rendu sans attente. */
export function isBgmAudioReady(type) {
  return cache.has(type);
}

/**
 * Rend `n` échantillons de l'ambiance `type` à la fréquence `sr`, en
 * bouclant l'enregistrement (fondu-enchaîné, voir loopToLength) s'il est
 * plus court que la durée demandée. Nécessite preloadBgmAudio(type) déjà
 * résolu — sinon renvoie du silence plutôt que de planter.
 */
export function renderBgmAudio(type, sr, n) {
  if (!isBgmAudioType(type) || !(n > 0)) return new Float32Array(0);
  const entry = cache.get(type);
  if (!entry) return new Float32Array(n); // pas encore chargé (ne devrait pas arriver, voir preload)

  const src = entry.sr === sr ? entry.samples : resampleLinear(entry.samples, entry.sr, sr);
  const out = loopToLength(src, sr, n);

  // Même micro-fondu aux extrémités que renderBgm (bgm.js) : chaque partie
  // est rendue indépendamment, donc chacune a son propre début/fin — sans ce
  // fondu, chaque coupure de partie ajouterait un clic.
  const f = Math.min(Math.round(0.015 * sr), out.length >> 1);
  for (let i = 0; i < f; i++) { out[i] *= i / f; out[out.length - 1 - i] *= i / f; }
  return out;
}

/** Mélange l'ambiance `type` dans des canaux PCM existants (sur place) —
 * pendant du moteur turbo (voir mixBg dans bgm.js). */
export function mixBgAudio(channels, sr, type, gainDb) {
  if (!isBgmAudioType(type) || !channels.length || !channels[0].length) return;
  const bg = renderBgmAudio(type, sr, channels[0].length);
  mixInto(channels, bg, gainDb);
}

/** Fabrique un WAV mono de `totalSec`, l'ambiance seule, au volume demandé —
 * pendant du moteur ffmpeg (voir makeBgWav dans bgm.js). Précharge si besoin. */
export async function makeBgAudioWav(totalSec, sr, type, gainDb) {
  await preloadBgmAudio(type);
  const n = Math.max(1, Math.round(totalSec * sr));
  const bg = renderBgmAudio(type, sr, n);
  const gain = dbToLin(gainDb);
  const bed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bg[i] * gain;
    if (v > 1) v = 1; else if (v < -1) v = -1;
    bed[i] = v;
  }
  return pcmMonoToWavBlob(bed, sr);
}
