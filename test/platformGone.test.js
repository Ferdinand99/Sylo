// The one place that says "the platform reports this message (or member, or role) as not there",
// for the error shapes of Discord and Fluxer. A timeout, a 5xx or a missing permission is not that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isMessageGone, isNotFound, isPermissionDenied } from '../src/platform/messageErrors.js';

test('isMessageGone: Discord numbers and statuses', () => {
  assert.equal(
    isMessageGone(Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 })),
    true
  );
  assert.equal(isMessageGone(Object.assign(new Error('Unknown Channel'), { code: 10003 })), true);
  assert.equal(isMessageGone({ status: 404 }), true);
  assert.equal(isMessageGone({ code: 10008 }), true);
});

test('isMessageGone: Fluxer statusCode, the cause one level down, and the string codes', () => {
  assert.equal(isMessageGone({ statusCode: 404 }), true);
  assert.equal(isMessageGone({ code: 'SOMETHING', cause: { statusCode: 404 } }), true);
  assert.equal(isMessageGone({ cause: { cause: { statusCode: 404 } } }), true, 'two levels');
  for (const code of ['UNKNOWN_MESSAGE', 'UNKNOWN_CHANNEL', 'MESSAGE_NOT_FOUND', 'CHANNEL_NOT_FOUND']) {
    assert.equal(isMessageGone({ code }), true, code);
    assert.equal(isMessageGone({ code: 'X', cause: { code } }), true, `${code} in cause`);
  }
});

test('isMessageGone: errors that do not say "gone"', () => {
  for (const err of [
    undefined,
    null,
    'Unknown Message',
    42,
    new Error('boom'),
    { status: 500 },
    { statusCode: 503 },
    { status: 403, code: 50001 },
    { statusCode: 429 },
    { code: 'RATE_LIMITED', cause: { statusCode: 502 } },
    { code: 10007 }, // an unknown member is not an unknown message
  ]) {
    assert.equal(isMessageGone(err), false, JSON.stringify(err));
  }
  // a cause chain that loops does not hang
  const loop = { code: 'X' };
  loop.cause = loop;
  assert.equal(isMessageGone(loop), false);
});

test("isNotFound takes the caller's own codes (temporary roles: unknown member, unknown role)", () => {
  assert.equal(isNotFound({ code: 10007 }, [10007, 10011]), true);
  assert.equal(isNotFound({ code: 10011 }, [10007, 10011]), true);
  assert.equal(isNotFound({ status: 404 }, [10007, 10011]), true);
  assert.equal(isNotFound({ statusCode: 404 }, [10007, 10011]), true, 'Fluxer');
  assert.equal(isNotFound({ cause: { statusCode: 404 } }, [10007, 10011]), true, 'Fluxer cause');
  assert.equal(isNotFound({ code: 10008 }, [10007, 10011]), false);
  assert.equal(isNotFound({ status: 500 }, [10007, 10011]), false);
});

test('isPermissionDenied: a refusal that a retry will not change', () => {
  assert.equal(isPermissionDenied({ status: 403 }), true);
  assert.equal(isPermissionDenied({ statusCode: 403 }), true);
  assert.equal(isPermissionDenied({ code: 50001 }), true);
  assert.equal(isPermissionDenied({ code: 50013 }), true);
  assert.equal(isPermissionDenied({ cause: { statusCode: 403 } }), true);
  assert.equal(isPermissionDenied({ status: 500 }), false);
  assert.equal(isPermissionDenied({ status: 404 }), false);
  assert.equal(isPermissionDenied(null), false);
});
