// Saving the Starboard module in the new dashboard never deletes a board's post records by
// guessing from what is missing: only boards the form names in `removedBoardIds` lose theirs.
import { startWebApp } from './helpers/webApp.js';
import { CH, GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getStarboardEntry, upsertStarboardEntry } from '../src/db/starboard.js';
import { getGuildModule } from '../src/db/modules.js';

let app;
test.before(async () => {
  app = await startWebApp();
});
test.after(() => app.close());

const json = { accept: 'application/json', 'content-type': 'application/json' };
const starboardUrl = () => `${app.base}/api/v2/guilds/${GID}/modules/starboard/config`;
const save = (body) => fetch(starboardUrl(), { method: 'POST', headers: json, body: JSON.stringify(body) });
const board = (id, name = id) => ({ id, name, channelId: CH.announce, emojis: '⭐', threshold: 3 });

async function seed(...boardIds) {
  for (const boardId of boardIds) {
    await upsertStarboardEntry({
      guildId: GID,
      boardId,
      sourceMsgId: '700000000000000001',
      sourceChanId: CH.general,
      postMsgId: '700000000000000002',
      starCount: 5,
    });
  }
}
const hasEntry = async (boardId) => Boolean(await getStarboardEntry(GID, boardId, '700000000000000001'));
const savedIds = async () => ((await getGuildModule(GID, 'starboard')).config.boards ?? []).map((b) => b.id);

test('a save without a board list is refused and deletes nothing', async () => {
  const first = await save({ boards: [board('101'), board('102')] });
  assert.equal(first.status, 200);
  await seed('101', '102');

  for (const body of [{}, { removedBoardIds: ['101', '102'] }, { boards: 'nope' }, { boards: null }]) {
    const res = await save(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(await savedIds(), ['101', '102'], 'the boards are untouched');
  assert.ok(await hasEntry('101'));
  assert.ok(await hasEntry('102'));
});

test('a stale save without removedBoardIds keeps the records of a board missing from its list', async () => {
  await save({ boards: [board('101'), board('102')] });
  await seed('101', '102');

  const res = await save({ boards: [board('101')] });
  assert.equal(res.status, 200);
  assert.deepEqual(await savedIds(), ['101'], 'the list is saved as sent');
  assert.ok(await hasEntry('101'));
  assert.ok(await hasEntry('102'), 'the missing board keeps its records');

  // An empty list saves too, and still deletes nothing.
  assert.equal((await save({ boards: [] })).status, 200);
  assert.ok(await hasEntry('101'));
  assert.ok(await hasEntry('102'));
});

test("naming a board in removedBoardIds deletes only that board's records", async () => {
  await save({ boards: [board('101'), board('102'), board('103')] });
  await seed('101', '102', '103');

  const res = await save({ boards: [board('101'), board('103')], removedBoardIds: ['102'] });
  assert.equal(res.status, 200);
  assert.deepEqual(await savedIds(), ['101', '103']);
  assert.ok(await hasEntry('101'));
  assert.ok(!(await hasEntry('102')), 'the removed board lost its records');
  assert.ok(await hasEntry('103'));
});

test('a board named in removedBoardIds but still in the list keeps its records', async () => {
  await save({ boards: [board('101'), board('102')] });
  await seed('101', '102');

  const res = await save({ boards: [board('101'), board('102')], removedBoardIds: ['102', 5, null] });
  assert.equal(res.status, 200);
  assert.ok(await hasEntry('101'));
  assert.ok(await hasEntry('102'));
});
