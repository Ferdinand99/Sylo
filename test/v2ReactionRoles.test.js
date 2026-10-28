// Reaction roles in the new dashboard: the server emoji list for the picker (the classic /guilds/:id/emojis),
// and the checks that name the row at fault instead of dropping it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, OTHER_D_GUILD, startOAuthApp } from './helpers/oauthApp.js';
import { adminApi } from './helpers/v2Admin.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');

const CHANNEL = '100000000000000001';
const ROLE = '200000000000000001';
const ROLE_2 = '200000000000000002';

// --- emoji picker source ---------------------------------------------------

test('the emoji list is the server custom emojis, for an admin of that server', async () => {
  const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
  guild.emojis.cache.set('300000000000000001', {
    name: 'wave',
    toString: () => '<:wave:300000000000000001>',
    imageURL: ({ size }) => `https://cdn.example/emoji/wave.png?size=${size}`,
  });
  const { b } = await adminApi();
  const res = await b.get(`/api/v2/guilds/${D_GUILD}/emojis`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).custom, [
    {
      name: 'wave',
      display: '<:wave:300000000000000001>',
      url: 'https://cdn.example/emoji/wave.png?size=32',
    },
  ]);
});

test('the emoji list is refused for a server the person does not manage', async () => {
  const { b } = await adminApi();
  const res = await b.get(`/api/v2/guilds/${OTHER_D_GUILD}/emojis`);
  assert.equal(res.status, 403);
});

// --- reaction roles -----------------------------------------------------------

test('a reaction-role row that is wrong is named, instead of being dropped without a word', async () => {
  const { api } = await adminApi();
  const save = (body) => api('/modules/roles/rr', { channelId: CHANNEL, style: 'reaction', ...body });

  let res = await save({
    pairs: [
      { roleId: ROLE, emoji: '👍' },
      { roleId: ROLE_2, emoji: '' },
    ],
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Row 2: enter a valid emoji/);

  res = await save({ pairs: [{ roleId: '', emoji: '👍' }] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Row 1: select a role/);

  res = await save({ pairs: [{ roleId: '', emoji: '', label: '' }] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Add at least one role/);

  res = await save({ pairs: Array.from({ length: 26 }, () => ({ roleId: ROLE, emoji: '👍' })) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /at most 25 roles per message/);
});

test('buttons and dropdowns do not need an emoji on each row', async () => {
  const { api } = await adminApi();
  const res = await api('/modules/roles/rr', {
    channelId: CHANNEL,
    style: 'buttons',
    pairs: [{ roleId: ROLE, emoji: '', label: 'Gamer' }],
  });
  // Saved (the post itself fails on the fake server and is reported next to the saved set).
  assert.equal(res.status, 200);
  const { reactionMessage } = await res.json();
  assert.equal(reactionMessage.pairs[0].roleId, ROLE);
  assert.equal(reactionMessage.pairs[0].label, 'Gamer');
});
