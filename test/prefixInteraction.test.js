import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { MessageInteraction } from '../src/bot/framework/MessageInteraction.js';

const RAW_GUILD = '900000000000000070';

function fakeMessage() {
  const log = { replies: [], sends: [], edits: [], deletes: [], typing: 0 };
  const makeSent = (payload) => ({
    id: `m${log.replies.length + log.sends.length}`,
    payload,
    createdTimestamp: 1000,
    edit: async (p) => {
      log.edits.push(p);
      return { ...p };
    },
    delete: async () => {
      log.deletes.push(`sent:${payload.content ?? ''}`);
    },
  });
  const guild = {
    id: RAW_GUILD,
    name: 'Guild',
    members: { fetch: async () => null },
    nameAndId() {
      return `${this.name}:${this.id}`; // proves methods still see the real, bare id
    },
  };
  const message = {
    id: 'invoke1',
    createdTimestamp: 500,
    author: { id: '111111111111111111', tag: 'a#1', username: 'a' },
    member: { id: '111111111111111111', permissions: { has: () => true }, roles: { cache: new Map() } },
    guild,
    guildId: RAW_GUILD,
    channel: {
      id: '222222222222222222',
      send: async (p) => {
        const s = makeSent(p);
        log.sends.push(p);
        return s;
      },
      sendTyping: async () => {
        log.typing += 1;
      },
    },
    channelId: '222222222222222222',
    client: { marker: 'client' },
    reply: async (p) => {
      const s = makeSent(p);
      log.replies.push(p);
      return s;
    },
    delete: async () => {
      log.deletes.push('invoker');
    },
  };
  return { message, log };
}

const make = (extra = {}) => {
  const { message, log } = fakeMessage();
  const ix = new MessageInteraction({
    message,
    commandName: 'ping',
    parsed: { subcommand: null, values: {} },
    resolved: {},
    privateTtlMs: 5,
    ...extra,
  });
  return { ix, message, log };
};

test('identity: command name, user, guild id in platform form, raw channel/user ids', () => {
  const { ix, message } = make();
  assert.equal(ix.commandName, 'ping');
  assert.equal(ix.user, message.author);
  assert.equal(ix.member, message.member);
  assert.equal(ix.client, message.client);
  assert.equal(ix.guildId, `fluxer:${RAW_GUILD}`);
  assert.equal(ix.channelId, message.channelId);
  assert.equal(ix.createdTimestamp, 500);
  assert.equal(ix.inGuild(), true);
  assert.equal(ix.isChatInputCommand(), true);
  assert.equal(ix.memberPermissions, message.member.permissions);
});

test('interaction.guild.id is in platform form; everything else, including methods, is the real guild', () => {
  const { ix, message } = make();
  assert.equal(ix.guild.id, `fluxer:${RAW_GUILD}`);
  assert.equal(ix.guild.name, 'Guild');
  assert.equal(ix.guild.members, message.guild.members);
  assert.equal(ix.guild.nameAndId(), `Guild:${RAW_GUILD}`);
});

test('a DM has no guild', () => {
  const { message } = fakeMessage();
  message.guild = null;
  message.guildId = null;
  const ix = new MessageInteraction({
    message,
    commandName: 'x',
    parsed: { subcommand: null, values: {} },
    resolved: {},
  });
  assert.equal(ix.inGuild(), false);
  assert.equal(ix.guildId, null);
  assert.equal(ix.guild, null);
});

// A new message without its own allowedMentions may ping users only (src/platform/outgoing.js).
const USERS_ONLY = { parse: ['users'] };

test('reply() sends one reply and strips discord-only payload keys', async () => {
  const { ix, log } = make();
  const sent = await ix.reply({
    content: 'hello',
    flags: 0,
    withResponse: true,
    fetchReply: true,
    components: [{}],
    allowedMentions: { parse: [] },
  });
  assert.deepEqual(log.replies, [{ content: 'hello', allowedMentions: { parse: [] } }]);
  assert.equal(sent.resource.message.payload.content, 'hello'); // withResponse shape, as ping.js reads it
  assert.equal(ix.replied, true);
  assert.equal((await ix.fetchReply()).payload.content, 'hello');
});

test('reply() accepts a plain string', async () => {
  const { ix, log } = make();
  await ix.reply('just text');
  assert.deepEqual(log.replies, [{ content: 'just text', allowedMentions: USERS_ONLY }]);
});

test('editReply() edits the reply; after deferReply() the first editReply() sends it', async () => {
  const a = make();
  await a.ix.reply('one');
  await a.ix.editReply('two');
  assert.deepEqual(a.log.edits, [{ content: 'two' }]);

  const b = make();
  await b.ix.deferReply();
  assert.equal(b.log.typing, 1);
  assert.equal(b.ix.deferred, true);
  assert.equal(b.log.replies.length, 0);
  await b.ix.editReply('done');
  assert.deepEqual(b.log.replies, [{ content: 'done', allowedMentions: USERS_ONLY }]);
  assert.equal(b.log.edits.length, 0);
});

test('followUp() sends an additional message', async () => {
  const { ix, log } = make();
  await ix.reply('first');
  await ix.followUp('second');
  assert.equal(log.replies.length + log.sends.length, 2);
});

// Fluxer has no private replies. A private reply that carries data (an embed or a file: a member's
// moderation history, a private quote) goes to the DMs of whoever ran the command, and the channel only
// gets a notice with none of it, removed (with the invoking message) after the private TTL. A private
// line of plain text (a status or an error) is sent normally and removed after the same delay.
function withDms(ix, { fail = false } = {}) {
  const dms = [];
  const dmEdits = [];
  ix.user.send = async (p) => {
    if (fail) throw new Error('Cannot send messages to this user');
    dms.push(p);
    return { id: `dm${dms.length}`, edit: async (e) => dmEdits.push(e) };
  };
  return { dms, dmEdits };
}
const channelText = (log) => JSON.stringify([...log.replies, ...log.sends, ...log.edits]);
const secret = (text) => ({ embeds: [{ title: 'Cases', description: text }] });

test('a plain-text ephemeral reply is removed (with the invoking message) after the private TTL', async () => {
  const { ix, log } = make();
  const { dms } = withDms(ix);
  await ix.reply({ content: 'nope', flags: MessageFlags.Ephemeral });
  assert.deepEqual(log.replies, [{ content: 'nope', allowedMentions: USERS_ONLY }]); // the flag itself is not sent
  assert.equal(dms.length, 0);
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(log.deletes.includes('sent:nope'));
  assert.ok(log.deletes.includes('invoker'));
});

test('a deferred plain-text ephemeral reply is also removed again', async () => {
  const { ix, log } = make();
  await ix.deferReply({ flags: MessageFlags.Ephemeral });
  await ix.editReply('quiet');
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(log.deletes.includes('sent:quiet'));
});

test('an ephemeral reply with an embed goes to the DMs; the channel only gets a notice, removed with the invoking message', async () => {
  const { ix, log } = make();
  const { dms } = withDms(ix);
  await ix.reply({ ...secret('warned for harassment'), flags: MessageFlags.Ephemeral });
  assert.equal(dms.length, 1);
  assert.match(JSON.stringify(dms[0]), /harassment/);
  assert.ok(!channelText(log).includes('harassment'), 'nothing private in the channel');
  assert.equal(log.replies.length + log.sends.length, 1);
  assert.match((log.replies[0] ?? log.sends[0]).content, /DMs/);
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(
    log.deletes.some((d) => d.startsWith('sent:')),
    'the notice is removed'
  );
  assert.ok(log.deletes.includes('invoker'));
});

test('a deferred ephemeral reply with an embed is private too, and editing it edits the DM', async () => {
  const { ix, log } = make();
  const { dms, dmEdits } = withDms(ix);
  await ix.deferReply({ flags: MessageFlags.Ephemeral });
  await ix.editReply(secret('first'));
  await ix.editReply(secret('second'));
  assert.equal(dms.length, 1);
  assert.equal(dmEdits.length, 1);
  assert.match(JSON.stringify(dmEdits[0]), /second/);
  assert.ok(!channelText(log).includes('first') && !channelText(log).includes('second'));
  assert.equal(log.replies.length + log.sends.length, 1, 'one notice, not one per edit');
});

test('an ephemeral follow-up with an embed goes to the DMs too', async () => {
  const { ix, log } = make();
  const { dms } = withDms(ix);
  await ix.reply('public first');
  await ix.followUp({ ...secret('private second'), flags: MessageFlags.Ephemeral });
  assert.equal(dms.length, 1);
  assert.match(JSON.stringify(dms[0]), /private second/);
  assert.ok(!channelText(log).includes('private second'));
});

test('when the DM fails, only a notice without the data is posted, and later edits never reach the channel', async () => {
  const { ix, log } = make();
  withDms(ix, { fail: true });
  await ix.deferReply({ flags: MessageFlags.Ephemeral });
  await ix.editReply(secret('moderation notes: spam'));
  await ix.editReply(secret('moderation notes: spam, harassment'));
  await ix.followUp({ ...secret('more notes'), flags: MessageFlags.Ephemeral });
  const all = [...log.replies, ...log.sends];
  assert.equal(all.length, 1);
  assert.match(all[0].content, /DM/);
  assert.ok(!channelText(log).includes('notes'));
  assert.equal(log.edits.length, 0);
});

test('a private reply with data in a DM channel is sent where it is (nobody else is there)', async () => {
  const { message, log } = fakeMessage();
  message.guild = null;
  message.guildId = null;
  const ix = new MessageInteraction({
    message,
    commandName: 'ping',
    parsed: { subcommand: null, values: {} },
    resolved: {},
    privateTtlMs: 5,
  });
  await ix.reply({ ...secret('mine'), flags: MessageFlags.Ephemeral });
  assert.match(JSON.stringify(log.replies[0]), /mine/);
});

test('a normal reply is never auto-deleted', async () => {
  const { ix, log } = make();
  await ix.reply('public');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(log.deletes, []);
});

test('options getters: coerced values, nulls for missing, resolved entities, subcommand', () => {
  const user = { id: 'u' };
  const member = { id: 'u', user };
  const channel = { id: 'c' };
  const role = { id: 'r' };
  const { message } = fakeMessage();
  const ix = new MessageInteraction({
    message,
    commandName: 'x',
    parsed: {
      subcommand: 'add',
      values: {
        reason: { type: 3, value: 'spam' },
        n: { type: 4, value: 7 },
        ratio: { type: 10, value: 1.5 },
        loud: { type: 5, value: true },
        who: { type: 6, value: '<@u>' },
        where: { type: 7, value: '<#c>' },
        what: { type: 8, value: '<@&r>' },
      },
    },
    resolved: { who: { user, member }, where: channel, what: role },
  });
  const o = ix.options;
  assert.equal(o.getSubcommand(), 'add');
  assert.equal(o.getString('reason'), 'spam');
  assert.equal(o.getInteger('n'), 7);
  assert.equal(o.getNumber('ratio'), 1.5);
  assert.equal(o.getBoolean('loud'), true);
  assert.equal(o.getUser('who'), user);
  assert.equal(o.getMember('who'), member);
  assert.equal(o.getChannel('where'), channel);
  assert.equal(o.getRole('what'), role);
  assert.equal(o.getString('missing'), null);
  assert.equal(o.getUser('missing'), null);
  assert.equal(o.getMember('missing'), null);
  assert.equal(o.getAttachment('missing'), null);
  assert.throws(() => o.getString('missing', true), /missing/);
});

test('getSubcommand() throws when the command has none', () => {
  const { ix } = make();
  assert.throws(() => ix.options.getSubcommand());
});

// A file (the /mydata export, with tickets and mod cases) must never be shown in the channel: it goes
// to the author's DMs, and the channel only learns whether that worked.
test('a private reply with a file goes to DMs, never the channel', async () => {
  const { ix, log } = make();
  const dms = [];
  ix.message.author.send = async (p) => {
    dms.push(p);
    return { id: 'dm1' };
  };
  await ix.reply({
    content: 'export',
    files: [{ attachment: Buffer.from('{}'), name: 'x.json' }],
    flags: MessageFlags.Ephemeral,
  });
  assert.equal(dms.length, 1);
  assert.equal(dms[0].files.length, 1);
  assert.ok(log.replies.every((p) => !p.files?.length) && log.sends.every((p) => !p.files?.length));
});

test('when the DM fails, the channel gets a notice without the file', async () => {
  const { ix, log } = make();
  ix.message.author.send = async () => {
    throw new Error('Cannot send messages to this user');
  };
  await ix.reply({
    content: 'export',
    files: [{ attachment: Buffer.from('{}'), name: 'x.json' }],
    flags: MessageFlags.Ephemeral,
  });
  const all = [...log.replies, ...log.sends];
  assert.equal(all.length, 1);
  assert.equal(all[0].files, undefined);
  assert.match(all[0].content, /DM/);
});
