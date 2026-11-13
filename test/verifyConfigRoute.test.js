// Saving the verification settings with another channel moves the verify message: the config of an
// older version has no messageChannelId, so the channel it had before the save is where the message is.
import { startWebApp } from './helpers/webApp.js';
import { v2Open } from './helpers/v2Open.js';
import { GID, ROLE } from './helpers/fakeGuild.js';
import { fakeChannel } from './helpers/fakeIntro.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';

// Distinct id prefixes: the fake channel makes its message ids from them.
const OLD = '101000000000000001';
const NEW = '102000000000000002';

let app;
test.before(async () => {
  app = await startWebApp();
});
test.after(() => app.close());

const waitFor = async (check) => {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

test('a settings save with another channel moves the verify message of an older config', async () => {
  const oldChannel = fakeChannel(OLD, 'general');
  const newChannel = fakeChannel(NEW, 'bots');
  app.guild.channels.cache.set(OLD, oldChannel);
  app.guild.channels.cache.set(NEW, newChannel);
  const old = await oldChannel.send({ content: 'verify' });
  await setGuildModule(GID, 'verification', {
    enabled: true,
    config: { mode: 'button', verifiedRoleId: ROLE.member, channelId: OLD, messageId: old.id },
  });

  const res = await v2Open(app, GID).post('/modules/verification/config', {
    mode: 'button',
    verifiedRoleId: ROLE.member,
    channelId: NEW,
  });
  assert.equal(res.status, 200);
  assert.ok(
    await waitFor(async () => (await getGuildModule(GID, 'verification')).config.messageChannelId === NEW),
    'the message is posted in the new channel'
  );
  const now = (await getGuildModule(GID, 'verification')).config;
  assert.notEqual(now.messageId, old.id);
  assert.deepEqual([...newChannel.store.keys()], [now.messageId]);
  assert.ok(await waitFor(() => oldChannel.store.size === 0), 'the old message is deleted');
});
