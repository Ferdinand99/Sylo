import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionedUserIds, mentionedRoleIds, mentionsEveryone } from '../src/platform/mentions.js';

// discord.js: message.mentions = { users: Collection, roles: Collection, everyone: boolean }
const discordMessage = {
  mentions: {
    users: new Map([
      ['u1', {}],
      ['u2', {}],
    ]),
    roles: new Map([['r1', {}]]),
    everyone: true,
  },
};
// Fluxer: message.mentions is an array of users; roles and everyone are sibling fields
const fluxerMessage = { mentions: [{ id: 'u1' }, { id: 'u2' }], mentionRoles: ['r1'], mentionEveryone: true };

test('user ids from either message shape', () => {
  assert.deepEqual(mentionedUserIds(discordMessage), ['u1', 'u2']);
  assert.deepEqual(mentionedUserIds(fluxerMessage), ['u1', 'u2']);
});

test('role ids from either message shape', () => {
  assert.deepEqual(mentionedRoleIds(discordMessage), ['r1']);
  assert.deepEqual(mentionedRoleIds(fluxerMessage), ['r1']);
});

test('@everyone from either message shape', () => {
  assert.equal(mentionsEveryone(discordMessage), true);
  assert.equal(mentionsEveryone(fluxerMessage), true);
  assert.equal(
    mentionsEveryone({ mentions: { users: new Map(), roles: new Map(), everyone: false } }),
    false
  );
  assert.equal(mentionsEveryone({ mentions: [], mentionEveryone: false }), false);
});

test('a message with no mention data mentions nobody', () => {
  for (const m of [{}, { mentions: undefined }, null, undefined]) {
    assert.deepEqual(mentionedUserIds(m), []);
    assert.deepEqual(mentionedRoleIds(m), []);
    assert.equal(mentionsEveryone(m), false);
  }
});

test('user entries that are bare ids are accepted too', () => {
  assert.deepEqual(mentionedUserIds({ mentions: ['u9'] }), ['u9']);
});
