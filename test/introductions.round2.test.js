// Introductions, fix round 2: answers erased when a card cannot be deleted, cancel while Post runs,
// sessions that end when they cannot succeed any more, the late-answer notice, a validate that
// throws, and a channel lookup that fails while publishing.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { register as registerDmTickets } from '../src/bot/events/dmTickets.js';
import {
  _resetQuestionnaires,
  cancelQuestionnaire,
  cancelQuestionnairesOf,
  handleQuestionnaireMessage,
  hasActiveQuestionnaire,
  startQuestionnaire,
} from '../src/bot/lib/dmQuestionnaire.js';
import { routeComponent } from '../src/bot/lib/components.js';
import { execute } from '../src/bot/commands/intro.js';
import {
  _resetIntroductions,
  cancelIntroductionSessions,
  forgetIntroductionCard,
  postIntroduction,
  publishPrompt,
  removeIntroduction,
} from '../src/modules/introductions.js';
import { dispatch } from '../src/modules/dispatch.js';
import { setGuildModule } from '../src/db/modules.js';
import { answersOf, getIntroduction } from '../src/db/introductions.js';
import { getOpenTicket } from '../src/db/tickets.js';
import { forgetUser, purgeGuild } from '../src/db/purge.js';
import { log } from '../src/lib/log.js';
import { runtime } from '../src/runtime.js';
import {
  GID,
  INTRO_CH,
  dropFakeClient,
  fakeIntroGuild,
  fakeMember,
  serverError,
} from './helpers/fakeIntro.js';

const U = '700000000000000060';

let env;
beforeEach(async () => {
  _resetQuestionnaires();
  _resetIntroductions();
  await purgeGuild(GID);
  env = fakeIntroGuild();
  await setGuildModule(GID, 'introductions', { enabled: true, config: { channelId: INTRO_CH } });
});
afterEach(() => {
  dropFakeClient();
  runtime.clients.fluxer = null;
});

const post = (answers = { about: 'Secret about me' }) =>
  postIntroduction({ guild: env.guild, userId: U, answers });

function dmFor(member) {
  const sent = member.user.dms;
  const channel = { send: async (payload) => sent.push(payload) && { channel } };
  member.user.send = async (payload) => sent.push(payload) && { channel };
  const say = (content) =>
    handleQuestionnaireMessage({ author: member.user, content, client: env.client, channel });
  return { sent, channel, say };
}

function interactionFor(member, sub) {
  const replies = [];
  return {
    replies,
    guild: env.guild,
    guildId: GID,
    user: member.user,
    member,
    memberPermissions: { has: () => false },
    options: { getSubcommand: () => sub, getUser: () => null },
    deferReply: async () => {},
    reply: async (payload) => replies.push(payload),
    editReply: async (payload) => replies.push(payload),
  };
}

function press(customId, user) {
  const log = { edits: [], updates: [] };
  return {
    log,
    interaction: {
      customId,
      user,
      client: env.client,
      isRepliable: () => true,
      update: async (payload) => log.updates.push(payload),
      message: { edit: async (payload) => log.edits.push(payload) },
    },
  };
}

const buttonId = (payload, index) => payload.components[0].toJSON().components[index].custom_id;
const ONE_QUESTION = [{ id: 'about', label: 'About', required: true, maxLength: 50 }];

// --- N1: answers are erased even when the card cannot be deleted ------------------------------------

test('/forget with a card that cannot be deleted erases the answers and keeps the pointer', async () => {
  fakeMember(env.guild, U);
  const posted = await post();
  env.channel.failWith = serverError();
  const card = await forgetIntroductionCard(env.guild, U);
  assert.equal(card.ok, false);
  await forgetUser(GID, U, { keepIntroduction: !card.ok });
  const row = await getIntroduction(GID, U);
  assert.deepEqual(answersOf(row), {}, 'no answers left in the database');
  assert.equal(row.channel_id, INTRO_CH);
  assert.equal(row.message_id, posted.messageId, 'the pointer survives, so the card can be deleted later');
  env.channel.failWith = null;
  assert.equal(await removeIntroduction(env.guild, U), 'removed');
  assert.equal(env.channel.store.has(posted.messageId), false);
});

test('a failed delete in /intro remove or on leave also erases the answers', async () => {
  const member = fakeMember(env.guild, U);
  const posted = await post();
  env.channel.failWith = serverError();
  assert.equal(await removeIntroduction(env.guild, U), 'failed');
  let row = await getIntroduction(GID, U);
  assert.deepEqual(answersOf(row), {});
  assert.equal(row.message_id, posted.messageId);

  env.channel.failWith = null;
  await post({ about: 'Again' });
  env.channel.failWith = serverError();
  await dispatch('guildMemberRemove', GID, member);
  row = await getIntroduction(GID, U);
  assert.deepEqual(answersOf(row), {});
  assert.equal(row.message_id, posted.messageId);
});

// --- N2: cancel while Post runs ---------------------------------------------------------------------------

test('a cancel while Post runs is refused, the post goes through and the member is not told nothing changed', async () => {
  const dm = { sent: [] };
  const channel = { send: async (payload) => dm.sent.push(payload) && { channel } };
  const user = { id: U, send: async (payload) => dm.sent.push(payload) && { channel } };
  const say = (content) => handleQuestionnaireMessage({ author: user, content, client: env.client, channel });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let completed = 0;
  await startQuestionnaire({
    user,
    questions: ONE_QUESTION,
    review: () => ({ embeds: [{ description: 'preview' }] }),
    onComplete: async () => {
      await gate;
      completed += 1;
      return 'Posted!';
    },
  });
  await say('hello');
  const click = press(buttonId(dm.sent.at(-1), 0), user);
  const running = routeComponent(click.interaction);
  await new Promise((r) => setTimeout(r, 10));
  await say('cancel');
  assert.match(dm.sent.at(-1).content, /already being completed, so it is too late to cancel/);
  assert.equal(cancelQuestionnaire(U, 'left'), false, 'and not from outside either');
  assert.equal(cancelQuestionnairesOf('nothing'), false);
  assert.equal(hasActiveQuestionnaire('discord', U), true);
  release();
  await running;
  assert.equal(completed, 1);
  assert.equal(click.log.edits.at(-1).content, 'Posted!');
  assert.ok(!dm.sent.some((m) => /Nothing was changed/.test(m.content ?? '')));
});

// --- N3: a failure that cannot be fixed ends the session ------------------------------------------------

test('{ ok: false, final: true } ends the session with the message', async () => {
  const sent = [];
  const channel = { send: async (payload) => sent.push(payload) && { channel } };
  const user = { id: U, send: async (payload) => sent.push(payload) && { channel } };
  await startQuestionnaire({
    user,
    questions: ONE_QUESTION,
    onComplete: async () => ({ ok: false, message: 'This is over.', final: true }),
  });
  await handleQuestionnaireMessage({ author: user, content: 'hi', client: env.client, channel });
  assert.equal(sent.at(-1).content, 'This is over.');
  assert.equal(hasActiveQuestionnaire('discord', U), false);
});

test('Post after the module was switched off ends the session instead of offering Post again', async () => {
  const member = fakeMember(env.guild, U);
  const dm = dmFor(member);
  await setGuildModule(GID, 'introductions', {
    config: { channelId: INTRO_CH, questions: ONE_QUESTION },
  });
  await execute(interactionFor(member, 'create'));
  await dm.say('hi there');
  await setGuildModule(GID, 'introductions', { enabled: false });
  const click = press(buttonId(dm.sent.at(-1), 0), member.user);
  await routeComponent(click.interaction);
  assert.match(click.log.edits.at(-1).content, /off in this server/);
  assert.equal(hasActiveQuestionnaire('discord', U), false);
});

test('a member who leaves loses their running questionnaire for that server', async () => {
  const member = fakeMember(env.guild, U);
  dmFor(member);
  await execute(interactionFor(member, 'create'));
  assert.equal(hasActiveQuestionnaire('discord', U), true);
  await dispatch('guildMemberRemove', GID, member);
  assert.equal(hasActiveQuestionnaire('discord', U), false);
});

test('a member who leaves keeps a questionnaire for another server', async () => {
  const member = fakeMember(env.guild, U);
  dmFor(member);
  await startQuestionnaire({
    user: member.user,
    questions: ONE_QUESTION,
    scope: 'introductions:another-server',
    onComplete: async () => {},
  });
  await dispatch('guildMemberRemove', GID, member);
  assert.equal(hasActiveQuestionnaire('discord', U), true, 'its scope is another server');
});

test('switching the module off ends every running questionnaire of that server', async () => {
  const mira = fakeMember(env.guild, U);
  const sam = fakeMember(env.guild, '700000000000000061');
  dmFor(mira);
  dmFor(sam);
  await execute(interactionFor(mira, 'create'));
  await execute(interactionFor(sam, 'create'));
  assert.equal(cancelIntroductionSessions(GID), true);
  assert.equal(hasActiveQuestionnaire('discord', U), false);
  assert.equal(hasActiveQuestionnaire('discord', sam.id), false);
  assert.equal(cancelIntroductionSessions(GID), false);
  assert.match(mira.user.dms.at(-1).content, /questionnaire was stopped/);
});

// --- N4: the late-answer notice -------------------------------------------------------------------------

function dmMessage(member, content, channel, history, client = env.client) {
  const replies = [];
  const reactions = [];
  return {
    replies,
    reactions,
    message: {
      id: '900000000000000999',
      guild: null,
      partial: false,
      content,
      author: Object.assign(member.user, { bot: false, tag: 'mira#0001' }),
      attachments: new Map(),
      client,
      channel: { ...channel, messages: { fetch: async () => new Map(history.map((m) => [m.id, m])) } },
      reply: async (payload) => replies.push(payload),
      react: async (emoji) => reactions.push(emoji),
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 40));
const fromBot = (id, content, ageMs) => ({
  id,
  author: { id: env.client.user.id },
  content,
  createdTimestamp: Date.now() - ageMs,
});

test('the newest message of Sylo decides, whatever order the history comes in', async () => {
  await setGuildModule(GID, 'tickets', { enabled: true, config: {} });
  const member = fakeMember(env.guild, U);
  const dm = dmFor(member);
  const client = new EventEmitter();
  registerDmTickets(client);
  // oldest first: an old question, then the newer "Cancelled." The newest says the questionnaire is over.
  const history = [
    fromBot('900000000000000001', '**Question 1 of 5 · About me**\nTell us.', 120_000),
    fromBot('900000000000000002', 'Cancelled. Nothing was changed.', 60_000),
  ];
  const mine = dmMessage(member, 'I need help with my account', dm.channel, history);
  client.emit('messageCreate', mine.message);
  await settle();
  assert.ok(await getOpenTicket(GID, U), 'a normal modmail message: a ticket');
  assert.equal(mine.replies.length, 0);
});

test('the notice names the command for the platform: a slash command on Discord, the prefix on Fluxer', async () => {
  const member = fakeMember(env.guild, U);
  const dm = dmFor(member);
  const history = [fromBot('900000000000000003', '**Question 2 of 5 · Likes**', 5_000)];

  const discordClient = new EventEmitter();
  registerDmTickets(discordClient);
  const onDiscord = dmMessage(member, 'trains', dm.channel, history);
  discordClient.emit('messageCreate', onDiscord.message);
  await settle();
  assert.match(onDiscord.replies[0], /with \/intro create\./);

  const fluxerClient = { guilds: { cache: new Map() }, isReady: () => true, user: env.client.user };
  runtime.clients.fluxer = fluxerClient;
  const fluxerEvents = new EventEmitter();
  registerDmTickets(fluxerEvents);
  const onFluxer = dmMessage(member, 'trains', dm.channel, history, fluxerClient);
  fluxerEvents.emit('messageCreate', onFluxer.message);
  await settle();
  assert.match(onFluxer.replies[0], /with !intro create\./);
  assert.doesNotMatch(onFluxer.replies[0], /\/intro/);
});

// --- N5: a validate that throws --------------------------------------------------------------------------

test('a validate that throws is answered with a generic message, and the answer is not logged', async (t) => {
  const logged = t.mock.method(log, 'error', () => {});
  const sent = [];
  const channel = { send: async (payload) => sent.push(payload) && { channel } };
  const user = { id: U, send: async (payload) => sent.push(payload) && { channel } };
  let calls = 0;
  await startQuestionnaire({
    user,
    questions: [
      {
        id: 'a',
        label: 'A',
        required: true,
        maxLength: 50,
        validate: () => {
          calls += 1;
          if (calls === 1) throw new Error('lookup failed');
          return null;
        },
      },
    ],
    onComplete: async () => 'Done',
  });
  const say = (content) => handleQuestionnaireMessage({ author: user, content, client: env.client, channel });
  await say('my secret answer');
  assert.equal(sent.at(-1).content, 'Could not check that answer, please try again.');
  assert.equal(hasActiveQuestionnaire('discord', U), true, 'still on the same question');
  for (const call of logged.mock.calls) {
    assert.ok(!JSON.stringify(call.arguments).includes('my secret answer'));
  }
  assert.equal(logged.mock.callCount(), 1);
  await say('my secret answer');
  assert.equal(sent.at(-1).content, 'Done');
});

// --- N6: a failing channel lookup while publishing -------------------------------------------------------

test('a channel lookup that fails while publishing is a readable error, not a throw', async () => {
  env.guild.channels.cache.delete(INTRO_CH);
  env.guild.channels.fetch = async () => {
    throw serverError();
  };
  const result = await publishPrompt(env.guild, {
    channelId: INTRO_CH,
    promptText: 'Hi',
    promptChannelId: '',
    promptMessageId: '',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not look up that channel right now/);
});
