import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getCounting, advanceCount, resetCount, setCount } from '../src/db/counting.js';

const G = '900000000000000030';
const U1 = '800000000000000301';

test('getCounting defaults to zeroed state for a guild never played', async () => {
  const st = await getCounting(G);
  assert.equal(st.current, 0);
  assert.equal(st.record, 0);
  assert.equal(st.last_user_id, null);
  assert.equal(st.last_message_id, null);
});

test('advanceCount upserts current + tracks the record high', async () => {
  await advanceCount(G, { current: 1, userId: U1, messageId: 'm1' });
  let st = await getCounting(G);
  assert.equal(st.current, 1);
  assert.equal(st.record, 1);
  assert.equal(st.last_user_id, U1);
  assert.equal(st.last_message_id, 'm1');

  await advanceCount(G, { current: 5, userId: U1, messageId: 'm2' });
  st = await getCounting(G);
  assert.equal(st.current, 5);
  assert.equal(st.record, 5);

  // Counting resets to 1 after a fail but the record must not drop.
  await advanceCount(G, { current: 1, userId: U1, messageId: 'm3' });
  st = await getCounting(G);
  assert.equal(st.current, 1);
  assert.equal(st.record, 5);
});

test('resetCount zeroes current, clears last-counter, keeps the record', async () => {
  await advanceCount(G, { current: 8, userId: U1, messageId: 'm1' });
  await resetCount(G);
  const st = await getCounting(G);
  assert.equal(st.current, 0);
  assert.equal(st.record, 8);
  assert.equal(st.last_user_id, null);
  assert.equal(st.last_message_id, null);
});

test('setCount forces an exact value, clamps invalid input, updates the record', async () => {
  await resetCount(G);
  const n = await setCount(G, 42);
  assert.equal(n, 42);
  let st = await getCounting(G);
  assert.equal(st.current, 42);
  assert.equal(st.record, 42);
  assert.equal(st.last_user_id, null);

  assert.equal(await setCount(G, -5), 0); // clamped
  assert.equal(await setCount(G, 'nope'), 0);
  st = await getCounting(G);
  assert.equal(st.current, 0);
  assert.equal(st.record, 42); // never drops
});
