import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bumpHoneypotStat } from '../src/modules/honeypot.js';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';

const GUILD_ID = '900000000000000030';
const CHANNEL_ID = '100000000000000900';

test('bumpHoneypotStat: two concurrent bumps on the same row both count (no lost update)', async () => {
  await setGuildModule(GUILD_ID, 'honeypot', {
    config: { channels: [{ channelId: CHANNEL_ID, action: 'ban', triggerCount: 0 }], messages: [] },
  });

  const guild = { id: GUILD_ID };
  // Fired without awaiting either individually, like two near-simultaneous
  // triggers would — before the queueing fix, both could read triggerCount=0
  // before either wrote, losing one of the two increments.
  await Promise.all([
    bumpHoneypotStat(guild, 'channels', CHANNEL_ID),
    bumpHoneypotStat(guild, 'channels', CHANNEL_ID),
  ]);

  const { config } = await getGuildModule(GUILD_ID, 'honeypot');
  assert.equal(config.channels[0].triggerCount, 2);
});

test('bumpHoneypotStat: ten concurrent bumps all count', async () => {
  const channelId = CHANNEL_ID + '1';
  await setGuildModule(GUILD_ID, 'honeypot', {
    config: {
      channels: [
        { channelId: CHANNEL_ID, action: 'ban', triggerCount: 2 },
        { channelId, action: 'ban', triggerCount: 0 },
      ],
      messages: [],
    },
  });

  const guild = { id: GUILD_ID };
  await Promise.all(Array.from({ length: 10 }, () => bumpHoneypotStat(guild, 'channels', channelId)));

  const { config } = await getGuildModule(GUILD_ID, 'honeypot');
  assert.equal(config.channels.find((r) => r.channelId === channelId).triggerCount, 10);
  // The other row's count is untouched by the unrelated bumps.
  assert.equal(config.channels.find((r) => r.channelId === CHANNEL_ID).triggerCount, 2);
});
