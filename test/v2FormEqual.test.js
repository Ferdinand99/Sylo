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
