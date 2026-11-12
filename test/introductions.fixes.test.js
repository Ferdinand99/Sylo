// Introductions, second round: placeholders and the footer, a module switched off mid-session, a
// failed Post that keeps the answers, answers kept under a lowered limit, a late answer after a
// restart, and DMs that look like commands while a questionnaire runs.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execute } from '../src/bot/commands/intro.js';
import { register as registerDmTickets } from '../src/bot/events/dmTickets.js';
import { handleMessage } from '../src/bot/framework/router.js';
import {
  _resetQuestionnaires,
  cancelQuestionnaire,
  handleQuestionnaireMessage,
  hasActiveQuestionnaire,
} from '../src/bot/lib/dmQuestionnaire.js';
import { routeComponent } from '../src/bot/lib/components.js';
import {
  _resetIntroductions,
  buildIntroCard,
  normaliseIntroductionsConfig,
  postIntroduction,
} from '../src/modules/introductions.js';
import { setGuildModule } from '../src/db/modules.js';
import { answersOf, getIntroduction, saveIntroduction } from '../src/db/introductions.js';
import { getOpenTicket } from '../src/db/tickets.js';
import { purgeGuild } from '../src/db/purge.js';
import { GID, INTRO_CH, ROLE, dropFakeClient, fakeIntroGuild, fakeMember } from './helpers/fakeIntro.js';

const U = '700000000000000040';

let env;
beforeEach(async () => {
  _resetQuestionnaires();
  _resetIntroductions();
  await purgeGuild(GID);
  env = fakeIntroGuild();
  await setGuildModule(GID, 'introductions', { enabled: true, config: { channelId: INTRO_CH } });
});
afterEach(() => dropFakeClient());

const cfgOf = (extra = {}) => normaliseIntroductionsConfig({ channelId: INTRO_CH, ...extra });
const cardOf = (member, cfg, answers = {}) =>
  buildIntroCard({ guild: env.guild, member, cfg, answers, defaultColor: 0x7aa2f7 }).embeds[0].toJSON();

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

// --- placeholders and the footer ---------------------------------------------------------------------

test('the footer is plain text: no escapes, and {user} is the display name', () => {
  const member = fakeMember(env.guild, U, { username: 'cool_guy', roleIds: [ROLE.norway] });
  const cfg = cfgOf({
    footer: 'Welcome {user} aka {user.name} to {server}. {rolegroup:Country}',
    description: '{user} aka {user.name}',
    roleGroups: [{ name: 'Country', roleIds: [ROLE.norway] }],
  });
  const json = cardOf(member, cfg);
  assert.equal(json.footer.text, 'Welcome cool_guy aka cool_guy to Hedgerow HQ. Norway');
  assert.equal(
    json.description,
    `<@${U}> aka cool\\_guy`,
    'the description is markdown: a mention, and escaped'
  );
});

test('placeholders are filled in one pass: a name that looks like one is not expanded again', () => {
  const member = fakeMember(env.guild, U, { username: 'x', roleIds: [ROLE.norway] });
  member.displayName = '{server}{rolegroup:Country}';
  const cfg = cfgOf({
    description: 'Hi {user.name}!',
    footer: 'Bye {user.name}',
    roleGroups: [{ name: 'Country', roleIds: [ROLE.norway] }],
  });
  const json = cardOf(member, cfg);
  assert.equal(json.footer.text, 'Bye {server}{rolegroup:Country}');
  assert.ok(json.description.includes('{server}'), 'shown as typed');
  assert.ok(!json.description.includes('Hedgerow HQ'));
  assert.ok(!json.description.includes('Norway'));
});

// --- posting rules -----------------------------------------------------------------------------------------

test('the card is not posted when the module was switched off meanwhile', async () => {
  fakeMember(env.guild, U);
  await setGuildModule(GID, 'introductions', { enabled: false });
  const result = await postIntroduction({ guild: env.guild, userId: U, answers: { about: 'Hi' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /off in this server/);
  assert.equal(env.channel.log.sent.length, 0);
  assert.equal(await getIntroduction(GID, U), null);
});

test('an answer kept under a lowered limit is cut with an ellipsis, not in the middle of an emoji', async () => {
  await setGuildModule(GID, 'introductions', {
    enabled: true,
    config: { channelId: INTRO_CH, questions: [{ id: 'about', label: 'About', maxLength: 5 }] },
  });
  fakeMember(env.guild, U);
  const emoji = String.fromCodePoint(0x1f600);
  await postIntroduction({ guild: env.guild, userId: U, answers: { about: `abc${emoji}${emoji}${emoji}` } });
  const stored = answersOf(await getIntroduction(GID, U)).about;
  assert.equal(stored, `abc…`);
  assert.ok(stored.length <= 5);
});

// --- a failed Post keeps the answers --------------------------------------------------------------------

test('when Post fails, the member keeps the answers and can press Post again', async () => {
  const member = fakeMember(env.guild, U);
  const dm = dmFor(member);
  await setGuildModule(GID, 'introductions', {
    enabled: true,
    config: {
      channelId: INTRO_CH,
      questions: [{ id: 'about', label: 'About', required: true, maxLength: 50 }],
    },
  });
  await execute(interactionFor(member, 'create'));
  await dm.say('I like trains');
  const firstPreview = dm.sent.at(-1);

  // staff clear the channel setting while the preview is open
  await setGuildModule(GID, 'introductions', {
    config: { channelId: '', questions: [{ id: 'about', label: 'About', required: true, maxLength: 50 }] },
  });
  const first = press(buttonId(firstPreview, 0), member.user);
  await routeComponent(first.interaction);
  assert.match(first.log.edits.at(-1).content, /not set up yet.*Your answers are kept/);
  assert.equal(env.channel.log.sent.length, 0);
  assert.equal(hasActiveQuestionnaire('discord', U), true, 'the session is back');

  // the setting is back: Post on the new preview works, with the same answers
  await setGuildModule(GID, 'introductions', {
    config: {
      channelId: INTRO_CH,
      questions: [{ id: 'about', label: 'About', required: true, maxLength: 50 }],
    },
  });
  const preview = dm.sent.at(-1);
  assert.equal(preview.embeds[0].toJSON().fields[0].value, 'I like trains');
  const second = press(buttonId(preview, 0), member.user);
  await routeComponent(second.interaction);
  assert.match(second.log.edits.at(-1).content, /^Your introduction is posted/);
  assert.deepEqual(answersOf(await getIntroduction(GID, U)), { about: 'I like trains' });
});

test('an answer that is only a mention is asked again for a required question', async () => {
  const member = fakeMember(env.guild, U);
  const dm = dmFor(member);
  await setGuildModule(GID, 'introductions', {
    enabled: true,
    config: {
      channelId: INTRO_CH,
      questions: [{ id: 'about', label: 'About', required: true, maxLength: 50 }],
    },
  });
  await execute(interactionFor(member, 'create'));
  await dm.say('@everyone');
  assert.match(dm.sent.at(-1).content, /Nothing was left of that answer/);
  assert.match(dm.sent[0].content, /Question 1 of 1/);
  assert.equal(hasActiveQuestionnaire('discord', U), true);
});

test('the module being switched off can end the session from outside', async () => {
  const member = fakeMember(env.guild, U);
  dmFor(member);
  await execute(interactionFor(member, 'create'));
  assert.equal(cancelQuestionnaire(U, 'module off'), true);
  assert.equal(hasActiveQuestionnaire('discord', U), false);
});

// --- DM handling around the questionnaire ---------------------------------------------------------------------

function dmMessage(member, content, channel, messages = []) {
  const replies = [];
  const reactions = [];
  const channelWithHistory = {
    ...channel,
    messages: { fetch: async () => new Map(messages.map((m) => [m.id, m])) },
  };
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
      client: env.client,
      channel: channelWithHistory,
      reply: async (payload) => replies.push(payload),
      react: async (emoji) => reactions.push(emoji),
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 40));
const fromBot = (content, ageMs = 1000) => ({
  id: '900000000000000998',
  author: { id: env.client.user.id },
  content,
  createdTimestamp: Date.now() - ageMs,
});

test('an answer that starts with the Fluxer prefix is still an answer', async () => {
  const member = fakeMember(env.guild, U);
  const dm = dmFor(member);
  const client = new EventEmitter();
  let treatedAsCommand = 0;
  registerDmTickets(client, {
    isCommand: (m) => {
      treatedAsCommand += 1;
      return m.content.startsWith('!');
    },
  });
  await execute(interactionFor(member, 'create'));
  const before = dm.sent.length;
  const answer = dmMessage(member, '!!! best game ever', dm.channel);
  client.emit('messageCreate', answer.message);
  await settle();
  assert.equal(treatedAsCommand, 0, 'the command check never saw it');
  assert.match(dm.sent[before].content, /Question 2 of 5/, 'it was taken as the first answer');
});

test('the command router leaves a DM alone while the member is answering', async () => {
  const member = fakeMember(env.guild, U);
  dmFor(member);
  await execute(interactionFor(member, 'create'));
  let ran = 0;
  const commands = new Map([['help', { data: { toJSON: () => ({}) }, execute: async () => (ran += 1) }]]);
  await handleMessage(
    { author: member.user, content: '!help', guild: null, client: env.client },
    { commands, prefix: '!' }
  );
  assert.equal(ran, 0);
});

test('after a restart, a late answer is not sent to modmail; the member is told', async () => {
  await setGuildModule(GID, 'tickets', { enabled: true, config: {} });
  const member = fakeMember(env.guild, U);
  const dm = dmFor(member);
  const client = new EventEmitter();
  registerDmTickets(client);
  // no session (it was lost in a restart), but the last thing Sylo said was a question
  const late = dmMessage(member, 'I collect trains', dm.channel, [
    fromBot('Introduction for **Hedgerow HQ**.\n\n**Question 1 of 5 · About me**\nTell us.'),
  ]);
  client.emit('messageCreate', late.message);
  await settle();
  assert.ok(!(await getOpenTicket(GID, U)), 'no ticket');
  assert.equal(late.replies.length, 1);
  assert.match(late.replies[0], /answer to a questionnaire that has ended/);
  assert.deepEqual(late.reactions, []);
});

test('a DM after any other bot message, or an old question, is modmail as before', async () => {
  await setGuildModule(GID, 'tickets', { enabled: true, config: {} });
  const member = fakeMember(env.guild, U);
  const dm = dmFor(member);
  const client = new EventEmitter();
  registerDmTickets(client);
  const old = dmMessage(member, 'hello', dm.channel, [
    fromBot('**Question 1 of 5 · About me**', 2 * 60 * 60 * 1000),
  ]);
  client.emit('messageCreate', old.message);
  await settle();
  assert.ok(await getOpenTicket(GID, U), 'an hour-old question does not count');
  assert.deepEqual(old.reactions, ['✅']);
});

test('if the history cannot be read, the DM goes the normal way', async () => {
  await setGuildModule(GID, 'tickets', { enabled: true, config: {} });
  const member = fakeMember(env.guild, U);
  const dm = dmFor(member);
  const client = new EventEmitter();
  registerDmTickets(client);
  const plain = dmMessage(member, 'hello', dm.channel);
  plain.message.channel.messages.fetch = async () => {
    throw new Error('Missing Access');
  };
  client.emit('messageCreate', plain.message);
  await settle();
  assert.ok(await getOpenTicket(GID, U));
});

test('a saved introduction stays when only the questionnaire is cancelled', async () => {
  fakeMember(env.guild, U);
  await saveIntroduction({
    guildId: GID,
    userId: U,
    channelId: INTRO_CH,
    messageId: null,
    answers: { about: 'Kept' },
  });
  cancelQuestionnaire(U, 'x');
  assert.deepEqual(answersOf(await getIntroduction(GID, U)), { about: 'Kept' });
});
