// The proof of work Postal Pigeon asks for when an instance registers: a nonce for which
// SHA-256(challenge + nonce), both as UTF-8 text, starts with at least `difficulty` zero bits.
// 20 bits is about a second; the work runs in a worker thread (pigeonPowWorker.js) so it never
// holds up the bot.
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

/** The number of zero bits a digest starts with. */
export function leadingZeroBits(digest) {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/**
 * The first nonce, counting up from 0 in decimal, that meets the difficulty.
 * @param {string} challenge
 * @param {number} difficulty  0 to 256 bits
 * @returns {string}
 */
export function solvePow(challenge, difficulty) {
  const base = createHash('sha256').update(challenge, 'utf8');
  for (let n = 0; ; n += 1) {
    const nonce = String(n);
    const digest = base.copy().update(nonce, 'utf8').digest();
    if (leadingZeroBits(digest) >= difficulty) return nonce;
  }
}

/**
 * Solve it in a worker thread, giving up (and stopping the thread) after `limitMs`.
 * @returns {Promise<string>}
 */
export function solvePowInWorker(challenge, difficulty, limitMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pigeonPowWorker.js', import.meta.url), {
      workerData: { challenge, difficulty },
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('pow_timeout')), limitMs);
    timer.unref?.();
    worker.once('message', (msg) =>
      typeof msg?.nonce === 'string' ? finish(resolve, msg.nonce) : finish(reject, new Error('pow_failed'))
    );
    worker.once('error', () => finish(reject, new Error('pow_failed')));
    worker.once('exit', () => finish(reject, new Error('pow_failed')));
  });
}
