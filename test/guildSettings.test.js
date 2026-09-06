import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EMBED_COLOR,
  getGuildSettings,
  setModlogChannel,
  getBotMasterRoles,
  setBotMasterRoles,
  setEmbedColor,
  guildEmbedColor,
  deleteGuildSettings,
} from '../src/db/guildSettings.js';

const G = '900000000000000060';

test('getGuildSettings is undefined before any write; setModlogChannel creates the row', async () => {
  assert.equal(await getGuildSettings(G), undefined);
  await setModlogChannel(G, '111111111111111111');
  const s = await getGuildSettings(G);
  assert.equal(s.modlog_channel_id, '111111111111111111');

  await setModlogChannel(G, null);
  assert.equal((await getGuildSettings(G)).modlog_channel_id, null);
});

test('bot master roles: defaults to [], round-trips, dedupes + caps at 25, rejects bad ids', async () => {
  assert.deepEqual(await getBotMasterRoles(G), []);
  const clean = await setBotMasterRoles(G, [
    '222222222222222222',
    '222222222222222222',
    'not-an-id',
    '333333333333333333',
  ]);
  assert.deepEqual(clean, ['222222222222222222', '333333333333333333']);
  assert.deepEqual(await getBotMasterRoles(G), ['222222222222222222', '333333333333333333']);

  const many = Array.from({ length: 30 }, (_, i) => String(100000000000000000n + BigInt(i)));
  const capped = await setBotMasterRoles(G, many);
  assert.equal(capped.length, 25);
});

test('embed colour: defaults to DEFAULT_EMBED_COLOR, round-trips, null clears it', async () => {
  assert.equal(await guildEmbedColor(G), DEFAULT_EMBED_COLOR);
  await setEmbedColor(G, 0xff00ff);
  assert.equal(await guildEmbedColor(G), 0xff00ff);
  await setEmbedColor(G, null);
  assert.equal(await guildEmbedColor(G), DEFAULT_EMBED_COLOR);
});

test('deleteGuildSettings removes the row', async () => {
  await setModlogChannel(G, '111111111111111111');
  await deleteGuildSettings(G);
  assert.equal(await getGuildSettings(G), undefined);
});
