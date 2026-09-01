import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseVanitySlug,
  setVanitySlug,
  getVanitySlug,
  guildForVanity,
  clearVanitySlug,
} from '../src/db/leaderboardVanity.js';

const A = '900000000000000001';
const B = '900000000000000002';

test('normaliseVanitySlug: cleans, lowercases, validates length', () => {
  assert.equal(normaliseVanitySlug('  My Server  '), 'my-server');
  assert.equal(normaliseVanitySlug('Priv__Stuff!!'), 'priv-stuff');
  assert.equal(normaliseVanitySlug('-lead-'), 'lead');
  assert.equal(normaliseVanitySlug('ab'), null); // too short (min 3)
  assert.equal(normaliseVanitySlug('a'.repeat(33)), null); // too long
  assert.equal(normaliseVanitySlug('---'), null);
});

test('setVanitySlug: claim, read back, reject a clash, allow re-set on same guild', () => {
  assert.deepEqual(setVanitySlug(A, 'Priv Stuff'), { ok: true, slug: 'priv-stuff' });
  assert.equal(getVanitySlug(A), 'priv-stuff');
  assert.equal(guildForVanity('priv-stuff'), A);
  assert.equal(guildForVanity('PRIV-STUFF'), A); // case-insensitive lookup

  assert.deepEqual(setVanitySlug(B, 'priv-stuff'), { ok: false, error: 'taken' });
  assert.deepEqual(setVanitySlug(A, 'priv-stuff-2'), { ok: true, slug: 'priv-stuff-2' }); // reassign own
  assert.equal(getVanitySlug(A), 'priv-stuff-2');
  assert.equal(guildForVanity('priv-stuff'), null); // old slug freed
  assert.deepEqual(setVanitySlug(B, 'priv-stuff'), { ok: true, slug: 'priv-stuff' }); // now available
});

test('setVanitySlug rejects an unfixable slug; clearVanitySlug frees it', () => {
  assert.deepEqual(setVanitySlug(A, '!!'), { ok: false, error: 'invalid' });
  clearVanitySlug(A);
  assert.equal(getVanitySlug(A), null);
});
