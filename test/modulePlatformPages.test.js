// The module settings pages tell a Fluxer server what differs on Fluxer, and a Discord server
// sees exactly what it always did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startWebApp } from './helpers/webApp.js';
import { runtime } from '../src/runtime.js';

const RAW = '900000000000000150';
const KEY = `fluxer:${RAW}`;

test('module pages: Fluxer servers get a platform note and no native AutoMod, Discord ones neither', async () => {
  const app = await startWebApp();
  const fluxerClient = {
    isReady: () => true,
    ws: { ping: 5 },
    user: { id: '555555555555555555', displayAvatarURL: () => null },
    commands: new Map(),
    guilds: { cache: new Map() },
  };
  fluxerClient.guilds.cache.set(RAW, {
    id: RAW,
    name: 'Fluxer Test',
    client: fluxerClient,
    iconURL: () => null,
    memberCount: 3,
    ownerId: 'x',
    members: { cache: new Map(), me: null },
    channels: { cache: new Map() },
    roles: { cache: new Map() },
    emojis: { cache: new Map() },
  });
  runtime.clients.fluxer = fluxerClient;
  try {
    const page = async (guildKey, mod) => {
      const res = await fetch(`${app.base}/guilds/${encodeURIComponent(guildKey)}/m/${mod}`);
      assert.equal(res.status, 200, `${guildKey} ${mod}`);
      return res.text();
    };

    const fAutomod = await page(KEY, 'automod');
    assert.match(fAutomod, /Fluxer has no native AutoMod rules/);
    assert.doesNotMatch(fAutomod, /Native Discord AutoMod/);

    const fVoice = await page(KEY, 'temp-voice');
    assert.match(fVoice, /cannot move members/);

    // The new dashboard asks the API instead of reading the page.
    const api = async (guildKey) =>
      (await fetch(`${app.base}/api/v2/guilds/${encodeURIComponent(guildKey)}/platform`)).json();
    const f = await api(KEY);
    assert.equal(f.platform, 'fluxer');
    assert.equal(f.capabilities.nativeAutomod, false);
    assert.match(f.notes['temp-voice'], /cannot move members/);
    const d = await api(app.guild.id);
    assert.equal(d.platform, 'discord');
    assert.equal(d.capabilities.nativeAutomod, true);
    assert.deepEqual(d.notes, {});

    const dAutomod = await page(app.guild.id, 'automod');
    assert.doesNotMatch(dAutomod, /Fluxer has no native AutoMod/);
    assert.match(dAutomod, /Native Discord AutoMod/);
  } finally {
    runtime.clients.fluxer = null;
    app.close();
  }
});
