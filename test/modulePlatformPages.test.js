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
    commands: new Map([
      ['giveaway', {}],
      ['afk', {}],
    ]),
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

    // Commands read as chat commands on Fluxer, and a URL that merely starts like one is left alone.
    const fGiveaways = await page(KEY, 'giveaways');
    assert.match(fGiveaways, /<code>!giveaway start/);
    assert.doesNotMatch(fGiveaways, /<code>\/giveaway start/);
    const dGiveaways = await page(app.guild.id, 'giveaways');
    assert.match(dGiveaways, /<code>\/giveaway start/);

    // The custom command builder talks about chat commands, not Discord's slash command list.
    const fBuilder = await page(KEY, 'custom-commands/cmd/new');
    assert.match(fBuilder, /<span class="cc-slash">!<\/span>/);
    assert.doesNotMatch(fBuilder, /Discord(?:'|&#39;)s command list/);
    assert.match(fBuilder, /Members run it as/);
    const dBuilder = await page(app.guild.id, 'custom-commands/cmd/new');
    assert.match(dBuilder, /<span class="cc-slash">\/<\/span>/);
    assert.match(dBuilder, /Discord(?:'|&#39;)s command list/);
    const fCc = await page(KEY, 'custom-commands');
    assert.doesNotMatch(fCc, /sync to\s+Discord/);

    // A message link points at the platform's own web app, not at discord.com.
    const { setGuildModule } = await import('../src/db/modules.js');
    const trap = {
      channelId: '222222222222222222',
      messageId: '333333333333333333',
      bait: 'x',
      action: 'kick',
    };
    await setGuildModule(KEY, 'honeypot', { enabled: true, config: { messages: [trap] } });
    const fHoney = await page(KEY, 'honeypot');
    assert.match(
      fHoney,
      new RegExp(`href="https://web.fluxer.app/channels/${RAW}/222222222222222222/333333333333333333"`)
    );
    assert.doesNotMatch(fHoney, /discord\.com\/channels/);

    // The V2 API carries the prefix and the web app address for links.
    assert.equal(f.commandPrefix, '!');
    assert.equal(d.commandPrefix, '/');

    const dAutomod = await page(app.guild.id, 'automod');
    assert.doesNotMatch(dAutomod, /Fluxer has no native AutoMod/);
    assert.match(dAutomod, /Native Discord AutoMod/);
  } finally {
    runtime.clients.fluxer = null;
    app.close();
  }
});
