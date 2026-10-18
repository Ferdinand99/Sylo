// Dirty detection for the V2 dashboard's SaveBar (web-v2/src/components/formEqual.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepEqual, isDirty } from '../web-v2/src/components/formEqual.js';

test('primitives compare by value, NaN equals NaN', () => {
  assert.equal(deepEqual(1, 1), true);
  assert.equal(deepEqual('a', 'a'), true);
  assert.equal(deepEqual(1, '1'), false);
  assert.equal(deepEqual(0, -0), false);
  assert.equal(deepEqual(NaN, NaN), true);
  assert.equal(deepEqual(null, undefined), false);
  assert.equal(deepEqual(null, {}), false);
});

test('nested objects and arrays compare structurally', () => {
  const a = { channel: '1', roles: ['a', 'b'], rules: { links: { enabled: true, allowed: 'x, y' } } };
  const b = { channel: '1', roles: ['a', 'b'], rules: { links: { enabled: true, allowed: 'x, y' } } };
  assert.equal(deepEqual(a, b), true);
  assert.equal(deepEqual(a, { ...b, roles: ['b', 'a'] }), false, 'array order matters');
  assert.equal(deepEqual(a, { ...b, roles: ['a'] }), false);
  assert.equal(deepEqual([], {}), false, 'array is not an object');
  assert.equal(deepEqual(a, { ...b, rules: { links: { enabled: false, allowed: 'x, y' } } }), false);
});

test('a key holding undefined equals a missing key', () => {
  assert.equal(deepEqual({ a: 1, b: undefined }, { a: 1 }), true);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: null }), false, 'null is a real value');
});

test('dates compare by time', () => {
  assert.equal(deepEqual(new Date(5), new Date(5)), true);
  assert.equal(deepEqual(new Date(5), new Date(6)), false);
  assert.equal(deepEqual(new Date(5), 5), false);
});

test('isDirty: false until both sides are loaded, then structural', () => {
  assert.equal(isDirty(null, { a: 1 }), false);
  assert.equal(isDirty({ a: 1 }, undefined), false);
  const saved = { name: 'x', items: [{ key: 'k1', title: 'Hi' }] };
  assert.equal(isDirty(saved, saved), false);
  assert.equal(isDirty({ name: 'x', items: [{ key: 'k1', title: 'Hi' }] }, saved), false);
  assert.equal(isDirty({ name: 'x', items: [{ key: 'k1', title: 'Hi!' }] }, saved), true);
  // Edit then undo by hand → clean again.
  const edited = { ...saved, name: 'y' };
  assert.equal(isDirty(edited, saved), true);
  assert.equal(isDirty({ ...edited, name: 'x' }, saved), false);
});

test('isDirty ignores what an input does to a value without the user changing it', () => {
  // A number input hands back the string "5" for a saved 5.
  assert.equal(isDirty({ limit: '5' }, { limit: 5 }), false);
  assert.equal(isDirty({ limit: '6' }, { limit: 5 }), true);
  // A cleared optional field is '' where the server had null or nothing.
  assert.equal(isDirty({ channelId: '' }, { channelId: null }), false);
  assert.equal(isDirty({ channelId: '' }, {}), false);
  assert.equal(isDirty({ channelId: '1' }, { channelId: null }), true);
  // Nested values get the same treatment.
  assert.equal(
    isDirty({ tiers: [{ level: '10', roleId: '' }] }, { tiers: [{ level: 10, roleId: null }] }),
    false
  );
  // A real change to 0 or false is still a change.
  assert.equal(isDirty({ limit: '0' }, { limit: null }), true);
  assert.equal(isDirty({ on: false }, { on: null }), true);
});
