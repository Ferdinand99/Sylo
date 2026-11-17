// The webhook transport (src/platform/webhooks.js): what both platforms are sent. The one rule that matters
// most is here: every body carries allowedMentions none, whatever the text says.
import './helpers/tmpDb.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { NO_MENTIONS, createWebhookTransport, webhookBody } from '../src/platform/webhooks.js';

afterEach(() => {
  runtime.clients.discord = null;
  runtime.clients.fluxer = null;
});

const FILE = { name: 'a.png', data: Buffer.from('x') };

test('a body never allows a mention, and has the platform’s own names for the avatar and files', () => {
  const payload = {
    content: '@everyone <@&123> hi',
    username: 'Alice [Fluxer]',
    avatarUrl: 'https://cdn/a.png',
    embeds: [{ title: 't' }],
    files: [FILE],
  };
  const d = webhookBody('discord', payload);
  assert.deepEqual(d.allowedMentions, { parse: [] });
  assert.deepEqual(NO_MENTIONS, { parse: [] });
  assert.equal(d.avatarURL, 'https://cdn/a.png');
  assert.equal(d.avatarUrl, undefined);
  assert.deepEqual(d.files, [{ attachment: FILE.data, name: 'a.png' }]);
  assert.equal(d.username, 'Alice [Fluxer]');
  assert.equal(d.content, '@everyone <@&123> hi');

  const f = webhookBody('fluxer', payload);
  assert.deepEqual(f.allowedMentions, { parse: [] });
  assert.equal(f.avatarUrl, 'https://cdn/a.png');
  assert.equal(f.avatarURL, undefined);
  assert.deepEqual(f.files, [{ name: 'a.png', data: FILE.data }]);
});

test('an edit body has the text and embeds only, still with no mentions', () => {
  for (const platform of ['discord', 'fluxer']) {
    const body = webhookBody(
      platform,
      { content: 'new', username: 'x', avatarUrl: 'https://a/b', files: [FILE], embeds: [] },
      { forEdit: true }
    );
    assert.deepEqual(body, { allowedMentions: { parse: [] }, content: 'new', embeds: [] });
  }
  assert.deepEqual(webhookBody('discord', {}), { allowedMentions: { parse: [] } });
});

test('a webhook is made through the channel of the right platform, and its token is returned', async () => {
  const made = [];
  const channel = { createWebhook: async (opts) => (made.push(opts), { id: '77', token: 'tok' }) };
  const guild = (client) => ({
    id: '710000000000000001',
    client,
    channels: { cache: new Map([['720000000000000001', channel]]) },
  });
  runtime.clients.discord = { guilds: { cache: new Map() } };
  runtime.clients.discord.guilds.cache.set('710000000000000001', guild(runtime.clients.discord));
  const transport = createWebhookTransport();
  assert.deepEqual(await transport.createHook('710000000000000001', '720000000000000001', 'Sylo bridge'), {
    id: '77',
    token: 'tok',
  });
  assert.deepEqual(made, [{ name: 'Sylo bridge', reason: 'Sylo bridge' }]);
});

test('a server Sylo is not in, a channel without webhooks and a webhook without a token are refused', async () => {
  const transport = createWebhookTransport();
  await assert.rejects(
    transport.createHook('710000000000000009', '720000000000000001', 'x'),
    (e) => e.code === 'NO_GUILD'
  );
  runtime.clients.discord = { guilds: { cache: new Map() } };
  const noHooks = { id: '710000000000000001', channels: { cache: new Map([['720000000000000001', {}]]) } };
  runtime.clients.discord.guilds.cache.set(noHooks.id, noHooks);
  await assert.rejects(
    transport.createHook(noHooks.id, '720000000000000001', 'x'),
    (e) => e.code === 'NO_CHANNEL'
  );
  noHooks.channels.cache.set('720000000000000002', { createWebhook: async () => ({ id: '1' }) });
  await assert.rejects(
    transport.createHook(noHooks.id, '720000000000000002', 'x'),
    /did not return a webhook token/
  );
});
