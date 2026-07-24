/* =============================================================================
   LOUDNESS.JS — mesure de sonie (ITU-R BS.1770-4 / EBU R128) et limiteur.

   Fonctions PURES : elles travaillent sur des Float32Array, pas sur des
   AudioBuffer, ce qui les rend testables en Node (`npm test`).

   Ce qui remplace quoi :
   - l'ancienne « approximation LUFS » était un RMS sous-échantillonné. Sur une
     voix parlée — donc pleine de silences, qui tirent le RMS vers le bas sans
     rien changer à la sonie perçue — l'écart au vrai LUFS atteignait plusieurs
     décibels. Ici : pondération K, blocs de 400 ms à 75 % de recouvrement,
     porte absolue à -70 LUFS puis porte relative à -10 LU, comme la norme.
   - l'ancien « limiteur de crête » plafonnait le gain global : une seule crête
     isolée empêchait d'atteindre la cible sur TOUT le fichier. Ici, la
     réduction n'intervient qu'autour des crêtes.
   ========================================================================== */

/** Pondération K : filtre en plateau aigu, puis passe-haut (BS.1770-4). */
export function kWeightingCoeffs(fs) {
  // Étage 1 : plateau haut (+4 dB au-dessus de ~1,7 kHz)
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q1 = 0.7071752369554196;
  const K1 = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const den1 = 1 + K1 / Q1 + K1 * K1;
  const s1 = {
    b0: (Vh + Vb * K1 / Q1 + K1 * K1) / den1,
    b1: 2 * (K1 * K1 - Vh) / den1,
    b2: (Vh - Vb * K1 / Q1 + K1 * K1) / den1,
    a1: 2 * (K1 * K1 - 1) / den1,
    a2: (1 - K1 / Q1 + K1 * K1) / den1,
  };
  // Étage 2 : passe-haut RLB à ~38 Hz
  const f1 = 38.13547087602444;
  const Q2 = 0.5003270373238773;
  const K2 = Math.tan(Math.PI * f1 / fs);
  const den2 = 1 + K2 / Q2 + K2 * K2;
  const s2 = {
    b0: 1, b1: -2, b2: 1,
    a1: 2 * (K2 * K2 - 1) / den2,
    a2: (1 - K2 / Q2 + K2 * K2) / den2,
  };
  return [s1, s2];
}

/**
 * Sonie intégrée, en LUFS.
 * Le signal filtré n'est jamais stocké : on accumule les sommes de carrés par
 * sous-blocs de 100 ms, et un bloc de 400 ms est la somme de 4 sous-blocs.
 * @param channels [Float32Array, ...]
 * @returns LUFS, ou -Infinity si l'extrait est trop court / entièrement muet.
 */
export function measureLufs(channels, fs) {
  const nCh = channels.length;
  if (!nCh) return -Infinity;
  const n = channels[0].length;
  const [s1, s2] = kWeightingCoeffs(fs);

  const subLen = Math.max(1, Math.round(0.1 * fs));      // pas de 100 ms
  const nSub = Math.floor(n / subLen);
  if (nSub < 4) return -Infinity;                        // moins de 400 ms : non mesurable

  const subSum = Array.from({ length: nCh }, () => new Float64Array(nSub));

  for (let c = 0; c < nCh; c++) {
    const d = channels[c];
    const acc = subSum[c];
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;     // état étage 1
    let u1 = 0, u2 = 0, v1 = 0, v2 = 0;     // état étage 2
    for (let k = 0; k < nSub; k++) {
      let sum = 0;
      const from = k * subLen, to = from + subLen;
      for (let i = from; i < to; i++) {
        const x = d[i];
        const y = s1.b0 * x + s1.b1 * x1 + s1.b2 * x2 - s1.a1 * y1 - s1.a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        const v = s2.b0 * y + s2.b1 * u1 + s2.b2 * u2 - s2.a1 * v1 - s2.a2 * v2;
        u2 = u1; u1 = y; v2 = v1; v1 = v;
        sum += v * v;
      }
      acc[k] = sum;
    }
  }

  // Sonie de chaque bloc de 400 ms (4 sous-blocs), recouvrement 75 %.
  const nBlocks = nSub - 3;
  const blocks = new Float64Array(nBlocks);
  const span = 4 * subLen;
  for (let j = 0; j < nBlocks; j++) {
    let z = 0;
    for (let c = 0; c < nCh; c++) {
      // Gain de canal G = 1,0 pour gauche/droite et mono (BS.1770 tableau 3).
      z += (subSum[c][j] + subSum[c][j + 1] + subSum[c][j + 2] + subSum[c][j + 3]) / span;
    }
    blocks[j] = -0.691 + 10 * Math.log10(z + 1e-24);
  }

  // Porte absolue (-70 LUFS), puis porte relative (-10 LU sous la moyenne).
  const gated = thr => {
    let sum = 0, count = 0;
    for (let j = 0; j < nBlocks; j++) {
      if (blocks[j] <= thr) continue;
      sum += Math.pow(10, (blocks[j] + 0.691) / 10);
      count++;
    }
    return count ? -0.691 + 10 * Math.log10(sum / count) : -Infinity;
  };

  const first = gated(-70);
  if (!isFinite(first)) return -Infinity;
  return gated(Math.max(-70, first - 10));
}

/**
 * Limiteur à anticipation, appliqué SUR PLACE.
 * La réduction est anticipée de 5 ms pour ne pas s'entendre, et remonte en
 * 100 ms. Le minimum glissant utilise une file monotone : O(n) au total, et
 * aucun tableau de la taille du fichier n'est alloué.
 * @returns la réduction maximale appliquée, en dB (0 si rien n'a été limité).
 */
export function limiter(channels, ceiling, sr) {
  const n = channels[0] ? channels[0].length : 0;
  if (!n) return 0;
  const look = Math.max(1, Math.round(0.005 * sr));
  const rel = Math.exp(-1 / (0.100 * sr));

  const needAt = i => {
    let peak = 0;
    for (const c of channels) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
    return peak > ceiling ? ceiling / peak : 1;
  };

  const cap = look + 2;
  const qi = new Int32Array(cap), qv = new Float32Array(cap);
  let head = 0, tail = 0, next = 0, env = 1, worst = 1;

  for (let i = 0; i < n; i++) {
    const end = Math.min(n - 1, i + look);
    while (next <= end) {
      const v = needAt(next);
      while (tail !== head) {
        const t = (tail - 1 + cap) % cap;
        if (qv[t] >= v) tail = t; else break;
      }
      qi[tail] = next; qv[tail] = v; tail = (tail + 1) % cap; next++;
    }
    while (qi[head] < i) head = (head + 1) % cap;

    const target = qv[head];
    env = target < env ? target : target + (env - target) * rel;
    if (env < worst) worst = env;
    if (env !== 1) for (const c of channels) c[i] *= env;
  }
  return 20 * Math.log10(worst);
}

/**
 * Amène les canaux à la sonie cible, crêtes bridées à `ceiling`. Sur place.
 * @returns { applied, lufs, reduction } en dB / LUFS / dB
 */
export function normalizeTo(channels, fs, targetLufs, ceiling = 0.891 /* -1 dBFS */) {
  const lufs = measureLufs(channels, fs);
  if (!isFinite(lufs)) return { applied: 0, lufs, reduction: 0 };

  const gain = Math.pow(10, (targetLufs - lufs) / 20);
  for (const d of channels) for (let i = 0; i < d.length; i++) d[i] *= gain;

  const reduction = limiter(channels, ceiling, fs);
  return { applied: 20 * Math.log10(gain), lufs, reduction };
}
