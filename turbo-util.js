/* =============================================================================
   TURBO · OUTILS PARTAGÉS
   -----------------------------------------------------------------------------
   Constantes de temps, détection de WebCodecs, et la « plomberie » asynchrone
   commune à tout le moteur : temporisation, barrières de file de codec, et le
   collecteur d'erreurs qui empêche une exception de callback WebCodecs de
   disparaître silencieusement. Aucune dépendance interne : c'est la brique de
   base, tout le reste s'appuie dessus.
   ========================================================================== */

const US = 1_000_000; // microsecondes par seconde

// ==================== DISPONIBILITÉ ====================
export function turboSupported() {
  return typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined'
      && typeof AudioDecoder !== 'undefined' && typeof AudioEncoder !== 'undefined'
      && typeof VideoFrame !== 'undefined' && typeof AudioData !== 'undefined';
}

// ==================== OUTILS ====================
const sleep = (ms = 0) => new Promise(r => setTimeout(r, ms));
const usOf = (cts, timescale) => Math.round((cts / timescale) * US);

// Delai avant de considerer qu'un codec est bloque. Large a dessein : il ne
// doit se declencher que sur un vrai blocage, jamais sur un appareil lent.
const FLUSH_TIMEOUT_MS = 90_000;

// Nombre de trames tolerees en vol dans le pipeline.
//
// Volontairement bas : une trame remise a l'encodeur retient le tampon de
// sortie du decodeur jusqu'a ce qu'elle soit consommee, et le pool de tampons
// d'un decodeur materiel de telephone est petit (souvent 8 a 16). Trop de
// trames retenues affame le decodeur, qui abandonne avec un laconique
// « Decoding error ».
const IN_FLIGHT_MAX = 6;

/** Rejette si la promesse n'aboutit pas a temps, au lieu d'attendre sans fin. */
export function withTimeout(promise, ms, message) {
  let t;
  const limite = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${message} (aucune réponse après ${Math.round(ms / 1000)} s)`)), ms);
  });
  return Promise.race([promise, limite]).finally(() => clearTimeout(t));
}

/**
 * Attend qu'une file de codec redescende sous `max`.
 *
 * Sonder toutes les 8 ms coute cher : sur une video de 10 min a 30 images/s,
 * si la barriere se declenche a chaque image, on passe pres de deux minutes et
 * demie a attendre un minuteur plutot qu'a encoder. WebCodecs expose
 * l'evenement `dequeue`, emis des qu'une place se libere : on est reveille au
 * bon moment, sans latence de sondage.
 *
 * Repli par sondage pour les navigateurs qui ne l'exposent pas encore.
 * @param sizeKey 'decodeQueueSize' ou 'encodeQueueSize'
 */
export function drainTo(codec, sizeKey, max) {
  if (codec[sizeKey] <= max) return Promise.resolve();
  return new Promise(resolve => {
    if (typeof codec.addEventListener === 'function' && 'ondequeue' in codec) {
      const onDequeue = () => {
        if (codec[sizeKey] > max) return;
        codec.removeEventListener('dequeue', onDequeue);
        resolve();
      };
      codec.addEventListener('dequeue', onDequeue);
      onDequeue();                       // la place s'est peut-etre deja liberee
    } else {
      const poll = () => (codec[sizeKey] <= max ? resolve() : setTimeout(poll, 4));
      poll();
    }
  });
}

/* Collecteur d'erreurs WebCodecs.
   Les callbacks `error:` et `output:` des codecs sont appelés par le navigateur
   dans leur propre tâche : une exception levée depuis là ne rejette PAS la
   promesse que l'appelant attend, elle devient une exception non capturée. Le
   repli automatique vers ffmpeg ne se déclenchait donc pas, et on produisait un
   MP4 tronqué. On mémorise l'erreur ici, et la boucle la relève. */
function errorSink() {
  let first = null;
  return {
    fail(e, prefix) {
      if (first) return;
      const msg = (e && e.message) || String(e);
      first = new Error(prefix ? `${prefix} : ${msg}` : msg);
    },
    check() { if (first) throw first; },
    get raised() { return first !== null; },
  };
}

/* Emballe un callback `output:` de codec pour que ses exceptions (typiquement
   une erreur du muxer) soient collectées au lieu d'être perdues. */
const guarded = (sink, prefix, fn) => (...args) => {
  try { fn(...args); } catch (e) { sink.fail(e, prefix); }
};

export { US, sleep, usOf, FLUSH_TIMEOUT_MS, IN_FLIGHT_MAX, errorSink, guarded };
