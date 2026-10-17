// Reading `Authorization: Bearer …` for the Sylo app's API calls (src/web/lib/bearer.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { bearerToken } from '../src/web/lib/bearer.js';

const req = (authorization, path = '/api/v2/guilds') => ({
  originalUrl: path,
  get: (h) => (h.toLowerCase() === 'authorization' ? authorization : undefined),
});

test('bearerToken: the token after "Bearer", on /api/ paths only', () => {
  assert.equal(bearerToken(req('Bearer sylo_abc')), 'sylo_abc');
  assert.equal(bearerToken(req('bearer \t sylo_abc  ')), 'sylo_abc');
  assert.equal(bearerToken(req('Bearer')), '', 'an empty token still counts as presenting one');
  assert.equal(bearerToken(req('Bearer ')), '');
  assert.equal(bearerToken(req('Bearersylo_abc')), null);
  assert.equal(bearerToken(req('Basic dXNlcjpwYXNz')), null);
  assert.equal(bearerToken(req(undefined)), null);
  assert.equal(bearerToken(req('Bearer sylo_abc', '/guilds/1/m/afk')), null, 'not the HTML dashboard');
  assert.equal(bearerToken(req('Bearer sylo_abc', '/api/v2/guilds?x=1')), 'sylo_abc');
});

test('bearerToken: a long run of whitespace is read in linear time (no ReDoS)', () => {
  // A line break at the end makes a backtracking pattern retry every split of the tabs.
  const evil = `Bearer\t${'\t'.repeat(60_000)}\n!`;
  const started = process.hrtime.bigint();
  bearerToken(req(evil));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
});
