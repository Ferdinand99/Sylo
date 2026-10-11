import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  saveComponentActions,
  getComponentAction,
  deleteComponentActions,
  purgeExpiredComponentActions,
} from '../src/db/componentReactions.js';
import { purgeGuild } from '../src/db/purge.js';

const G = 'fluxer:900000000000000090';
const actions = [
  { kind: 'button', customId: 'gaw:enter:7', emoji: '🎉', label: 'Enter' },
  { kind: 'select', customId: 'help-category', value: 'mod', emoji: '2️⃣', label: 'Moderation' },
];

test('saved actions are found by message and emoji, with their handler data', async () => {
  await saveComponentActions({ guildId: G, channelId: 'c1', messageId: 'm1', actions });
  assert.deepEqual(await getComponentAction('m1', '🎉'), {
    guildId: G,
    channelId: 'c1',
    messageId: 'm1',
    kind: 'button',
    customId: 'gaw:enter:7',
    value: null,
    emoji: '🎉',
    expiresAt: null,
  });
  assert.equal((await getComponentAction('m1', '2️⃣')).value, 'mod');
  assert.equal(await getComponentAction('m1', '🙈'), null);
  assert.equal(await getComponentAction('nope', '🎉'), null);
});

test('saving a message again replaces its earlier actions', async () => {
  await saveComponentActions({ guildId: G, channelId: 'c1', messageId: 'm2', actions });
  await saveComponentActions({ guildId: G, channelId: 'c1', messageId: 'm2', actions: [actions[0]] });
  assert.ok(await getComponentAction('m2', '🎉'));
  assert.equal(await getComponentAction('m2', '2️⃣'), null);
});

test('deleteComponentActions removes every action of a message', async () => {
  await saveComponentActions({ guildId: G, channelId: 'c1', messageId: 'm3', actions });
  await deleteComponentActions('m3');
  assert.equal(await getComponentAction('m3', '🎉'), null);
});

test('expired actions are purged, permanent and unexpired ones stay', async () => {
  const now = 1_000_000;
  await saveComponentActions({ guildId: G, channelId: 'c', messageId: 'old', actions, expiresAt: now - 1 });
  await saveComponentActions({ guildId: G, channelId: 'c', messageId: 'new', actions, expiresAt: now + 1 });
  await saveComponentActions({ guildId: G, channelId: 'c', messageId: 'forever', actions });
  await purgeExpiredComponentActions(now);
  assert.equal(await getComponentAction('old', '🎉'), null);
  assert.ok(await getComponentAction('new', '🎉'));
  assert.ok(await getComponentAction('forever', '🎉'));
});

test('purging a guild removes its actions', async () => {
  await saveComponentActions({ guildId: G, channelId: 'c', messageId: 'gone', actions });
  await purgeGuild(G);
  assert.equal(await getComponentAction('gone', '🎉'), null);
});
