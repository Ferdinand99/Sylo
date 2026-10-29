// The Auto threads page of the new dashboard through /api/v2: the channel and role lists (forums left
// out), the stored settings, the normalising and the audit row. Who may call these routes, and the CSRF
// header, are in v2.permissions*.test.js and v2AutoThreads.auth.test.js.
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID, CH, ROLE } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { getGuildModule } from '../src/db/modules.js';

let app;
let api;
const FORUM = '100000000000000050';
test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
  app.guild.channels.cache.set(FORUM, {
    id: FORUM,
    name: 'ideas-forum',
    type: ChannelType.GuildForum,
    rawPosition: 9,
  });
});
test.after(() => app.close());

const json = async (res) => res.json();

test('GET config: no rules yet, only text and announcement channels, and the roles', async () => {
  const res = await api.get('/modules/auto-threads/config');
  assert.equal(res.status, 200);
  const data = await json(res);
  assert.deepEqual(data.config, { rules: [] });
  const ids = data.channels.map((c) => c.id);
  assert.ok(ids.includes(CH.general));
  assert.ok(ids.includes(CH.announce));
  assert.ok(!ids.includes(FORUM), 'a forum already makes threads, so it is not offered');
  assert.ok(!ids.includes(CH.voice));
  assert.ok(!ids.includes(CH.category));
  assert.ok(data.roles.some((r) => r.id === ROLE.member));
});

test('POST config stores the normalised rules and writes an audit row', async () => {
  const res = await api.post('/modules/auto-threads/config', {
    rules: [
      {
        id: 'art',
        channelId: CH.general,
        nameTemplate: '  {author} - {words}  ',
        archiveMinutes: 4320,
        onlyWithAttachments: true,
        onlyWithLinks: false,
        skipBots: true,
        skipStaff: true,
        staffRoleIds: [ROLE.admin, 'junk'],
        firstMessage: 'Hello {author}',
        slowmodeSeconds: 99999,
        junk: 'dropped',
      },
    ],
    other: 'ignored',
  });
  assert.equal(res.status, 200);
  const expected = {
    rules: [
      {
        id: 'art',
        channelId: CH.general,
        nameTemplate: '{author} - {words}',
        archiveMinutes: 4320,
        onlyWithAttachments: true,
        onlyWithLinks: false,
        skipBots: true,
        skipStaff: true,
        staffRoleIds: [ROLE.admin],
        firstMessage: 'Hello {author}',
        slowmodeSeconds: 21600,
      },
    ],
  };
  assert.deepEqual((await json(res)).config, expected);
  assert.deepEqual((await getGuildModule(GID, 'auto-threads')).config, expected);
  assert.deepEqual((await json(await api.get('/modules/auto-threads/config'))).config, expected);
  const audit = (await auditRows(GID, 'module:auto-threads'))[0];
  assert.equal(audit.detail, 'settings saved');
  assert.equal(audit.actor, 'Dashboard');
});

test('POST config: a rule for a forum, a voice channel or an unknown channel is left out', async () => {
  const res = await api.post('/modules/auto-threads/config', {
    rules: [
      { channelId: FORUM },
      { channelId: CH.voice },
      { channelId: '100000000000099999' },
      { channelId: 'not-an-id' },
      { channelId: CH.announce },
    ],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    (await json(res)).config.rules.map((r) => r.channelId),
    [CH.announce]
  );
  assert.equal((await getGuildModule(GID, 'auto-threads')).config.rules.length, 1);
});

test('POST config: bad bodies are normalised, never an error', async () => {
  for (const body of [{}, { rules: 'x' }, { rules: [null, 5, 'x'] }]) {
    const res = await api.post('/modules/auto-threads/config', body);
    assert.equal(res.status, 200);
    assert.deepEqual((await json(res)).config, { rules: [] });
  }
});

test('POST config: at most 25 rules, a 100 character template, a 2000 character first message', async () => {
  const res = await api.post('/modules/auto-threads/config', {
    rules: Array.from({ length: 30 }, () => ({
      channelId: CH.general,
      nameTemplate: 'n'.repeat(150),
      firstMessage: 'f'.repeat(2500),
    })),
  });
  const { rules } = (await json(res)).config;
  assert.equal(rules.length, 25);
  assert.equal(rules[0].nameTemplate.length, 100);
  assert.equal(rules[0].firstMessage.length, 2000);
  assert.equal(new Set(rules.map((r) => r.id)).size, 25);
});
