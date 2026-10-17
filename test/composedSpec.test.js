// A saved message is stored as sent by the dashboard. It is bounded to what a message can
// hold (2000 characters, 10 embeds, 5 rows) and to 64 KB in all, so one save cannot store
// a quarter of a megabyte of arbitrary JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseComposedSpec } from '../src/modules/messageCreator.js';

test('normaliseComposedSpec bounds text, embeds and rows', () => {
  const spec = normaliseComposedSpec({
    content: 'x'.repeat(5000),
    embeds: Array.from({ length: 20 }, () => ({ title: 't' })),
    rows: Array.from({ length: 9 }, () => ({ type: 'buttons', buttons: [] })),
  });
  assert.equal(spec.content.length, 2000);
  assert.equal(spec.embeds.length, 10);
  assert.equal(spec.rows.length, 5);
});

test('normaliseComposedSpec refuses an oversized spec and a non-object', () => {
  assert.equal(normaliseComposedSpec({ embeds: [{ description: 'x'.repeat(100_000) }] }), null);
  assert.equal(normaliseComposedSpec('nope'), null);
  assert.equal(normaliseComposedSpec(null), null);
});
