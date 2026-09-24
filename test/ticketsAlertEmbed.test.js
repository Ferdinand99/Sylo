// Covers issue #218: an opt-in to include the ticket's opening message in the
// staff notification channel, as an embed alongside the existing plain-text
// ping. Exercises ingestUserDM directly with minimal fakes (not
// test/helpers/fakeGuild.js — this only needs a channel.send() sink, none of
// that helper's member/role/ban surface).
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setGuildModule } from '../src/db/modules.js';
import { ingestUserDM } from '../src/modules/tickets.js';

const G = '900000000000000555';
const CHANNEL_ID = '100000000000000444';

// Each test opens a ticket for a distinct user id — getOpenTicket is scoped
// to (guild, user), so reusing one id across tests would make a later test's
// "new ticket" actually land as a reply on an earlier test's still-open one.
let nextUser = 300000000000000001n;
function fakeEnv() {
  const userId = String(nextUser++);
  const sent = [];
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      sent.push(payload);
      return { id: 'msg-1' };
    },
  };
  const guild = {
    id: G,
    name: 'Test Guild',
    channels: { cache: new Map([[CHANNEL_ID, channel]]), fetch: async () => null },
    members: { me: { permissions: { has: () => true } } },
  };
  const user = { id: userId, tag: 'member#0001', send: async () => {} };
  return { guild, user, sent };
}

test('a new ticket alert has no embed when showMessageInAlert is off (default)', async () => {
  await setGuildModule(G, 'tickets', { enabled: true, config: { notifyChannel: CHANNEL_ID } });
  const { guild, user, sent } = fakeEnv();

  await ingestUserDM(guild, user, { content: 'my subscription is broken', attachments: [] });

  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /New ticket/);
  assert.equal(sent[0].embeds, undefined);
});

test('a new ticket alert embeds the opening message when showMessageInAlert is on', async () => {
  await setGuildModule(G, 'tickets', {
    enabled: true,
    config: { notifyChannel: CHANNEL_ID, showMessageInAlert: true },
  });
  const { guild, user, sent } = fakeEnv();

  await ingestUserDM(guild, user, { content: 'my subscription is broken', attachments: [] });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].embeds.length, 1);
  assert.equal(sent[0].embeds[0].data.description, 'my subscription is broken');
});

test('a long opening message is truncated in the alert embed', async () => {
  await setGuildModule(G, 'tickets', {
    enabled: true,
    config: { notifyChannel: CHANNEL_ID, showMessageInAlert: true },
  });
  const { guild, user, sent } = fakeEnv();
  const long = 'x'.repeat(1200);

  await ingestUserDM(guild, user, { content: long, attachments: [] });

  const desc = sent[0].embeds[0].data.description;
  assert.equal(desc.length, 1001); // 1000 chars + the ellipsis
  assert.ok(desc.endsWith('…'));
});

test('a reply on an already-open ticket never gets an embed, regardless of the setting', async () => {
  await setGuildModule(G, 'tickets', {
    enabled: true,
    config: { notifyChannel: CHANNEL_ID, showMessageInAlert: true },
  });
  const { guild, user, sent } = fakeEnv();

  await ingestUserDM(guild, user, { content: 'first message', attachments: [] });
  await ingestUserDM(guild, user, { content: 'a follow-up reply', attachments: [] });

  assert.equal(sent.length, 2);
  assert.match(sent[1].content, /New reply/);
  assert.equal(sent[1].embeds, undefined);
});
