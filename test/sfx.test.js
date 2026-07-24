import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SFX_TYPES, renderSfx, mixBed, makeBedWav, alphaAt } from '../sfx.js';

const SR = 48000;
const peakOf = a => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

test('chaque son de transition est rendu et normalisé à 1,0', () => {
  for (const type of Object.keys(SFX_TYPES)) {
    const s = renderSfx(type, SR);
    if (type === 'none') { assert.equal(s.length, 0); continue; }
    assert.ok(s.length > 0, `${type} doit produire des échantillons`);
    assert.ok(Math.abs(peakOf(s) - 1) < 1e-5, `${type} : crête ${peakOf(s)} attendue à 1,0`);
    assert.ok(s.every(Number.isFinite), `${type} ne doit contenir aucun NaN`);
  }
});

test('le rendu est déterministe : deux passages donnent le même son', () => {
  // Le générateur de bruit est un xorshift à graine fixe, pas Math.random :
  // relancer un traitement doit produire un fichier identique au bit près.
  for (const type of ['click', 'breath', 'whoosh', 'tick']) {
    const a = renderSfx(type, SR), b = renderSfx(type, SR);
    assert.deepEqual(Array.from(a), Array.from(b), `${type} n'est pas déterministe`);
  }
});

test('les extrémités sont fondues : aucun clic ajouté par le son lui-même', () => {
  for (const type of ['click', 'breath', 'whoosh', 'tick']) {
    const s = renderSfx(type, SR);
    // Math.abs : la valeur peut être -0, que l'égalité stricte distingue de 0.
    assert.equal(Math.abs(s[0]), 0, `${type} : le premier échantillon doit être nul`);
    assert.equal(Math.abs(s[s.length - 1]), 0, `${type} : le dernier échantillon doit être nul`);
  }
});

test('un type inconnu ne casse rien', () => {
  assert.equal(renderSfx('nimportequoi', SR).length, 0);
  assert.equal(renderSfx(null, SR).length, 0);
});

// --- Mixage dans le PCM ----------------------------------------------------

test('mixBed respecte le volume demandé et ne sature jamais', () => {
  const ch = [new Float32Array(SR)];
  mixBed(ch, SR, [0.5], 'click', -18);
  const attendu = Math.pow(10, -18 / 20);
  assert.ok(Math.abs(peakOf(ch[0]) - attendu) < 1e-3,
    `crête ${peakOf(ch[0])} attendue à ${attendu}`);
  assert.ok(ch[0].every(v => v >= -1 && v <= 1), 'jamais hors de [-1, 1]');
});

test('mixBed écrête proprement au lieu de déborder', () => {
  const ch = [new Float32Array(SR).fill(0.95)];
  mixBed(ch, SR, [0.5], 'click', 0);
  assert.ok(ch[0].every(v => v >= -1 && v <= 1), 'écrêtage à [-1, 1]');
});

test('mixBed place le son AVANT le raccord', () => {
  // Le son doit annoncer la coupe, pas la suivre : il démarre 30 % avant.
  const ch = [new Float32Array(SR * 2)];
  const pos = 1.0;
  mixBed(ch, SR, [pos], 'click', -6);
  let premier = -1;
  for (let i = 0; i < ch[0].length; i++) if (ch[0][i] !== 0) { premier = i; break; }
  assert.ok(premier >= 0 && premier < pos * SR, `démarre à ${premier}, avant ${pos * SR}`);
});

test('mixBed ne fait rien sans point de raccord ni sans type', () => {
  const vide = new Float32Array(1000);
  mixBed([vide], SR, [], 'click', -18);
  assert.equal(peakOf(vide), 0);
  mixBed([vide], SR, [0.5], 'none', -18);
  assert.equal(peakOf(vide), 0);
});

test('mixBed ignore les raccords hors des bornes du tampon', () => {
  const ch = [new Float32Array(1000)];
  mixBed(ch, SR, [-5, 100], 'click', -6);   // avant le début, après la fin
  assert.ok(ch[0].every(Number.isFinite), 'aucun débordement');
});

// --- En-tête WAV -----------------------------------------------------------

test('makeBedWav produit un WAV mono 16 bits valide', async () => {
  const sec = 2;
  const blob = makeBedWav(sec, SR, [1.0], 'click', -18);
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

test('makeBedWav reste silencieux là où il n\'y a pas de raccord', async () => {
  const blob = makeBedWav(2, SR, [1.5], 'click', -18);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const v = new DataView(buf.buffer);
  // Le début du fichier (loin du raccord à 1,5 s) doit être strictement muet.
  for (let i = 0; i < SR; i += 97) assert.equal(v.getInt16(44 + i * 2, true), 0);
});

// --- Fondu au noir ---------------------------------------------------------

test('alphaAt : opaque loin des raccords, noir sur le raccord', () => {
  const pts = [1000, 5000];
  assert.equal(alphaAt(3000, pts, 100), 1, 'loin de tout raccord');
  assert.equal(alphaAt(1000, pts, 100), 0, 'sur le raccord : noir complet');
  assert.equal(alphaAt(1050, pts, 100), 0.5, 'à mi-fondu');
  assert.equal(alphaAt(950, pts, 100), 0.5, 'symétrique avant le raccord');
});

test('alphaAt : sans fondu ni raccord, l\'image est intacte', () => {
  assert.equal(alphaAt(1000, [1000], 0), 1);
  assert.equal(alphaAt(1000, [], 100), 1);
});

test('alphaAt reste dans [0, 1]', () => {
  const pts = [500, 700, 3000];
  for (let t = 0; t < 4000; t += 13) {
    const a = alphaAt(t, pts, 250);
    assert.ok(a >= 0 && a <= 1, `alpha ${a} hors bornes à t=${t}`);
  }
});
