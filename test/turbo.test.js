import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotSample, resolveDataStream, withTimeout, createGopPrimer, drainTo, nearestStdFps, align16, monotonicVideoChunk } from '../turbo.js';

// Node n'a pas de global EncodedVideoChunk : un mini polyfill suffit, il n'a
// besoin que de ce que monotonicVideoChunk() lit/appelle (voir plus bas).
class FakeEncodedVideoChunk {
  constructor({ type, timestamp, duration, data }) {
    this.type = type;
    this.timestamp = timestamp;
    this.duration = duration ?? null;
    this._data = data instanceof Uint8Array ? data : new Uint8Array(data);
  }
  get byteLength() { return this._data.byteLength; }
  copyTo(dest) { dest.set(this._data); }
}
globalThis.EncodedVideoChunk ??= FakeEncodedVideoChunk;

/**
 * Régression : le moteur turbo n'a jamais pu démarrer parce que les
 * échantillons étaient mis en file par référence, alors que mp4box vide leur
 * champ `data` juste après les avoir livrés (releaseUsedSamples ->
 * releaseSample -> `sample.data = null`). Chaque consommateur recevait donc
 * `data: null`, et la construction du premier EncodedAudioChunk échouait :
 *
 *   Failed to construct 'EncodedAudioChunk': [...] The provided value is not
 *   of type '(ArrayBuffer or ArrayBufferView)'
 *
 * Le repli vers ffmpeg étant silencieux, tout tournait sur le moteur lent.
 */

/** Reproduit ce que fait mp4box : vider les données d'un échantillon livré. */
function releaseLikeMp4box(sample) {
  sample.data = null;
  sample.alreadyRead = 0;
}

function fakeSample(n = 7) {
  return {
    number: n, cts: 1024 * n, dts: 1024 * n, duration: 1024,
    timescale: 48000, is_sync: n === 0, size: 4,
    data: new Uint8Array([n, n + 1, n + 2, n + 3]),
  };
}

test('les octets survivent à la libération faite par mp4box', () => {
  const source = fakeSample();
  const copie = snapshotSample(source);

  releaseLikeMp4box(source);          // ce que fait releaseUsedSamples

  assert.equal(source.data, null, 'mp4box vide bien l\'original');
  assert.ok(copie.data instanceof Uint8Array, 'la copie garde un Uint8Array');
  assert.deepEqual(Array.from(copie.data), [7, 8, 9, 10], 'octets intacts');
});

test('la copie ne partage aucune mémoire avec l\'original', () => {
  const source = fakeSample(0);
  const copie = snapshotSample(source);
  source.data[0] = 99;
  assert.equal(copie.data[0], 0, 'modifier la source ne doit pas toucher la copie');
});

test('la copie est compacte, pas une vue sur un gros tampon', () => {
  // mp4box expose souvent des vues sur le tampon du fichier : sans copie
  // compacte, garder un échantillon retiendrait le tampon entier.
  const gros = new Uint8Array(1024);
  const source = { ...fakeSample(), size: 4, data: gros.subarray(100, 104) };
  const copie = snapshotSample(source);
  assert.equal(copie.data.byteLength, 4);
  assert.equal(copie.data.buffer.byteLength, 4, 'le tampon sous-jacent doit être compact');
});

test('tous les champs utilisés en aval sont conservés', () => {
  // Les champs lus par turboRenderAll, turboJoin et turboMerge.
  const source = fakeSample(3);
  const copie = snapshotSample(source);
  for (const champ of ['number', 'cts', 'dts', 'duration', 'timescale', 'is_sync', 'size']) {
    assert.equal(copie[champ], source[champ], `champ ${champ} perdu`);
  }
});

test('un échantillon sans données ne fait pas planter la copie', () => {
  const copie = snapshotSample({ ...fakeSample(), data: null });
  assert.equal(copie.data, null);
});

test('is_sync est preservé : il pilote le marquage des images clés', () => {
  assert.equal(snapshotSample({ ...fakeSample(0), is_sync: true }).is_sync, true);
  assert.equal(snapshotSample({ ...fakeSample(5), is_sync: false }).is_sync, false);
});

/**
 * Régression : `MP4Box` n'expose que `createFile`. La classe `DataStream` est
 * un global SÉPARÉ posé par le même bundle. Chercher `MP4Box.DataStream`
 * donnait `undefined`, et lire `.BIG_ENDIAN` dessus levait
 * « Cannot read properties of undefined (reading 'BIG_ENDIAN') », ce qui
 * interrompait le moteur turbo au rendu et le faisait retomber sur ffmpeg.
 */
test('DataStream est trouvé quand il est un global séparé', () => {
  const MP4Box = { createFile: () => ({}) };          // ce que mp4box expose vraiment
  function DataStream() {}
  DataStream.BIG_ENDIAN = false;
  const scope = { DataStream };
  assert.equal(resolveDataStream(MP4Box, scope), DataStream);
});

test('DataStream est trouvé s\'il est rangé sous MP4Box', () => {
  // Compatibilité ascendante si une version future le déplace.
  function DataStream() {}
  const MP4Box = { createFile: () => ({}), DataStream };
  assert.equal(resolveDataStream(MP4Box, {}), DataStream);
});

test('une absence totale de DataStream donne une erreur explicite', () => {
  assert.throws(
    () => resolveDataStream({ createFile: () => ({}) }, {}),
    /DataStream introuvable/,
    'le message doit nommer le problème, pas « undefined »',
  );
});

test('BIG_ENDIAN vaut false chez mp4box et doit être transmis tel quel', () => {
  // L'endianness y est un booléen où `true` = petit-boutiste. Remplacer la
  // constante par une valeur « vraie » inverserait l'ordre des octets de l'avcC.
  function DataStream() {}
  DataStream.BIG_ENDIAN = false;
  DataStream.LITTLE_ENDIAN = true;
  const DS = resolveDataStream(null, { DataStream });
  assert.equal(DS.BIG_ENDIAN, false);
  assert.notEqual(DS.BIG_ENDIAN, DS.LITTLE_ENDIAN);
});

/**
 * Régression : le rendu pouvait se bloquer indéfiniment SANS erreur.
 *
 * Les trames décodées étaient empilées dans un tableau vidé par intermittence.
 * `await vdec.flush()` fait sortir d'un coup toutes celles que le décodeur
 * matériel retenait ; sur une minute et demie de vidéo cela fait des milliers
 * de VideoFrame vivantes en même temps. Une VideoFrame non fermée retient de la
 * mémoire GPU, et les décodeurs cessent de produire quand trop de trames
 * restent ouvertes : `flush()` ne se résolvait alors jamais. L'interface restait
 * sur « Partie 1/1 » sans rien signaler.
 *
 * Deux réponses : consommer les sorties dans le callback (plus aucune
 * accumulation), et borner l'attente pour qu'un blocage devienne une erreur —
 * app.js bascule alors sur ffmpeg au lieu d'attendre pour toujours.
 */
test('withTimeout laisse passer une promesse qui aboutit', async () => {
  const valeur = await withTimeout(Promise.resolve('ok'), 1000, 'jamais');
  assert.equal(valeur, 'ok');
});

test('withTimeout rejette avec un message explicite quand ça bloque', async () => {
  const jamais = new Promise(() => {});         // ne se résout jamais
  await assert.rejects(
    () => withTimeout(jamais, 20, 'le décodeur vidéo ne répond plus'),
    /le décodeur vidéo ne répond plus.*20 s|le décodeur vidéo ne répond plus/,
  );
});

test('withTimeout laisse remonter l\'erreur d\'origine', async () => {
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error('panne du codec')), 1000, 'délai'),
    /panne du codec/,
    'une vraie erreur ne doit pas être masquée par le garde-fou',
  );
});

test('withTimeout n\'empêche pas le processus de se terminer', async () => {
  // Le minuteur doit être annulé : sinon chaque appel laisserait un setTimeout
  // en vie, et sur une vidéo découpée en douze parties cela s'accumulerait.
  const t0 = Date.now();
  await withTimeout(Promise.resolve(1), 60_000, 'inutile');
  assert.ok(Date.now() - t0 < 1000, 'retour immédiat');
});

/**
 * Régression : la 2e partie et les suivantes échouaient sur
 *
 *   Failed to execute 'decode' on 'VideoDecoder': A key frame is required
 *   after configure() or flush().
 *
 * `turboRenderAll` appelle `vdec.flush()` à la fin de chaque partie pour
 * récupérer les dernières images. Après un flush, WebCodecs exige une image
 * clé, or la partie suivante reprend le flux au milieu d'un groupe d'images.
 */
const cle   = (n) => ({ type: 'key',   timestamp: n, data: `k${n}` });
const inter = (n) => ({ type: 'delta', timestamp: n, data: `d${n}` });

test('en marche normale, rien n\'est rejoué', () => {
  const p = createGopPrimer();
  assert.deepEqual(p.accept(cle(0)), []);
  assert.deepEqual(p.accept(inter(1)), []);
  assert.deepEqual(p.accept(inter(2)), []);
});

test('après un flush, le début du groupe d\'images est rejoué', () => {
  const p = createGopPrimer();
  p.accept(cle(0));
  p.accept(inter(1));
  p.accept(inter(2));

  p.afterFlush();                       // fin d'une partie
  const rejoue = p.accept(inter(3));    // la partie suivante reprend ici

  assert.deepEqual(rejoue.map(c => c.timestamp), [0, 1, 2],
    'la clé et les intermédiaires déjà vus doivent précéder le paquet courant');
  assert.equal(rejoue[0].type, 'key', 'le premier rejoué DOIT être une image clé');
});

test('après un flush, une image clé ne déclenche aucun rejeu', () => {
  const p = createGopPrimer();
  p.accept(cle(0));
  p.accept(inter(1));
  p.afterFlush();
  assert.deepEqual(p.accept(cle(10)), [], 'inutile d\'amorcer : c\'est déjà une clé');
});

test('un seul rejeu par flush, pas à chaque paquet suivant', () => {
  const p = createGopPrimer();
  p.accept(cle(0));
  p.accept(inter(1));
  p.afterFlush();
  assert.equal(p.accept(inter(2)).length, 2, 'amorçage sur le premier paquet');
  assert.deepEqual(p.accept(inter(3)), [], 'puis plus rien');
  assert.deepEqual(p.accept(inter(4)), [], 'toujours rien');
});

test('une image clé purge le tampon : il ne grandit pas indéfiniment', () => {
  const p = createGopPrimer();
  p.accept(cle(0));
  for (let i = 1; i <= 50; i++) p.accept(inter(i));
  assert.equal(p.bufferedCount, 51);
  p.accept(cle(100));
  assert.equal(p.bufferedCount, 1, 'le tampon repart de la nouvelle clé');
});

test('deux flushs successifs amorcent chacun correctement', () => {
  // Une vidéo découpée en douze parties enchaîne autant de flushs.
  const p = createGopPrimer();
  p.accept(cle(0));
  p.accept(inter(1));

  p.afterFlush();
  assert.equal(p.accept(inter(2))[0].type, 'key');

  p.accept(inter(3));
  p.afterFlush();
  const second = p.accept(inter(4));
  assert.equal(second[0].type, 'key', 'le rejeu repart toujours d\'une clé');
  assert.deepEqual(second.map(c => c.timestamp), [0, 1, 2, 3]);
});

/**
 * La contre-pression sondait la file toutes les 8 ms. Sur une video de 10 min
 * a 30 images/s, si la barriere se declenche a chaque image, cela represente
 * pres de deux minutes et demie passees a attendre un minuteur plutot qu'a
 * encoder. `drainTo` se reveille sur l'evenement `dequeue` de WebCodecs.
 */
function fauxCodec(taille, { avecEvenement = true } = {}) {
  const ecouteurs = new Set();
  return {
    encodeQueueSize: taille,
    ondequeue: avecEvenement ? null : undefined,
    addEventListener: avecEvenement ? (_, fn) => ecouteurs.add(fn) : undefined,
    removeEventListener: avecEvenement ? (_, fn) => ecouteurs.delete(fn) : undefined,
    /** Simule le codec qui consomme un element et emet `dequeue`. */
    consommer() {
      this.encodeQueueSize--;
      for (const fn of [...ecouteurs]) fn();
    },
    get nbEcouteurs() { return ecouteurs.size; },
  };
}

test('drainTo rend la main immediatement si la file est deja courte', async () => {
  const c = fauxCodec(2);
  await drainTo(c, 'encodeQueueSize', 6);
  assert.equal(c.nbEcouteurs, 0, 'aucun ecouteur ne doit rester attache');
});

test('drainTo attend l\'evenement dequeue, pas un minuteur', async () => {
  const c = fauxCodec(9);
  let resolu = false;
  const attente = drainTo(c, 'encodeQueueSize', 6).then(() => { resolu = true; });

  await null;
  assert.equal(resolu, false, 'ne doit pas se resoudre tant que la file est pleine');

  c.consommer();                       // 8
  c.consommer();                       // 7
  await null;
  assert.equal(resolu, false, 'toujours au-dessus du plafond');

  c.consommer();                       // 6 -> sous le plafond
  await attente;
  assert.equal(resolu, true);
  assert.equal(c.nbEcouteurs, 0, 'l\'ecouteur doit etre retire');
});

test('drainTo fonctionne sans l\'evenement dequeue (repli par sondage)', async () => {
  const c = fauxCodec(8, { avecEvenement: false });
  const attente = drainTo(c, 'encodeQueueSize', 6);
  setTimeout(() => { c.encodeQueueSize = 3; }, 10);
  await attente;
  assert.ok(c.encodeQueueSize <= 6);
});

/**
 * Regression : rendu turbo a 0,42x sur 1080x2436@56fps, sans le moindre
 * message d'erreur. 56 im/s est presque surement une MOYENNE calculee sur un
 * flux a debit variable (le telephone freine la capture sur une image
 * statique) : le flux reel ne depasse jamais 60, mais demander 56 telle
 * quelle a l'encodeur MATERIEL suffisait a faire rejeter tous les candidats
 * de codec. nearestStdFps() propose une valeur standard proche, que
 * pickVideoConfig() essaie en materiel AVANT d'abandonner au logiciel.
 */
test('nearestStdFps trouve la valeur standard la plus proche', () => {
  assert.equal(nearestStdFps(56), 60, 'cas reel signale : 56 im/s (moyenne VFR) -> 60');
  assert.equal(nearestStdFps(29), 30);
  assert.equal(nearestStdFps(23), 24);
  assert.equal(nearestStdFps(48), 50);
});

test('nearestStdFps renvoie la valeur telle quelle si deja standard', () => {
  for (const f of [24, 25, 30, 50, 60]) assert.equal(nearestStdFps(f), f);
});

test('nearestStdFps garde le premier candidat trouve en cas d\'egalite stricte', () => {
  // 40 est a egale distance de 30 et 50 (10 de chaque cote) : reduce() ne
  // remplace le meilleur trouve que sur une distance STRICTEMENT plus
  // petite, donc 30 (rencontre avant 50 dans STD_FPS) l'emporte.
  assert.equal(nearestStdFps(40), 30);
});

/**
 * Regression : encodage materiel accepte a la CONFIGURATION (1080x2436,
 * `isConfigSupported` repond « supported ») mais qui echoue au RENDU avec
 * « Encoding error » — l'alignement sur 16 exige par la plupart des
 * encodeurs materiels Android n'est pas toujours verifie par
 * isConfigSupported. align16() rogne vers le bas (jamais vers le haut, pour
 * n'inventer aucun contenu de bordure).
 */
test('align16 rogne au multiple de 16 inferieur', () => {
  assert.equal(align16(1080), 1072, 'cas reel signale : largeur 1080 -> 1072');
  assert.equal(align16(2436), 2432, 'cas reel signale : hauteur 2436 -> 2432');
});

test('align16 ne touche pas une dimension deja alignee', () => {
  for (const n of [16, 32, 1920, 1080 + 8]) assert.equal(align16(n), n);
});

test('align16 ne descend jamais sous 16', () => {
  assert.equal(align16(15), 16);
  assert.equal(align16(1), 16);
  assert.equal(align16(0), 16);
});

/**
 * Regression (cas reel signale) : "Multiplexage vidéo : Timestamps must be
 * monotonically increasing (DTS went from 86200037 to 86199454)" — un
 * encodeur materiel Android en profil High (avc1.640033) a laisse ressortir
 * un paquet legerement en retard sur le precedent, malgre
 * `latencyMode: 'realtime'`. mp4-muxer rejette tout DTS decroissant : le
 * moteur turbo s'interrompait net en plein rendu. monotonicVideoChunk() est
 * le filet de securite qui empeche ça d'arriver jusqu'au muxer.
 */
function fakeChunk(type, timestamp, duration, octets = [1, 2, 3]) {
  return new FakeEncodedVideoChunk({ type, timestamp, duration, data: new Uint8Array(octets) });
}

test('monotonicVideoChunk laisse passer un chunk deja croissant, sans le cloner', () => {
  const c = fakeChunk('delta', 1000, 33333);
  assert.equal(monotonicVideoChunk(c, 500), c, 'aucune copie quand ce n\'est pas necessaire');
});

test('cas reel signale : un DTS qui recule est repousse juste apres le precedent', () => {
  const c = fakeChunk('delta', 86_199_454, 33_333);
  const fixe = monotonicVideoChunk(c, 86_200_037);
  assert.equal(fixe.timestamp, 86_200_038, 'strictement croissant, decalage minimal');
  assert.notEqual(fixe, c, 'le chunk original ne peut pas etre modifie : il faut un clone');
});

test('un DTS EGAL au precedent est aussi repousse (strictement croissant, pas juste non decroissant)', () => {
  const c = fakeChunk('delta', 5000, 1000);
  const fixe = monotonicVideoChunk(c, 5000);
  assert.equal(fixe.timestamp, 5001);
});

test('le clone garde le type, la duree et les octets du chunk original', () => {
  const c = fakeChunk('key', 100, 33333, [9, 8, 7, 6]);
  const fixe = monotonicVideoChunk(c, 200);
  assert.equal(fixe.type, 'key');
  assert.equal(fixe.duration, 33333);
  const octets = new Uint8Array(fixe.byteLength);
  fixe.copyTo(octets);
  assert.deepEqual(Array.from(octets), [9, 8, 7, 6]);
});

test('une duree absente (null) n\'est pas forcee a 0 sur le clone', () => {
  const c = fakeChunk('delta', 100, null);
  const fixe = monotonicVideoChunk(c, 200);
  assert.equal(fixe.duration, null);
});

test('des DTS repousses restent croissants sur plusieurs paquets consecutifs', () => {
  // Reproduit la boucle de turbo-render.js : chaque sortie est comparee au
  // DERNIER horodatage deja remis au muxer, pas au chunk original.
  let last = -Infinity;
  const horodatages = [0, 33333, 33200, 33100, 99999]; // deux reculs de suite
  const sortie = horodatages.map(ts => {
    const fixe = monotonicVideoChunk(fakeChunk('delta', ts, 33333), last);
    last = fixe.timestamp;
    return fixe.timestamp;
  });
  for (let i = 1; i < sortie.length; i++) {
    assert.ok(sortie[i] > sortie[i - 1], `doit croître : ${sortie[i - 1]} -> ${sortie[i]}`);
  }
  assert.deepEqual(sortie, [0, 33333, 33334, 33335, 99999]);
});
