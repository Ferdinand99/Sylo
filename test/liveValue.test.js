import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeLiveValue, decodeLiveValue, normaliseOnEnd, ON_END_MODES } from '../src/lib/liveValue.js';

test('encode/decode round-trips the stream ref + message location', () => {
  const v = encodeLiveValue('stream-42', '111', '222');
  assert.equal(v, 'stream-42|111|222');
  assert.deepEqual(decodeLiveValue(v), { ref: 'stream-42', channelId: '111', messageId: '222' });
});

test('encode tolerates a missing message (send failed)', () => {
  const v = encodeLiveValue('s1', null, undefined);
  assert.equal(v, 's1||');
  assert.deepEqual(decodeLiveValue(v), { ref: 's1', channelId: null, messageId: null });
});

test('decode is backward compatible with a bare pre-3.19 ref', () => {
  assert.deepEqual(decodeLiveValue('40952138429'), {
    ref: '40952138429',
    channelId: null,
    messageId: null,
  });
  assert.equal(decodeLiveValue(null).ref, '');
});

test('normaliseOnEnd: valid modes pass, everything else -> delete', () => {
  for (const m of ON_END_MODES) assert.equal(normaliseOnEnd(m), m);
  assert.equal(normaliseOnEnd('nonsense'), 'delete');
  assert.equal(normaliseOnEnd(undefined), 'delete');
});
