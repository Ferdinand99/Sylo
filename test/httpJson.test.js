import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHeaderValue } from 'node:http';
import { headerJson } from '../src/web/lib/httpJson.js';

test('headerJson: sanity check — JSON.stringify alone is rejected as a header value for non-Latin-1 text', () => {
  assert.throws(() => validateHeaderValue('HX-Trigger', JSON.stringify({ msg: 'ogłoszenia-📢' })));
});

test('headerJson: ASCII-only payload parses back unchanged', () => {
  const payload = { toast: { msg: 'Saved', kind: 'ok' } };
  assert.deepEqual(JSON.parse(headerJson(payload)), payload);
});

test('headerJson: escapes non-Latin-1 text into a valid header value that still parses correctly', () => {
  const payload = { toast: { msg: 'Test sent to #ogłoszenia-📢', kind: 'ok' } };
  const out = headerJson(payload);
  assert.doesNotThrow(() => validateHeaderValue('HX-Trigger', out));
  assert.deepEqual(JSON.parse(out), payload);
});
