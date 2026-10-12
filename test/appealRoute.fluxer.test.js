// The public appeal form on a Fluxer guild: the submitted appeal must be stored under the
// guild key ("fluxer:<id>"), the id the dashboard's Appeals tab and the decision flow read it by.
import './helpers/tmpDb.js';
import './helpers/openMode.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setGlobalDispatcher, Agent } from 'undici';
import { runtime } from '../src/runtime.js';
import { createApp } from '../src/web/server.js';
import { setGuildModule } from '../src/db/modules.js';
import { signAppealToken } from '../src/modules/appeals.js';
import { listAppeals } from '../src/db/appeals.js';

setGlobalDispatcher(new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 100 }));

const RAW = '333333333333333333';
const KEY = `fluxer:${RAW}`;
const USER = '444444444444444444';

test('an appeal submitted for a Fluxer guild is stored under the guild key', async () => {
  const client = {
    isReady: () => true,
    ws: { ping: 5 },
    user: { displayAvatarURL: () => null },
    commands: new Map(),
    users: { fetch: async () => ({ tag: 'Banned#0001' }) },
    guilds: { cache: new Map() },
  };
  const guild = {
    id: RAW,
    name: 'Fluxer Test',
    iconURL: () => null,
    members: { cache: new Map() },
    ownerId: 'x',
    client,
    bans: { fetch: async () => ({ reason: 'spam' }) },
    channels: { cache: new Map() },
  };
  client.guilds.cache.set(RAW, guild);
  runtime.clients.fluxer = client;
  await setGuildModule(KEY, 'appeals', { enabled: true });

  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });
  try {
    const token = signAppealToken(KEY, USER);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/appeal/${encodeURIComponent(KEY)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ t: token, a: 'because' }).toString(),
      redirect: 'manual',
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Appeal submitted/);
    assert.equal((await listAppeals(KEY)).length, 1, 'visible to the dashboard under the key');
    assert.equal((await listAppeals(RAW)).length, 0, 'not filed under the raw platform id');
  } finally {
    server.closeAllConnections?.();
    server.close();
    runtime.clients.fluxer = null;
  }
});
