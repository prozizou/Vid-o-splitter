import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotSample, resolveDataStream, withTimeout, createGopPrimer } from '../turbo.js';

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
