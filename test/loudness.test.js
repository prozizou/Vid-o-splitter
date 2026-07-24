import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureLufs, limiter, normalizeTo } from '../loudness.js';

const SR = 48000;
const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

/** Sinusoïde de niveau RMS `dbfs`, en `sec` secondes. */
function sine(dbfs, sec, freq = 1000, sr = SR) {
  const n = Math.round(sec * sr);
  const amp = Math.pow(10, dbfs / 20) * Math.SQRT2;   // RMS -> amplitude crête
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * i / sr);
  return x;
}

function silence(sec, sr = SR) {
  return new Float32Array(Math.round(sec * sr));
}

function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// --- Étalonnage BS.1770 ----------------------------------------------------
// La constante -0,691 de la norme est choisie pour annuler EXACTEMENT le gain
// de la pondération K à 1 kHz. Conséquence vérifiable : un canal unique portant
// un sinus de 1 kHz à X dBFS RMS doit se mesurer à X LUFS. Ce test échoue si
// les coefficients du filtre OU la constante sont faux — les deux erreurs les
// plus probables dans une implémentation de BS.1770.

test('étalonnage : sinus mono 1 kHz à -23 dBFS = -23 LUFS', () => {
  near(measureLufs([sine(-23, 10)], SR), -23, 0.1, 'sonie intégrée');
});

test('étalonnage : sinus mono 1 kHz à -33 dBFS = -33 LUFS', () => {
  near(measureLufs([sine(-33, 10)], SR), -33, 0.1, 'sonie intégrée');
});

test('la sommation des canaux ajoute 3,01 dB (G = 1,0 par canal)', () => {
  // Deux canaux identiques : z_L + z_R = 2z, soit +3,01 dB. C'est la règle de
  // la norme (tableau 3), et non un bug — un même signal en stéréo se mesure
  // bien 3 dB au-dessus du même signal en mono.
  const x = sine(-23, 10);
  const mono = measureLufs([x], SR);
  const stereo = measureLufs([x, Float32Array.from(x)], SR);
  near(stereo - mono, 3.01, 0.05, 'écart mono/stéréo');
});

test('la mesure suit l\'amplitude : moitié du signal = -6,02 dB', () => {
  const x = sine(-23, 6);
  const moitie = Float32Array.from(x, v => v / 2);
  near(measureLufs([x], SR) - measureLufs([moitie], SR), 6.02, 0.05, 'écart');
});

// --- Les portes : la vraie raison de remplacer le RMS ----------------------

test('les silences ne tirent pas la mesure vers le bas', () => {
  // Une voix parlée est pleine de silences. Un RMS les compte et sous-estime
  // la sonie ; les portes EBU les écartent. C'est exactement le défaut de
  // l'ancienne implémentation.
  const parole = sine(-20, 3);
  const avec = concat(parole, silence(3), parole, silence(3));
  const sans = concat(parole, parole);

  const lAvec = measureLufs([avec, Float32Array.from(avec)], SR);
  const lSans = measureLufs([sans, Float32Array.from(sans)], SR);
  // Le résidu vient des blocs de 400 ms à cheval sur les transitions ; il est
  // sans commune mesure avec l'effondrement du RMS mesuré juste après.
  near(lAvec, lSans, 0.5, 'la sonie ne doit quasiment pas bouger');

  // Pour comparaison : le RMS brut, lui, s'effondre de ~3 dB.
  const rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  const ecartRms = 20 * Math.log10(rms(avec) / rms(sans));
  assert.ok(ecartRms < -2.5, `le RMS chute bien de ${ecartRms.toFixed(1)} dB, lui`);
});

test('un signal entièrement muet n\'est pas mesurable', () => {
  assert.equal(measureLufs([silence(5)], SR), -Infinity);
});

test('un extrait plus court que 400 ms n\'est pas mesurable', () => {
  assert.equal(measureLufs([sine(-23, 0.2)], SR), -Infinity);
});

test('la mesure est indépendante de la fréquence d\'échantillonnage', () => {
  const a = measureLufs([sine(-23, 5, 1000, 44100)], 44100);
  const b = measureLufs([sine(-23, 5, 1000, 48000)], 48000);
  near(a, b, 0.1, 'même sonie à 44,1 et 48 kHz');
});

// --- Limiteur --------------------------------------------------------------

test('le limiteur ramène les crêtes sous le plafond', () => {
  const x = sine(-6, 2);                       // crêtes à ~0,71
  x[SR] = 1.5;                                 // une crête isolée bien au-dessus
  const ch = [x];
  const reduction = limiter(ch, 0.891, SR);

  let peak = 0;
  for (const v of ch[0]) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 0.892, `crête ${peak} doit rester sous le plafond`);
  assert.ok(reduction < 0, 'une réduction doit être signalée');
});

test('le limiteur ne touche pas un signal déjà sous le plafond', () => {
  const x = sine(-20, 1);
  const avant = Float32Array.from(x);
  const reduction = limiter([x], 0.891, SR);
  assert.equal(reduction, 0, 'aucune réduction');
  assert.deepEqual(Array.from(x), Array.from(avant), 'signal inchangé');
});

test('le limiteur anticipe : la crête est déjà atténuée quand elle arrive', () => {
  // La réduction doit commencer AVANT l'échantillon fautif, sinon elle
  // s'entend comme un claquement.
  const x = new Float32Array(SR);
  x.fill(0.8);
  x[SR / 2] = 4.0;
  const ch = [x];
  limiter(ch, 0.891, SR);
  const justeAvant = ch[0][SR / 2 - 100];
  assert.ok(Math.abs(justeAvant) < 0.8, 'le gain doit déjà être réduit 100 échantillons avant');
});

// --- Normalisation de bout en bout -----------------------------------------

test('normalizeTo atteint la cible quand aucun limitage n\'est requis', () => {
  const x = sine(-30, 6);
  const ch = [x, Float32Array.from(x)];
  const avant = measureLufs(ch, SR);
  const { applied, lufs, reduction } = normalizeTo(ch, SR, -16);

  near(lufs, avant, 1e-6, 'la sonie rapportée est celle mesurée avant');
  near(applied, -16 - avant, 0.05, 'gain appliqué = écart à la cible');
  assert.equal(reduction, 0, 'pas de limitage nécessaire');
  near(measureLufs(ch, SR), -16, 0.1, 'sonie après normalisation');
});

test('normalizeTo : une crête isolée ne bride plus tout le fichier', () => {
  // C'était le défaut de l'ancien « limiteur » : il plafonnait le gain global,
  // donc un seul transitoire empêchait d'atteindre la cible partout.
  const x = sine(-30, 6);
  x[SR * 3] = 0.9;                              // un clic isolé, proche du plein niveau
  const ch = [x, Float32Array.from(x)];
  normalizeTo(ch, SR, -16);

  const apres = measureLufs(ch, SR);
  assert.ok(apres > -17.5, `sonie atteinte ${apres.toFixed(1)} LUFS, cible -16`);
  let peak = 0;
  for (const v of ch[0]) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 0.892, `crête finale ${peak} sous -1 dBFS`);
});

test('normalizeTo ne fait rien sur un signal non mesurable', () => {
  const ch = [silence(2)];
  const { applied, reduction } = normalizeTo(ch, SR, -16);
  assert.equal(applied, 0);
  assert.equal(reduction, 0);
});
