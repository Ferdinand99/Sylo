// Bridge link codes and mirror consent codes are drawn without modulo bias: every letter of the
// 31-letter alphabet is equally likely. A random byte modulo 31 favours the first 8 letters.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomCode } from '../src/lib/randomCode.js';

const { newCode: bridgeCode, CODE_LENGTH } = await import('../src/db/bridge.js');
const { newCode: mirrorCode } = await import('../src/mirror/consent.js');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('a bridge code is 12 letters of the alphabet in groups of four', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = bridgeCode();
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const plain = code.replaceAll('-', '');
    assert.equal(plain.length, CODE_LENGTH);
    for (const ch of plain) assert.ok(ALPHABET.includes(ch), `unexpected ${ch}`);
  }
});

test('a mirror code is 8 letters of the alphabet in two groups of four', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = mirrorCode();
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    for (const ch of code.replace('-', '')) assert.ok(ALPHABET.includes(ch), `unexpected ${ch}`);
  }
});

test('randomCode honours length and group size, and every letter turns up', () => {
  assert.equal(randomCode(ALPHABET, 7).length, 7);
  assert.equal(randomCode(ALPHABET, 7).includes('-'), false);
  assert.match(randomCode(ALPHABET, 9, 3), /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/);
  const seen = new Set(randomCode(ALPHABET, 5000));
  assert.equal(seen.size, ALPHABET.length);
});

test('no modulo over random bytes is left in the code helpers', () => {
  for (const path of ['../src/lib/randomCode.js', '../src/db/bridge.js', '../src/mirror/consent.js']) {
    const text = source(path);
    assert.doesNotMatch(text, /%\s*31\b/, `${path} has "% 31"`);
    assert.doesNotMatch(text, /%\s*\w*ALPHABET\.length/i, `${path} takes a byte modulo the alphabet`);
    assert.doesNotMatch(text, /randomBytes/, `${path} draws codes from randomBytes`);
  }
  assert.match(source('../src/lib/randomCode.js'), /randomInt\(/);
});
