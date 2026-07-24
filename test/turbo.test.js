import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotSample } from '../turbo.js';

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
