// The whole member flow of Introductions: /intro create -> questions in DM -> preview -> Post ->
// the card; running it again; cancelling; the other commands; and the DM handler, which must treat
// a member's DMs as answers (never as a modmail ticket) while a questionnaire runs. Plus the same
// flow on the Fluxer side, where the buttons are reactions.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execute, data } from '../src/bot/commands/intro.js';
import { register as registerDmTickets } from '../src/bot/events/dmTickets.js';
import {
  _resetQuestionnaires,
  handleQuestionnaireMessage,
  hasActiveQuestionnaire,
  startQuestionnaire,
} from '../src/bot/lib/dmQuestionnaire.js';
import { routeComponent } from '../src/bot/lib/components.js';
import { _resetIntroductions, postIntroduction } from '../src/modules/introductions.js';
import { setGuildModule } from '../src/db/modules.js';
import { getIntroduction, answersOf } from '../src/db/introductions.js';
import { getOpenTicket, ticketMessages } from '../src/db/tickets.js';
import { purgeGuild } from '../src/db/purge.js';
import { runtime } from '../src/runtime.js';
import { prepareOutgoing, attachActions } from '../src/platform/outgoing.js';
import { handleReactionAdd } from '../src/platform/reactionBridge.js';
import { GID, INTRO_CH, dropFakeClient, fakeIntroGuild, fakeMember } from './helpers/fakeIntro.js';

const U = '700000000000000020';
const STAFF = '700000000000000021';
const EPHEMERAL = 64; // MessageFlags.Ephemeral

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

/** The member's DM: everything Sylo sent them, and a way to write as them. */
function dmFor(member) {
  const sent = member.user.dms;
  const channel = { send: async (payload) => sent.push(payload) && { channel } };
  member.user.send = async (payload) => sent.push(payload) && { channel };
  const say = (content) =>
    handleQuestionnaireMessage({ author: member.user, content, client: env.client, channel });
  return { sent, channel, say };
}

/** A /intro interaction. */
function interactionFor(member, sub, { target = null, manageMessages = false } = {}) {
  const replies = [];
  return {
    replies,
    guild: env.guild,
    guildId: GID,
    user: member.user,
    member,
    memberPermissions: { has: (p) => manageMessages && p === 'ManageMessages' },
    options: { getSubcommand: () => sub, getUser: () => target },
    deferReply: async () => {},
    reply: async (payload) => replies.push(payload),
    editReply: async (payload) => replies.push(payload),
  };
}

const buttonId = (payload, index) => payload.components[0].toJSON().components[index].custom_id;

/** A press on the preview's button. */
function press(customId, user) {
  const log = { updates: [], edits: [] };
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

test('the command has create, view and remove, and the questions come from the settings', () => {
  const json = data.toJSON();
  assert.equal(json.name, 'intro');
  assert.deepEqual(
    json.options.map((o) => o.name),
    ['create', 'view', 'remove']
  );
  assert.deepEqual(
    json.options[1].options.map((o) => o.name),
    ['user']
  );
  assert.deepEqual(
    json.options[2].options.map((o) => o.name),
    ['user']
  );
});

test('/intro create answers "Check your DMs", asks in DM, shows a preview, and Post publishes the card', async () => {
  const member = fakeMember(env.guild, U, { username: 'mira' });
  const dm = dmFor(member);
  const interaction = interactionFor(member, 'create');
  await execute(interaction);
  assert.equal(interaction.replies[0].content, 'Check your DMs.');
  assert.match(dm.sent[0].content, /Introduction for \*\*Hedgerow HQ\*\*/);
  assert.match(dm.sent[0].content, /Question 1 of 5 · About me/);

  await dm.say('I collect trains');
  await dm.say('skip');
  await dm.say('skip');
  await dm.say('she/her');
  assert.equal(env.channel.log.sent.length, 0, 'nothing is posted before Post');
  await dm.say('ask first');

  const preview = dm.sent.at(-1);
  const shown = preview.embeds[0].toJSON();
  assert.equal(shown.fields.find((f) => f.name === 'About me').value, 'I collect trains');
  assert.equal(shown.fields.find((f) => f.name === 'DMs').value, 'ask first');
  assert.equal(env.channel.log.sent.length, 0);

  const { interaction: click, log } = press(buttonId(preview, 0), member.user);
  assert.equal(await routeComponent(click), true);
  assert.equal(env.channel.log.sent.length, 1, 'the card was posted');
  const row = await getIntroduction(GID, U);
  assert.deepEqual(answersOf(row), {
    about: 'I collect trains',
    pronouns: 'she/her',
    dms: 'ask first',
  });
  assert.match(
    log.edits.at(-1).content,
    /^Your introduction is posted: https:\/\/discord\.com\/channels\/900000000000000321\/100000000000000501\//
  );
  assert.equal(hasActiveQuestionnaire('discord', U), false);
});

test('running /intro again offers the old answers, and Post edits the same card', async () => {
  const member = fakeMember(env.guild, U);
  const dm = dmFor(member);
  const first = await postIntroduction({
    guild: env.guild,
    userId: U,
    answers: { about: 'Old about', pronouns: 'he/him' },
  });

  const interaction = interactionFor(member, 'create');
  await execute(interaction);
  assert.match(dm.sent[0].content, /You already have a card, so I will update it/);
  assert.match(dm.sent[0].content, /Current:\n> Old about/);
  await dm.say('keep');
  await dm.say('skip');
  await dm.say('skip');
  await dm.say('keep');
  await dm.say('skip');
  const preview = dm.sent.at(-1);
  const fields = preview.embeds[0].toJSON().fields;
  assert.equal(fields.find((f) => f.name === 'About me').value, 'Old about');
  assert.equal(fields.find((f) => f.name === 'Pronouns').value, 'he/him');

  const { interaction: click, log } = press(buttonId(preview, 0), member.user);
  await routeComponent(click);
  assert.match(log.edits.at(-1).content, /^Your introduction was updated/);
  assert.equal(env.channel.log.sent.length, 1, 'no second card');
  assert.equal(env.channel.log.edits.length, 1, 'the first card was edited');
  assert.equal((await getIntroduction(GID, U)).message_id, first.messageId);
});

test('/intro create twice within 30 seconds: the second asks to wait', async () => {
  const member = fakeMember(env.guild, U);
  dmFor(member);
  const first = interactionFor(member, 'create');
  await execute(first);
  const second = interactionFor(member, 'create');
  await execute(second);
  assert.match(second.replies[0].content, /Please wait \d+ seconds/);
  assert.equal(second.replies[0].flags, EPHEMERAL);
});

test('a second questionnaire while one is running is refused', async () => {
  const member = fakeMember(env.guild, U);
  dmFor(member);
  await execute(interactionFor(member, 'create'));
  _resetIntroductions(); // forget the 30 s limit, keep the session
  const again = interactionFor(member, 'create');
  await execute(again);
  assert.match(again.replies[0].content, /already answering questions in your DMs/);
});

test('closed DMs: the reply tells the member how to fix it, and no session is left', async () => {
  const member = fakeMember(env.guild, U);
  member.user.send = async () => {
    throw new Error('Cannot send messages to this user');
  };
  const interaction = interactionFor(member, 'create');
  await execute(interaction);
  assert.equal(
    interaction.replies[0].content,
    'I could not DM you. Open your DMs from server members and try again.'
  );
  assert.equal(hasActiveQuestionnaire('discord', U), false);
});

test('cancel in DM posts nothing and keeps an existing card as it was', async () => {
  const member = fakeMember(env.guild, U);
  const dm = dmFor(member);
  await postIntroduction({ guild: env.guild, userId: U, answers: { about: 'Stays' } });
  await execute(interactionFor(member, 'create'));
  await dm.say('New text');
  await dm.say('cancel');
  assert.match(dm.sent.at(-1).content, /Cancelled/);
  assert.equal(env.channel.log.sent.length, 1);
  assert.equal(env.channel.log.edits.length, 0);
  assert.deepEqual(answersOf(await getIntroduction(GID, U)), { about: 'Stays' });
});

test('with the module off, the command says so', async () => {
  await setGuildModule(GID, 'introductions', { enabled: false });
  const member = fakeMember(env.guild, U);
  const interaction = interactionFor(member, 'create');
  await execute(interaction);
  assert.match(interaction.replies[0].content, /module is off/);
  assert.equal(interaction.replies[0].flags, EPHEMERAL);
});

test('a server with no questions posts the member card straight away', async () => {
  await setGuildModule(GID, 'introductions', { config: { channelId: INTRO_CH, questions: [] } });
  const member = fakeMember(env.guild, U);
  const interaction = interactionFor(member, 'create');
  await execute(interaction);
  assert.match(interaction.replies[0].content, /^Your introduction is posted/);
  assert.equal(env.channel.log.sent.length, 1);
});

test('/intro view shows a card privately, for yourself or for another member', async () => {
  const mira = fakeMember(env.guild, U, { username: 'mira' });
  const other = fakeMember(env.guild, STAFF, { username: 'sam' });
  const none = interactionFor(mira, 'view');
  await execute(none);
  assert.match(none.replies[0].content, /not made an introduction yet/);

  await postIntroduction({ guild: env.guild, userId: U, answers: { about: 'Hello there' } });
  const own = interactionFor(mira, 'view');
  await execute(own);
  assert.equal(own.replies[0].flags, EPHEMERAL);
  assert.equal(
    own.replies[0].embeds[0].toJSON().fields.find((f) => f.name === 'About me').value,
    'Hello there'
  );

  const asOther = interactionFor(other, 'view', { target: mira.user });
  await execute(asOther);
  assert.equal(asOther.replies[0].embeds[0].toJSON().title, 'mira');
  const missing = interactionFor(mira, 'view', { target: other.user });
  await execute(missing);
  assert.match(missing.replies[0].content, /has not made an introduction/);
});

test('/intro remove deletes your own card; naming someone else needs Manage Messages', async () => {
  const mira = fakeMember(env.guild, U);
  const sam = fakeMember(env.guild, STAFF, { username: 'sam' });
  const posted = await postIntroduction({ guild: env.guild, userId: U, answers: {} });

  const refused = interactionFor(sam, 'remove', { target: mira.user });
  await execute(refused);
  assert.match(refused.replies[0].content, /Only staff with Manage Messages/);
  assert.ok(await getIntroduction(GID, U), 'nothing was deleted');

  const byStaff = interactionFor(sam, 'remove', { target: mira.user, manageMessages: true });
  await execute(byStaff);
  assert.match(byStaff.replies[0].content, /was deleted/);
  assert.equal(await getIntroduction(GID, U), null);
  assert.equal(env.channel.store.has(posted.messageId), false);

  const nothing = interactionFor(mira, 'remove');
  await execute(nothing);
  assert.match(nothing.replies[0].content, /no introduction to remove/);

  await postIntroduction({ guild: env.guild, userId: U, answers: {} });
  const own = interactionFor(mira, 'remove');
  await execute(own);
  assert.equal(own.replies[0].content, 'Your introduction was deleted.');
  assert.equal(await getIntroduction(GID, U), null);
});

// --- DMs go to the questionnaire, not to modmail --------------------------------------------------------

function dmMessage(member, content, channel) {
  const replies = [];
  const reactions = [];
  return {
    replies,
    reactions,
    message: {
      guild: null,
      partial: false,
      content,
      author: Object.assign(member.user, { bot: false, tag: 'mira#0001' }),
      attachments: new Map(),
      client: env.client,
      channel,
      reply: async (payload) => replies.push(payload),
      react: async (emoji) => reactions.push(emoji),
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 40));

test('while a questionnaire runs, DMs are answers and no ticket is opened; afterwards DMs open a ticket again', async () => {
  await setGuildModule(GID, 'tickets', { enabled: true, config: {} });
  const member = fakeMember(env.guild, U);
  const dm = dmFor(member);
  const client = new EventEmitter();
  registerDmTickets(client);

  await execute(interactionFor(member, 'create'));
  assert.equal(hasActiveQuestionnaire('discord', U), true);
  const before = dm.sent.length;

  // The handler gets the DM as the gateway delivers it: the questionnaire must take it first.
  const answer = dmMessage(member, 'I need help with my account', dm.channel);
  client.emit('messageCreate', answer.message);
  await settle();
  assert.ok(!(await getOpenTicket(GID, U)), 'no modmail ticket was opened');
  assert.deepEqual(answer.replies, [], 'no ticket reply');
  assert.deepEqual(answer.reactions, [], 'no ticket checkmark');
  assert.match(dm.sent[before]?.content ?? '', /Question 2 of 5/, 'it was taken as the answer to question 1');

  // cancel ends the session; the next DM is an ordinary modmail message again
  const cancel = dmMessage(member, 'cancel', dm.channel);
  client.emit('messageCreate', cancel.message);
  await settle();
  assert.equal(hasActiveQuestionnaire('discord', U), false);
  assert.ok(!(await getOpenTicket(GID, U)), 'cancel did not open a ticket either');

  const help = dmMessage(member, 'I need help with my account', dm.channel);
  client.emit('messageCreate', help.message);
  await settle();
  assert.ok(await getOpenTicket(GID, U), 'with no session, the DM opens a ticket as before');
  assert.deepEqual(help.reactions, ['✅']);
});

test('an active session swallows the DM, even for a member who has an open ticket', async () => {
  await setGuildModule(GID, 'tickets', { enabled: true, config: {} });
  const member = fakeMember(env.guild, U);
  const dm = dmFor(member);
  const client = new EventEmitter();
  registerDmTickets(client);
  const first = dmMessage(member, 'first message', dm.channel);
  client.emit('messageCreate', first.message);
  await settle();
  const ticket = await getOpenTicket(GID, U);
  assert.ok(ticket);
  const count = (await ticketMessages(ticket.id)).length;

  await execute(interactionFor(member, 'create'));
  client.emit('messageCreate', dmMessage(member, 'this is an answer', dm.channel).message);
  await settle();
  assert.equal((await ticketMessages(ticket.id)).length, count, 'nothing was added to the ticket');
});

// --- Fluxer: the buttons are reactions ---------------------------------------------------------------

test('on Fluxer the preview buttons become reactions, and a reaction posts the card', async () => {
  const fluxerClient = {
    guilds: { cache: new Map() },
    isReady: () => true,
    user: { id: '555555555555550002' },
  };
  runtime.clients.fluxer = fluxerClient;
  const reactions = [];
  const edits = [];
  const previewMessage = {
    id: '900000000000000777',
    channelId: '300000000000000001',
    guildId: null,
    guild: null,
    client: fluxerClient,
    channel: { id: '300000000000000001', send: async () => ({}) },
    react: async (emoji) => reactions.push(emoji),
    edit: async (payload) => edits.push(payload),
    removeAllReactions: async () => {},
  };
  const sent = [];
  const channel = {
    send: async (payload) => {
      // what the Fluxer send bridge does (platform/fluxerSendBridge.js)
      const out = prepareOutgoing(payload, { platform: 'fluxer' });
      sent.push(out.payload);
      await attachActions(previewMessage, out, { guildId: '' });
      return previewMessage;
    },
  };
  const user = { id: U, bot: false, send: async (payload) => channel.send(payload) };
  let completed = null;
  const started = await startQuestionnaire({
    user,
    platform: 'fluxer',
    questions: [{ id: 'about', label: 'About', required: true, maxLength: 50 }],
    review: () => ({ embeds: [{ description: 'preview' }] }),
    onComplete: async (answers) => {
      completed = answers;
      return 'Posted on Fluxer.';
    },
  });
  assert.equal(started.ok, true);
  assert.equal(hasActiveQuestionnaire('fluxer', U), true);
  assert.equal(hasActiveQuestionnaire('discord', U), false, 'sessions are per platform');

  await handleQuestionnaireMessage({ author: user, content: 'Fluxer hello', client: fluxerClient, channel });
  const preview = sent.at(-1);
  assert.match(preview.content, /React to choose:\n✅ Post\n🔄 Start over/);
  assert.deepEqual(reactions, ['✅', '🔄']);
  assert.equal(completed, null);

  await handleReactionAdd(
    { message: previewMessage, emoji: { name: '✅' }, users: { remove: async () => {} } },
    { id: U, bot: false },
    { platform: 'fluxer' }
  );
  assert.deepEqual(completed, { about: 'Fluxer hello' });
  assert.equal(edits.at(-1).content, 'Posted on Fluxer.');
  assert.equal(hasActiveQuestionnaire('fluxer', U), false);
});

// --- the Create my intro button of the prompt message ----------------------------------------------------

function buttonPress(member) {
  const log = { replies: [], deferred: [] };
  return {
    log,
    interaction: {
      customId: 'intro:create',
      guild: env.guild,
      user: member.user,
      isRepliable: () => true,
      reply: async (payload) => log.replies.push(payload),
      deferReply: async (payload) => log.deferred.push(payload),
      editReply: async (payload) => log.replies.push(payload),
    },
  };
}

test('the Create my intro button starts the questionnaire like /intro create', async () => {
  const member = fakeMember(env.guild, U);
  const dm = dmFor(member);
  const { interaction, log } = buttonPress(member);
  assert.equal(await routeComponent(interaction), true);
  assert.equal(log.deferred[0].flags, EPHEMERAL, 'a private reply, sent after the work is done');
  assert.equal(log.replies[0].content, 'Check your DMs.');
  assert.match(dm.sent[0].content, /Question 1 of 5 · About me/);
  assert.equal(hasActiveQuestionnaire('discord', U), true);
});

test('the button answers privately when the module is off or the member pressed it a moment ago', async () => {
  const member = fakeMember(env.guild, U);
  dmFor(member);
  await setGuildModule(GID, 'introductions', { enabled: false });
  const off = buttonPress(member);
  await routeComponent(off.interaction);
  assert.equal(off.log.replies[0].content, 'Introductions are off in this server.');
  assert.equal(off.log.replies[0].flags, EPHEMERAL);

  await setGuildModule(GID, 'introductions', { enabled: true });
  await routeComponent(buttonPress(member).interaction);
  _resetQuestionnaires(); // so only the 30 second limit is left to refuse the second press
  const again = buttonPress(member);
  await routeComponent(again.interaction);
  assert.match(again.log.replies[0].content, /Please wait \d+ seconds/);
});
