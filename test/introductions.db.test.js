// Introductions storage, and how the erasure paths treat it: the guild-leave purge, /forget and the
// /mydata export (db/purge.js).
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, MIGRATIONS, SCHEMA_VERSION } from '../src/db/index.js';
import {
  answersOf,
  clearIntroductionMessage,
  deleteIntroduction,
  getIntroduction,
  getIntroductionByMessage,
  introductionCount,
  saveIntroduction,
} from '../src/db/introductions.js';
import { GUILD_TABLES, describeUserData, exportUserData, forgetUser, purgeGuild } from '../src/db/purge.js';
import { forgetIntroductionCard, postIntroduction } from '../src/modules/introductions.js';
import { setGuildModule } from '../src/db/modules.js';
import { GID, INTRO_CH, dropFakeClient, fakeIntroGuild, fakeMember } from './helpers/fakeIntro.js';

const G = '900000000000000401';
const H = '900000000000000402';
const U = '700000000000000030';
const V = '700000000000000031';
const row = (over = {}) => ({
  guildId: G,
  userId: U,
  channelId: 'c1',
  messageId: 'm1',
  answers: { a: '1' },
  ...over,
});

beforeEach(async () => {
  for (const g of [G, H, GID]) await purgeGuild(g);
});
afterEach(() => dropFakeClient());

test('the table exists with the columns and the primary key of the design', () => {
  const columns = db.prepare('PRAGMA table_info(introductions)').all();
  assert.deepEqual(
    columns.map((c) => c.name),
    ['guild_id', 'user_id', 'channel_id', 'message_id', 'answers', 'created_at', 'updated_at']
  );
  assert.equal(columns.find((c) => c.name === 'message_id').notnull, 0, 'the message id may be empty');
  assert.deepEqual(
    columns.filter((c) => c.pk).map((c) => c.name),
    ['guild_id', 'user_id']
  );
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length);
  assert.ok(GUILD_TABLES.includes('introductions'));
});

test("save, read, and replace a member's introduction (one row per member and server)", async () => {
  assert.equal(await getIntroduction(G, U), null);
  await saveIntroduction(row());
  const first = await getIntroduction(G, U);
  assert.deepEqual(answersOf(first), { a: '1' });
  assert.equal(first.channel_id, 'c1');
  assert.equal(first.message_id, 'm1');
  assert.equal(typeof first.created_at, 'number');

  await new Promise((r) => setTimeout(r, 5));
  await saveIntroduction(row({ messageId: 'm2', answers: { a: '2' } }));
  const second = await getIntroduction(G, U);
  assert.equal(second.message_id, 'm2');
  assert.deepEqual(answersOf(second), { a: '2' });
  assert.equal(second.created_at, first.created_at, 'the creation time stays');
  assert.ok(second.updated_at > first.updated_at);
  assert.equal(await introductionCount(G), 1);

  await saveIntroduction(row({ guildId: H }));
  assert.equal(await introductionCount(H), 1, 'another server has its own');
  await saveIntroduction(row({ userId: V }));
  assert.equal(await introductionCount(G), 2);
});

test('look up by card message, forget the message but keep the answers, delete', async () => {
  await saveIntroduction(row());
  assert.equal((await getIntroductionByMessage(G, 'm1')).user_id, U);
  assert.equal(await getIntroductionByMessage(H, 'm1'), null);
  assert.equal(await clearIntroductionMessage(G, U), 1);
  const cleared = await getIntroduction(G, U);
  assert.equal(cleared.message_id, null);
  assert.deepEqual(answersOf(cleared), { a: '1' });
  assert.equal(await deleteIntroduction(G, U), 1);
  assert.equal(await deleteIntroduction(G, U), 0);
});

test('a damaged answers value reads as no answers', () => {
  assert.deepEqual(answersOf({ answers: '{nope' }), {});
  assert.deepEqual(answersOf({ answers: '[1,2]' }), {});
  assert.deepEqual(answersOf({ answers: 'null' }), {});
  assert.deepEqual(answersOf(null), {});
});

test("the guild-leave purge removes every introduction of the server, and only that server's", async () => {
  await saveIntroduction(row());
  await saveIntroduction(row({ userId: V }));
  await saveIntroduction(row({ guildId: H }));
  await purgeGuild(G);
  assert.equal(await introductionCount(G), 0);
  assert.equal(await introductionCount(H), 1);
});

test("/forget removes the member's introduction and says how many", async () => {
  await saveIntroduction(row());
  await saveIntroduction(row({ userId: V }));
  const result = await forgetUser(G, U);
  assert.equal(result.introductions, 1);
  assert.equal(await getIntroduction(G, U), null);
  assert.ok(await getIntroduction(G, V), 'someone else is untouched');
  assert.equal((await forgetUser(G, U)).introductions, 0);
});

test('the member data page and the export list the introduction, answers included', async () => {
  await saveIntroduction(row({ answers: { about: 'Hello' } }));
  const summary = await describeUserData(G, U);
  const item = summary.items.find((i) => i.key === 'introductions');
  assert.equal(item.count, 1);
  assert.equal(item.kept, false);
  assert.ok(summary.erasable >= 1);
  const exported = await exportUserData(G, U);
  assert.equal(exported.data.introductions.length, 1);
  assert.deepEqual(answersOf(exported.data.introductions[0]), { about: 'Hello' });
  assert.deepEqual((await exportUserData(G, V)).data.introductions, []);
});

test('/forget also deletes the card message from the channel', async () => {
  const env = fakeIntroGuild();
  await setGuildModule(GID, 'introductions', { enabled: true, config: { channelId: INTRO_CH } });
  fakeMember(env.guild, U);
  const posted = await postIntroduction({ guild: env.guild, userId: U, answers: { about: 'Erase me' } });
  assert.equal(env.channel.store.has(posted.messageId), true);
  await forgetIntroductionCard(env.guild, U);
  assert.equal(env.channel.store.has(posted.messageId), false, 'the message is gone');
  await forgetUser(GID, U);
  assert.equal(await getIntroduction(GID, U), null);
});

test('forgetting a member with no card, or whose channel is gone, does not throw', async () => {
  const env = fakeIntroGuild();
  await forgetIntroductionCard(env.guild, U);
  await saveIntroduction({
    guildId: GID,
    userId: U,
    channelId: '100000000000009999',
    messageId: 'x',
    answers: {},
  });
  await forgetIntroductionCard(env.guild, U);
});
