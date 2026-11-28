// One way to draw a short human-readable code from an alphabet, used by the bridge link codes and the
// mirror consent codes. Each character comes from crypto.randomInt, which rejects out-of-range values
// internally, so every letter is equally likely. Taking a random byte modulo the alphabet size is not
// the same: with 31 letters it would favour the first 8 letters (256 is not a multiple of 31).
import { randomInt } from 'node:crypto';

/**
 * A random code of `length` characters from `alphabet`, split into groups of `groupSize` joined by "-"
 * (no dashes when `groupSize` is 0).
 * @param {string} alphabet
 * @param {number} length
 * @param {number} [groupSize]
 */
export function randomCode(alphabet, length, groupSize = 0) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[randomInt(alphabet.length)];
    if (groupSize > 0 && i % groupSize === groupSize - 1 && i < length - 1) out += '-';
  }
  return out;
}
