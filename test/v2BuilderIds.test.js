// Starboards and voice hubs saved from the new dashboard: a removed starboard forgets its posts, and a
// new board or hub never takes over the id of one that stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, startOAuthApp } from './helpers/oauthApp.js';
import { adminApi } from './helpers/v2Admin.js';

await startOAuthApp();

const { getGuildModule, setGuildModule } = await import('../src/db/modules.js');
const { getStarboardEntry, upsertStarboardEntry } = await import('../src/db/starboard.js');
const { withRowIds } = await import('../src/web/lib/rowIds.js');

const CHANNEL = '100000000000000001';

// --- starboard ---------------------------------------------------------------

const board = (extra = {}) => ({ name: 'Stars', channelId: CHANNEL, emojis: '⭐', threshold: 3, ...extra });

test('removing a starboard also forgets the posts it made, and leaves the other boards alone', async () => {
  await setGuildModule(D_GUILD, 'starboard', {
    enabled: true,
    config: { boards: [board({ id: '111' }), board({ id: '222' })] },
  });
  const entry = (boardId) => ({
    guildId: D_GUILD,
    boardId,
    sourceMsgId: `msg-${boardId}`,
    sourceChanId: CHANNEL,
    postMsgId: `post-${boardId}`,
    starCount: 4,
  });
  await upsertStarboardEntry(entry('111'));
  await upsertStarboardEntry(entry('222'));

  const { api } = await adminApi();
  const res = await api('/modules/starboard/config', {
    boards: [board({ id: '222' })],
    removedBoardIds: ['111'],
  });
  assert.equal(res.status, 200);

  assert.equal(await getStarboardEntry(D_GUILD, '111', 'msg-111'), null);
  assert.ok(await getStarboardEntry(D_GUILD, '222', 'msg-222'));
});

test('a new starboard added after another was removed does not reuse a board id', async () => {
  await setGuildModule(D_GUILD, 'starboard', { enabled: true, config: { boards: [] } });
  const { api } = await adminApi();
  // Two boards saved without ids (what the new dashboard sends for a new board)...
  let res = await api('/modules/starboard/config', { boards: [board(), board()] });
  const first = (await res.json()).config.boards.map((x) => x.id);
  assert.equal(new Set(first).size, 2);
  // ...then the first goes away and a new one is added: its id must differ from the one that stays.
  res = await api('/modules/starboard/config', {
    boards: [board({ id: first[1] }), board({ name: 'More stars' })],
  });
  const second = (await res.json()).config.boards.map((x) => x.id);
  assert.equal(second[0], first[1]);
  assert.notEqual(second[1], second[0]);
  assert.equal((await getGuildModule(D_GUILD, 'starboard')).config.boards.length, 2);
});

// --- voice hubs ---------------------------------------------------------------

test('new voice hubs get ids of their own', async () => {
  await setGuildModule(D_GUILD, 'temp-voice', { enabled: true, config: { hubs: [] } });
  const { api } = await adminApi();
  const hub = (hubChannelId, id) => ({ hubChannelId, ...(id ? { id } : {}) });
  let res = await api('/modules/temp-voice/config', {
    hubs: [hub('100000000000000011'), hub('100000000000000012')],
  });
  const first = (await res.json()).config.hubs.map((h) => h.id);
  assert.equal(new Set(first).size, 2);
  res = await api('/modules/temp-voice/config', {
    hubs: [hub('100000000000000012', first[1]), hub('100000000000000013')],
  });
  const second = (await res.json()).config.hubs.map((h) => h.id);
  assert.notEqual(second[0], second[1]);
  assert.equal(second[0], first[1]);
});

test('withRowIds keeps numeric ids once, and re-ids repeats and rows without one', () => {
  const rows = withRowIds([{ id: '7' }, { id: '7' }, {}, { id: 'abc' }, null], 1000);
  const ids = rows.map((r) => r.id);
  assert.equal(ids[0], '7');
  assert.equal(new Set(ids).size, 5);
  assert.ok(ids.every((id) => /^\d+$/.test(id)));
  assert.deepEqual(withRowIds(undefined), []);
});
