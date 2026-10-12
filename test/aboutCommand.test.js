import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { BUILD } from '../src/bot/lib/buildInfo.js';
import { execute } from '../src/bot/commands/about.js';

const fakeClient = () => ({
  ws: { ping: 3 },
  guilds: { cache: { size: 2 } },
  user: { displayAvatarURL: () => 'https://example.test/a.png' },
});

async function aboutEmbed(client) {
  let sent;
  await execute({ client, reply: async (p) => (sent = p) });
  return sent.embeds[0].toJSON();
}
const field = (embed, name) => embed.fields.find((f) => f.name === name).value;

test.afterEach(() => {
  runtime.clients.fluxer = null;
});

test('on Discord it names discord.js', async () => {
  const embed = await aboutEmbed(fakeClient());
  assert.match(embed.description, /Discord bot/);
  assert.ok(field(embed, 'Runtime').includes(`discord.js ${BUILD.discordJs}`));
});

test('on Fluxer it names Fluxer and its SDK version, not discord.js', async () => {
  const client = fakeClient();
  runtime.clients.fluxer = client;
  const embed = await aboutEmbed(client);
  assert.match(embed.description, /Fluxer bot/);
  assert.match(field(embed, 'Runtime'), /fluxer\.js \d+\.\d+\.\d+/);
  assert.doesNotMatch(field(embed, 'Runtime'), /discord\.js/);
});

test('BUILD carries the Fluxer SDK version', () => {
  assert.match(BUILD.fluxerJs, /^\d+\.\d+\.\d+/);
});
