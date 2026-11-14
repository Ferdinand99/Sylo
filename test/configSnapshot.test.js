// What the change history keeps of a settings save (src/lib/configSnapshot.js): only the settings that
// changed, secrets masked, and the rules an undo follows (a masked value is never restored).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MASK,
  MAX_SNAPSHOT_CHARS,
  changedSettings,
  laterChanges,
  maskSecrets,
  parseChange,
  restoreMasked,
  serialiseChange,
  undoState,
  undoTarget,
} from '../src/lib/configSnapshot.js';

test('masks a secret by its key, by a webhook link and by credentials in a link', () => {
  const masked = maskSecrets({
    apiKey: 'sk-live-123',
    signingSecret: 's3cr3t',
    webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/abcDEF-token',
    note: 'post to https://discord.com/api/v10/webhooks/123456789012345678/abcDEF-token please',
    feed: 'https://user:pass@example.com/rss',
    feedKey: 'https://example.com/rss?token=abc123',
    plainUrl: 'https://example.com/rss?format=atom',
    channelId: '123456789012345678',
    enabled: true,
    tokenLimit: 5,
    emptyToken: '',
    items: [{ id: 'a', password: 'hunter2', name: 'Alpha' }],
    tokens: ['one', 'two'],
  });
  assert.equal(masked.apiKey, MASK);
  assert.equal(masked.signingSecret, MASK);
  assert.equal(masked.webhookUrl, MASK);
  assert.equal(masked.note, MASK, 'a webhook link inside a text masks the text');
  assert.equal(masked.feed, MASK);
  assert.equal(masked.feedKey, MASK);
  assert.equal(masked.plainUrl, 'https://example.com/rss?format=atom', 'a plain link stays readable');
  assert.equal(masked.channelId, '123456789012345678');
  assert.equal(masked.enabled, true);
  assert.equal(masked.emptyToken, '', 'an empty secret is not a secret');
  assert.deepEqual(masked.items, [{ id: 'a', password: MASK, name: 'Alpha' }]);
  assert.equal(masked.tokens, MASK, 'a list under a secret key is masked whole');
  assert.doesNotMatch(JSON.stringify(masked), /sk-live|s3cr3t|abcDEF|hunter2|pass@|abc123/);
});

test('keeps only the settings that changed, masked on both sides, and nothing when none did', () => {
  assert.equal(changedSettings({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), null);
  assert.equal(changedSettings({ a: 1, triggerSince: { r: 1 } }, { a: 1, triggerSince: { r: 2 } }), null);
  const change = changedSettings(
    { keep: 'same', channelId: '1', apiKey: 'old', gone: 'x' },
    { keep: 'same', channelId: '2', apiKey: 'new', added: true }
  );
  assert.deepEqual(change, {
    before: { channelId: '1', apiKey: MASK, gone: 'x' },
    after: { channelId: '2', apiKey: MASK, added: true },
  });
  assert.ok(!('keep' in change.before), 'an unchanged setting is not kept');
});

test('too large a change keeps a marker, not a copy; a damaged text reads as nothing', () => {
  const big = serialiseChange({ before: { a: 'x'.repeat(MAX_SNAPSHOT_CHARS) }, after: { a: 'y' } });
  assert.deepEqual(parseChange(big), { tooLarge: true });
  assert.deepEqual(parseChange(serialiseChange({ before: { a: 1 }, after: { a: 2 } })), {
    before: { a: 1 },
    after: { a: 2 },
  });
  assert.equal(parseChange('{not json'), null);
  assert.equal(parseChange(null), null);
  assert.equal(parseChange('{"before":1}'), null);
});

test('an undo puts the earlier values back and never a masked secret', () => {
  const current = { channelId: '2', apiKey: 'current-key', rules: [{ id: 'r1', name: 'A', secret: 'now' }] };
  const change = {
    before: { channelId: '1', apiKey: MASK, rules: [{ id: 'r1', name: 'Old', secret: MASK }] },
    after: { channelId: '2', apiKey: MASK, rules: [{ id: 'r1', name: 'A', secret: MASK }] },
  };
  const target = undoTarget(current, change);
  assert.equal(target.channelId, '1');
  assert.equal(target.apiKey, 'current-key', 'the secret that is saved now stays');
  assert.deepEqual(target.rules, [{ id: 'r1', name: 'Old', secret: 'now' }]);
  assert.ok(!JSON.stringify(target).includes(MASK), 'the mask is never written back');
});

test('a masked value with nothing saved to keep is left out; a setting that did not exist is removed', () => {
  assert.equal(restoreMasked(MASK, undefined), undefined);
  assert.deepEqual(restoreMasked({ a: MASK, b: 1 }, {}), { b: 1 });
  assert.deepEqual(restoreMasked([{ id: 'x', k: MASK }], []), [{ id: 'x' }]);
  const target = undoTarget({ a: 2, extra: 'new' }, { before: { a: 1 }, after: { a: 2, extra: 'new' } });
  assert.deepEqual(target, { a: 1 });
});

test('says whether the saved settings still match the change, were put back, or moved on', () => {
  const change = { before: { a: 1, b: [1] }, after: { a: 2, b: [1, 2] } };
  assert.equal(undoState({ a: 2, b: [1, 2], other: 9 }, change), 'clean');
  assert.equal(undoState({ a: 1, b: [1] }, change), 'reverted');
  assert.equal(undoState({ a: 3, b: [1, 2] }, change), 'changed');
  assert.deepEqual(laterChanges({ a: 3, b: [1, 2] }, change), ['a']);
  // a setting that the change added
  const added = { before: {}, after: { x: 1 } };
  assert.equal(undoState({ x: 1 }, added), 'clean');
  assert.equal(undoState({}, added), 'reverted');
});
