import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  segmentsFromLoud, thresholdCurve, planChunks, loudFromPCM, DEFAULTS,
} from '../silence.js';

const WIN = DEFAULTS.windowSec;   // 0,03 s

/** Enveloppe synthétique : suite de [niveau, durée en secondes]. */
function envelope(spans) {
  const out = [];
  for (const [level, sec] of spans) {
    const n = Math.round(sec / WIN);
    for (let i = 0; i < n; i++) out.push(level);
  }
  return { loud: Float32Array.from(out), duration: out.length * WIN };
}

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('parole -> silence -> parole donne deux segments', () => {
  const { loud, duration } = envelope([[0.2, 2], [0.0005, 2], [0.2, 2]]);
  const { segments } = segmentsFromLoud(loud, WIN, duration);
  assert.equal(segments.length, 2);
  near(segments[0][0], 0, 0.15, 'début du 1er segment');
  near(segments[1][1], duration, 0.15, 'fin du 2e segment');
});

test('un silence plus court que minSilenceDur ne coupe pas', () => {
  const { loud, duration } = envelope([[0.2, 2], [0.0005, 0.2], [0.2, 2]]);
  const { segments } = segmentsFromLoud(loud, WIN, duration, { minSilenceDur: 0.4 });
  assert.equal(segments.length, 1, 'un trou de 0,2 s doit être conservé');
});

test('la marge (padding) élargit les segments sans les faire déborder', () => {
  const { loud, duration } = envelope([[0.0005, 2], [0.2, 2], [0.0005, 2]]);
  const a = segmentsFromLoud(loud, WIN, duration, { padding: 0 }).segments[0];
  const b = segmentsFromLoud(loud, WIN, duration, { padding: 0.2 }).segments[0];
  assert.ok(b[0] < a[0] && b[1] > a[1], 'le segment doit s\'élargir');
  assert.ok(b[0] >= 0 && b[1] <= duration, 'jamais hors des bornes du fichier');
});

test('une entrée entièrement silencieuse renvoie le fichier entier', () => {
  const { loud, duration } = envelope([[0.0001, 5]]);
  const { segments } = segmentsFromLoud(loud, WIN, duration);
  assert.deepEqual(segments, [[0, duration]]);
});

test('kept est bien la somme des segments conservés', () => {
  const { loud, duration } = envelope([[0.2, 2], [0.0005, 2], [0.2, 2]]);
  const { segments, kept } = segmentsFromLoud(loud, WIN, duration);
  const sum = segments.reduce((a, [s, e]) => a + (e - s), 0);
  near(kept, sum, 1e-9, 'kept');
  assert.ok(kept < duration, 'du silence doit avoir été retiré');
});

test('une sensibilité plus haute conserve au moins autant de matière', () => {
  const { loud, duration } = envelope([[0.2, 1], [0.01, 1], [0.2, 1]]);
  const bas = segmentsFromLoud(loud, WIN, duration, { sensitivity: 0.6 }).kept;
  const haut = segmentsFromLoud(loud, WIN, duration, { sensitivity: 2.0 }).kept;
  assert.ok(haut >= bas, `sensibilité 2,0 (${haut}) >= 0,6 (${bas})`);
});

// --- Le seuil adaptatif : c'est la régression que ces tests protègent -------

test('le seuil suit un bruit de fond qui change en cours de route', () => {
  // Première moitié calme, seconde moitié avec un bruit de fond 60× plus fort
  // (fenêtre ouverte, changement de pièce). Aucun seuil global unique ne peut
  // convenir aux deux : c'est exactement la régression que ce test protège.
  const { loud, duration } = envelope([
    [0.3, 4], [0.0005, 4],      // parole forte / silence très calme
    [0.3, 4], [0.03, 4],        // parole forte / « silence » bruyant
  ]);
  const { segments } = segmentsFromLoud(loud, WIN, duration);
  const thr = thresholdCurve(loud, WIN);

  assert.ok(thr[thr.length - 1] >= thr[0] * 2,
    `seuil final ${thr[thr.length - 1]} vs initial ${thr[0]} : doit monter avec le bruit`);
  assert.equal(segments.length, 2, 'les deux passages parlés, et eux seuls');

  // Le « silence bruyant » (13 s à 15 s) ne doit être dans aucun segment : avec
  // un seuil global il passait au-dessus et n'était donc jamais coupé.
  const dansUnSegment = t => segments.some(([s, e]) => t >= s && t <= e);
  assert.ok(!dansUnSegment(14), 'le silence bruyant doit être supprimé');
});

test('l\'hystérésis évite le papillonnement autour du seuil', () => {
  // Signal oscillant juste autour du seuil : sans hystérésis, chaque
  // oscillation créait un segment.
  // Le seuil calculé ici vaut ~0,03 (p90 = 0,5 -> 0,5 × 0,06). On fait osciller
  // le signal juste au-dessus et juste en dessous, avec des creux PLUS LONGS
  // que minSilenceDur : sans hystérésis, chaque creux produisait une coupe.
  const spans = [[0.5, 2], [0.001, 2]];
  for (let i = 0; i < 20; i++) spans.push([i % 2 ? 0.033 : 0.028, 0.5]);
  const { loud, duration } = envelope(spans);
  const { segments } = segmentsFromLoud(loud, WIN, duration, { minSilenceDur: 0.4 });
  assert.ok(segments.length <= 3, `attendu peu de segments, obtenu ${segments.length}`);
});

test('thresholdCurve renvoie une valeur par fenêtre et respecte le plancher', () => {
  const { loud } = envelope([[0.2, 3], [0.0001, 3]]);
  const thr = thresholdCurve(loud, WIN, { absFloor: 0.004 });
  assert.equal(thr.length, loud.length);
  for (const t of thr) assert.ok(t >= 0.004, 'jamais sous absFloor');
});

// --- Découpage en parties --------------------------------------------------

test('planChunks : une seule partie en mode off', () => {
  const segs = Array.from({ length: 50 }, (_, i) => [i * 10, i * 10 + 5]);
  const parts = planChunks(segs, 500, { chunkMode: 'off' });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].segs.length, 50);
});

test('planChunks : les frontières tombent entre deux segments', () => {
  const segs = Array.from({ length: 30 }, (_, i) => [i * 10, i * 10 + 5]);
  const parts = planChunks(segs, 300, { chunkMode: '60' });
  assert.ok(parts.length > 1);
  const plat = parts.flatMap(p => p.segs);
  assert.deepEqual(plat, segs, 'aucun segment perdu, dupliqué ni scindé');
  for (const p of parts) {
    assert.equal(p.t0, p.segs[0][0]);
    assert.equal(p.t1, p.segs[p.segs.length - 1][1]);
  }
});

test('planChunks : maxSegPerChunk est respecté', () => {
  const segs = Array.from({ length: 100 }, (_, i) => [i, i + 0.5]);
  const parts = planChunks(segs, 100, { chunkMode: 'off', maxSegPerChunk: 40 });
  // chunkMode 'off' ignore le découpage : une seule partie.
  assert.equal(parts.length, 1);
  const limite = planChunks(segs, 100, { chunkMode: '3600', maxSegPerChunk: 40 });
  for (const p of limite) assert.ok(p.segs.length <= 40, `${p.segs.length} > 40`);
});

test('planChunks : mode auto ne découpe pas les vidéos courtes', () => {
  const segs = [[0, 10], [20, 30]];
  assert.equal(planChunks(segs, 100, { chunkMode: 'auto', autoAbove: 300 }).length, 1);
  const longues = Array.from({ length: 60 }, (_, i) => [i * 10, i * 10 + 8]);
  assert.ok(planChunks(longues, 600, { chunkMode: 'auto', autoAbove: 300, autoSec: 240 }).length > 1);
});

test('planChunks : kept est cohérent avec les segments', () => {
  const segs = [[0, 5], [10, 20], [30, 33]];
  const [p] = planChunks(segs, 40, { chunkMode: 'off' });
  near(p.kept, 5 + 10 + 3, 1e-9, 'kept');
});

// --- Enveloppe RMS ---------------------------------------------------------

test('loudFromPCM mesure le bon RMS sur une sinusoïde', () => {
  const sr = 8000, n = sr * 2;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(0.5 * 32767 * Math.sin(2 * Math.PI * 440 * i / sr));
  const { loud, winSec, duration } = loudFromPCM(pcm, sr);
  near(duration, 2, 1e-6, 'durée');
  near(winSec, 0.03, 0.001, 'taille de fenêtre');
  const moyen = loud.reduce((a, b) => a + b, 0) / loud.length;
  near(moyen, 0.5 / Math.SQRT2, 0.01, 'RMS d\'une sinusoïde d\'amplitude 0,5');
});
