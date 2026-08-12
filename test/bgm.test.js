import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BGM_TYPES, renderBgm, mixBg, makeBgWav, loopToLength, resampleLinear, mixInto, pcmMonoToWavBlob } from '../bgm.js';

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

// --- Bouclage en fondu-enchaîné (loopToLength) ------------------------------
// Utilisé par bgm-audio.js pour étirer un enregistrement (durée fixe) sur
// toute la durée d'une partie, sans le clic qu'un bouclage brut produirait.

test('loopToLength renvoie exactement n échantillons, plus court ou plus long que la source', () => {
  const src = new Float32Array(1000).map((_, i) => Math.sin(i));
  assert.equal(loopToLength(src, SR, 300).length, 300);   // plus court : simple découpe
  assert.equal(loopToLength(src, SR, 1000).length, 1000);  // pile la longueur de la source
  assert.equal(loopToLength(src, SR, 5000).length, 5000);  // plus long : bouclé
});

test('loopToLength : cas limites sans planter', () => {
  assert.equal(loopToLength(new Float32Array(0), SR, 1000).length, 1000); // source vide -> silence
  assert.equal(loopToLength(new Float32Array(10), SR, 0).length, 0);
  assert.equal(loopToLength(new Float32Array(10), SR, -1).length, 0);
});

test('loopToLength ne dépasse jamais [-1, 1] au raccord de boucle', () => {
  // Deux crêtes à +1/-1 juste avant/après le raccord : le fondu-enchaîné
  // (mélange pondéré, jamais une addition) ne doit produire aucun dépassement.
  const src = new Float32Array(2000).fill(1);
  const out = loopToLength(src, SR, 6000);
  assert.ok(out.every(v => v >= -1.0001 && v <= 1.0001), 'jamais hors de [-1, 1]');
});

test('loopToLength reproduit la source telle quelle quand n est plus court', () => {
  const src = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
  assert.deepEqual(Array.from(loopToLength(src, SR, 3)), Array.from(src.subarray(0, 3)));
});

// --- Ré-échantillonnage (resampleLinear) ------------------------------------

test('resampleLinear ne touche pas au signal si la fréquence ne change pas', () => {
  const src = new Float32Array([0.1, -0.2, 0.3]);
  assert.equal(resampleLinear(src, 44100, 44100), src); // même référence : pas de copie inutile
});

test('resampleLinear change la longueur proportionnellement au ratio de fréquences', () => {
  const src = new Float32Array(4410); // 0,1 s à 44100 Hz
  const out = resampleLinear(src, 44100, 22050);
  assert.ok(Math.abs(out.length - 2205) <= 1, `longueur ${out.length} attendue proche de 2205`);
});

test('resampleLinear conserve une rampe simple (interpolation correcte)', () => {
  const src = new Float32Array(11).map((_, i) => i / 10); // rampe 0 -> 1
  const out = resampleLinear(src, 10, 20);
  assert.ok(Math.abs(out[0] - 0) < 1e-6);
  assert.ok(Math.abs(out[out.length - 1] - 1) < 1e-6);
  for (let i = 1; i < out.length; i++) assert.ok(out[i] >= out[i - 1] - 1e-9, 'la rampe doit rester croissante');
});

// --- Briques partagées (mixInto, pcmMonoToWavBlob) --------------------------
// Utilisées à la fois par mixBg/makeBgWav (ci-dessus) et par bgm-audio.js
// (mixBgAudio/makeBgAudioWav) : testées ici une fois pour les deux usages.

test('mixInto respecte le gain et écrête sans jamais dépasser [-1, 1]', () => {
  const ch = [new Float32Array(SR).fill(0)];
  mixInto(ch, new Float32Array(SR).fill(1), -6);
  const attendu = Math.pow(10, -6 / 20);
  assert.ok(Math.abs(ch[0][0] - attendu) < 1e-6);
  const ch2 = [new Float32Array(SR).fill(0.9)];
  mixInto(ch2, new Float32Array(SR).fill(0.9), 0);
  assert.ok(ch2[0].every(v => v <= 1), 'écrêtage à 1');
});

test('pcmMonoToWavBlob produit un en-tête WAV valide', async () => {
  const n = SR;
  const s = new Float32Array(n);
  const blob = pcmMonoToWavBlob(s, SR);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const txt = (o, len) => String.fromCharCode(...buf.slice(o, o + len));
  assert.equal(txt(0, 4), 'RIFF');
  assert.equal(txt(8, 4), 'WAVE');
  assert.equal(buf.length, 44 + n * 2);
});
