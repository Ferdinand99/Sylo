import test from 'node:test';
import assert from 'node:assert/strict';
import { idList } from '../src/web/lib/idList.js';

test('idList keeps snowflake strings only, de-duplicated and capped', () => {
  const a = '100000000000000001';
  const b = '100000000000000002';
  assert.deepEqual(idList([a, [b], 'x', a, b, 42]), [a, b]);
  assert.deepEqual(idList(a), [a]);
  assert.deepEqual(idList(undefined), []);
  const many = Array.from({ length: 40 }, (_, i) => String(100000000000000000n + BigInt(i)));
  assert.equal(idList(many).length, 40, 'below the default cap of 100');
  assert.equal(idList(many, 5).length, 5);
});
