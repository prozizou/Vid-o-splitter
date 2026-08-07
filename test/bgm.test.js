import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BGM_TYPES, renderBgm, mixBg, makeBgWav } from '../bgm.js';

const SR = 48000;
const peakOf = a => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

test('chaque son de fond est rendu et normalisé à 1,0', () => {
  for (const type of Object.keys(BGM_TYPES)) {
    const s = renderBgm(type, SR, SR * 2);
    if (type === 'none') { assert.equal(s.length, 0); continue; }
    assert.ok(s.length > 0, `${type} doit produire des échantillons`);
    assert.ok(Math.abs(peakOf(s) - 1) < 1e-5, `${type} : crête ${peakOf(s)} attendue à 1,0`);
    assert.ok(s.every(Number.isFinite), `${type} ne doit contenir aucun NaN`);
  }
});

test('le rendu est déterministe : deux passages donnent le même son', () => {
  // Générateur de bruit à graine fixe, pas Math.random : relancer un
  // traitement doit produire un fichier identique au bit près.
  for (const type of ['rose', 'rain', 'drone', 'waves']) {
    const a = renderBgm(type, SR, SR), b = renderBgm(type, SR, SR);
    assert.deepEqual(Array.from(a), Array.from(b), `${type} n'est pas déterministe`);
  }
});

test('un son de fond couvre TOUTE la durée demandée, sans boucle courte', () => {
  // Le calcul est fait d'un bout à l'autre : une texture de plusieurs
  // minutes ne doit jamais se répéter en boucle courte, contrairement à un
  // son de transition (bref, placé à un instant précis).
  for (const type of ['rose', 'rain', 'drone', 'waves']) {
    const n = SR * 5;
    const s = renderBgm(type, SR, n);
    assert.equal(s.length, n, `${type} doit couvrir exactement ${n} échantillons`);
  }
});

test('les extrémités sont fondues : aucun clic ajouté par le son lui-même', () => {
  for (const type of ['rose', 'rain', 'drone', 'waves']) {
    const s = renderBgm(type, SR, SR);
    assert.equal(Math.abs(s[0]), 0, `${type} : le premier échantillon doit être nul`);
    assert.equal(Math.abs(s[s.length - 1]), 0, `${type} : le dernier échantillon doit être nul`);
  }
});

test('un type inconnu ou une durée nulle ne casse rien', () => {
  assert.equal(renderBgm('nimportequoi', SR, SR).length, 0);
  assert.equal(renderBgm(null, SR, SR).length, 0);
  assert.equal(renderBgm('rose', SR, 0).length, 0);
});

// --- Mixage dans le PCM ----------------------------------------------------

test('mixBg respecte le volume demandé et ne sature jamais', () => {
  const ch = [new Float32Array(SR)];
  mixBg(ch, SR, 'drone', -18);
  const attendu = Math.pow(10, -18 / 20);
  assert.ok(Math.abs(peakOf(ch[0]) - attendu) < 1e-3,
    `crête ${peakOf(ch[0])} attendue à ${attendu}`);
  assert.ok(ch[0].every(v => v >= -1 && v <= 1), 'jamais hors de [-1, 1]');
});

test('mixBg écrête proprement au lieu de déborder', () => {
  const ch = [new Float32Array(SR).fill(0.95)];
  mixBg(ch, SR, 'drone', 0);
  assert.ok(ch[0].every(v => v >= -1 && v <= 1), 'écrêtage à [-1, 1]');
});

test('mixBg applique le MÊME son mono à tous les canaux', () => {
  const ch = [new Float32Array(SR), new Float32Array(SR)];
  mixBg(ch, SR, 'rose', -12);
  assert.deepEqual(Array.from(ch[0]), Array.from(ch[1]));
});

test('mixBg ne fait rien sans type ni sur des canaux vides', () => {
  const vide = new Float32Array(1000);
  mixBg([vide], SR, 'none', -18);
  assert.equal(peakOf(vide), 0);
  mixBg([vide], SR, null, -18);
  assert.equal(peakOf(vide), 0);
  mixBg([], SR, 'rose', -18);   // aucun canal : ne doit pas planter
  mixBg([new Float32Array(0)], SR, 'rose', -18);
});

// --- En-tête WAV -----------------------------------------------------------

test('makeBgWav produit un WAV mono 16 bits valide', async () => {
  const sec = 2;
  const blob = makeBgWav(sec, SR, 'rain', -18);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const v = new DataView(buf.buffer);
  const txt = (o, n) => String.fromCharCode(...buf.slice(o, o + n));

  assert.equal(txt(0, 4), 'RIFF');
  assert.equal(txt(8, 4), 'WAVE');
  assert.equal(txt(12, 4), 'fmt ');
  assert.equal(v.getUint32(16, true), 16, 'taille du bloc fmt');
  assert.equal(v.getUint16(20, true), 1, 'PCM non compressé');
  assert.equal(v.getUint16(22, true), 1, 'mono');
  assert.equal(v.getUint32(24, true), SR, 'fréquence d\'échantillonnage');
  assert.equal(v.getUint16(34, true), 16, '16 bits');
  assert.equal(txt(36, 4), 'data');

  const n = SR * sec;
  assert.equal(v.getUint32(40, true), n * 2, 'taille des données');
  assert.equal(v.getUint32(4, true), buf.length - 8, 'taille RIFF');
  assert.equal(buf.length, 44 + n * 2, 'taille totale du fichier');
});

test('makeBgWav couvre toute la durée, contrairement à un lit de transitions', () => {
  // L'ancien "lit sonore" des transitions était silencieux sauf aux
  // raccords. Un son de fond, lui, doit occuper le fichier en entier.
  const blob = makeBgWav(1, SR, 'drone', -6);
  return blob.arrayBuffer().then(ab => {
    const v = new DataView(ab);
    let nonNul = 0;
    for (let i = 0; i < SR; i += 37) if (v.getInt16(44 + i * 2, true) !== 0) nonNul++;
    assert.ok(nonNul > 0, 'le fichier ne doit pas être silencieux');
  });
});
