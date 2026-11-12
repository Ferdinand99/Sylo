// A card that cannot be edited or deleted for a reason other than "it is gone" must never be
// mistaken for a deleted one: no second card, no row deleted while the card is still public.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetIntroductions,
  forgetIntroductionCard,
  postIntroduction,
  publishPrompt,
  refreshIntroduction,
  removeIntroduction,
  unpublishPrompt,
} from '../src/modules/introductions.js';
import { dispatch } from '../src/modules/dispatch.js';
import { setGuildModule } from '../src/db/modules.js';
import { answersOf, getIntroduction } from '../src/db/introductions.js';
import { forgetUser, purgeGuild } from '../src/db/purge.js';
import {
  GID,
  INTRO_CH,
  ROLE,
  dropFakeClient,
  fakeIntroGuild,
  fakeMember,
  missingAccess,
  serverError,
  unknownMessage,
} from './helpers/fakeIntro.js';

const U = '700000000000000050';

let env;
beforeEach(async () => {
  _resetIntroductions();
  await purgeGuild(GID);
  env = fakeIntroGuild();
  await setGuildModule(GID, 'introductions', { enabled: true, config: { channelId: INTRO_CH } });
});
afterEach(() => dropFakeClient());

const post = (answers = { about: 'Hi' }) => postIntroduction({ guild: env.guild, userId: U, answers });

test('the channel permission check asks for Read Message History too', async () => {
  fakeMember(env.guild, U);
  await post();
  assert.ok(env.channel.asked.includes('ReadMessageHistory'));
  assert.ok(env.channel.asked.includes('SendMessages'));
});

test('an edit that fails for a reason other than "gone" posts no second card and keeps the row', async () => {
  fakeMember(env.guild, U);
  const first = await post({ about: 'One' });
  for (const [error, wording] of [
    [serverError(), /right now/],
    [missingAccess(), /check my permissions/],
    [Object.assign(new Error('timeout'), { name: 'AbortError' }), /right now/],
  ]) {
    env.channel.failWith = error;
    const result = await post({ about: 'Two' });
    assert.equal(result.ok, false);
    assert.match(result.error, wording);
  }
  env.channel.failWith = null;
  assert.equal(env.channel.log.sent.length, 1, 'still one card');
  const row = await getIntroduction(GID, U);
  assert.equal(row.message_id, first.messageId, 'the row still points at the card');
  assert.deepEqual(answersOf(row), { about: 'One' });
  const again = await post({ about: 'Two' });
  assert.equal(again.edited, true, 'and a later edit works');
});

test('only "gone" reposts: the platform shapes of Discord and Fluxer both count', async () => {
  fakeMember(env.guild, U);
  const gone = [
    unknownMessage(),
    Object.assign(new Error('Unknown Channel'), { code: 10003 }),
    Object.assign(new Error('not found'), { statusCode: 404 }),
    Object.assign(new Error('lookup failed'), { cause: Object.assign(new Error('x'), { statusCode: 404 }) }),
    Object.assign(new Error('x'), { code: 'UNKNOWN_MESSAGE' }),
  ];
  let sent = 0;
  await post();
  for (const error of gone) {
    env.channel.failWith = error;
    const result = await post();
    assert.equal(result.ok, true, error.message);
    assert.equal(result.edited, false, 'a new card');
    sent += 1;
    assert.equal(env.channel.log.sent.length, 1 + sent);
  }
});

test('removing: a failed delete keeps the row and says so; it works once the channel answers again', async () => {
  fakeMember(env.guild, U);
  const posted = await post();
  env.channel.failWith = serverError();
  assert.equal(await removeIntroduction(env.guild, U), 'failed');
  assert.ok(await getIntroduction(GID, U), 'the row stays');
  assert.equal(env.channel.store.has(posted.messageId), true, 'and so does the card');
  env.channel.failWith = null;
  assert.equal(await removeIntroduction(env.guild, U), 'removed');
  assert.equal(await getIntroduction(GID, U), null);
  assert.equal(env.channel.store.has(posted.messageId), false);
});

test('removing a card that is already gone deletes the row', async () => {
  fakeMember(env.guild, U);
  const posted = await post();
  env.channel.store.delete(posted.messageId);
  assert.equal(await removeIntroduction(env.guild, U), 'removed');
  assert.equal(await getIntroduction(GID, U), null);
});

test('a card in a channel that no longer exists is gone too', async () => {
  fakeMember(env.guild, U);
  await post();
  env.guild.channels.cache.delete(INTRO_CH);
  assert.equal(await removeIntroduction(env.guild, U), 'removed');
});

test('a member who leaves: the row stays while the card cannot be deleted', async () => {
  fakeMember(env.guild, U);
  const member = env.guild.members.cache.get(U);
  await post();
  env.channel.failWith = serverError();
  await dispatch('guildMemberRemove', GID, member);
  assert.ok(await getIntroduction(GID, U));
  env.channel.failWith = null;
  await dispatch('guildMemberRemove', GID, member);
  assert.equal(await getIntroduction(GID, U), null);
});

test('/forget keeps the row when the card message cannot be deleted', async () => {
  fakeMember(env.guild, U);
  const posted = await post({ about: 'Erase me' });
  env.channel.failWith = missingAccess();
  const card = await forgetIntroductionCard(env.guild, U);
  assert.equal(card.ok, false);
  const result = await forgetUser(GID, U, { keepIntroduction: !card.ok });
  assert.equal(result.introductions, 0);
  assert.ok(await getIntroduction(GID, U), 'the row is what lets the card be removed later');
  env.channel.failWith = null;
  const again = await forgetIntroductionCard(env.guild, U);
  assert.equal(again.ok, true);
  assert.equal((await forgetUser(GID, U, { keepIntroduction: !again.ok })).introductions, 1);
  assert.equal(env.channel.store.has(posted.messageId), false);
});

test('a refresh that fails for another reason leaves the card alone and rejects', async () => {
  await setGuildModule(GID, 'introductions', {
    config: { channelId: INTRO_CH, roleGroups: [{ name: 'Country', roleIds: [ROLE.norway] }] },
  });
  const member = fakeMember(env.guild, U);
  await post();
  member.roles.cache.set(ROLE.norway, env.guild.roles.cache.get(ROLE.norway));
  env.channel.failWith = serverError();
  await assert.rejects(refreshIntroduction(GID, U), /Internal Server Error/);
  assert.equal(env.channel.log.edits.length, 0);
  env.channel.failWith = null;
  await refreshIntroduction(GID, U);
  assert.equal(env.channel.log.edits.length, 1, 'the next refresh still sees the change');
});

// --- the prompt ----------------------------------------------------------------------------------------------

const promptCfg = (over = {}) => ({
  channelId: INTRO_CH,
  promptText: 'Hi',
  promptChannelId: '',
  promptMessageId: '',
  ...over,
});

test('the prompt is edited by id; only "gone" posts a new one', async () => {
  const first = await publishPrompt(env.guild, promptCfg());
  assert.equal(first.ok, true);
  const second = await publishPrompt(
    env.guild,
    promptCfg({ promptChannelId: INTRO_CH, promptMessageId: first.messageId, promptText: 'New' })
  );
  assert.equal(second.messageId, first.messageId);
  assert.equal(env.channel.log.sent.length, 1);

  env.channel.failWith = serverError();
  const failed = await publishPrompt(
    env.guild,
    promptCfg({ promptChannelId: INTRO_CH, promptMessageId: first.messageId })
  );
  assert.equal(failed.ok, false);
  assert.equal(env.channel.log.sent.length, 1, 'no second prompt');

  env.channel.failWith = null;
  env.channel.store.delete(first.messageId);
  const third = await publishPrompt(
    env.guild,
    promptCfg({ promptChannelId: INTRO_CH, promptMessageId: first.messageId })
  );
  assert.equal(third.ok, true);
  assert.notEqual(third.messageId, first.messageId);
});

test('unpublishing: ok when deleted or gone, an error (and the id kept by the caller) otherwise', async () => {
  const published = await publishPrompt(env.guild, promptCfg());
  const cfg = promptCfg({ promptChannelId: INTRO_CH, promptMessageId: published.messageId });
  env.channel.failWith = missingAccess();
  const denied = await unpublishPrompt(env.guild, cfg);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /Manage Messages/);
  env.channel.failWith = serverError();
  assert.match((await unpublishPrompt(env.guild, cfg)).error, /right now/);
  env.channel.failWith = null;
  assert.deepEqual(await unpublishPrompt(env.guild, cfg), { ok: true });
  assert.deepEqual(await unpublishPrompt(env.guild, cfg), { ok: true }, 'already gone');
  assert.deepEqual(await unpublishPrompt(env.guild, promptCfg()), { ok: true }, 'nothing published');
});
