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
  assert.deepEqual(log.replies, [{ content: 'just text' }]);
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
  assert.deepEqual(b.log.replies, [{ content: 'done' }]);
  assert.equal(b.log.edits.length, 0);
});

test('followUp() sends an additional message', async () => {
  const { ix, log } = make();
  await ix.reply('first');
  await ix.followUp('second');
  assert.equal(log.replies.length + log.sends.length, 2);
});

test('an ephemeral reply is removed (with the invoking message) after the private TTL', async () => {
  const { ix, log } = make();
  await ix.reply({ content: 'secret', flags: MessageFlags.Ephemeral });
  assert.deepEqual(log.replies, [{ content: 'secret' }]); // the flag itself is not sent
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(log.deletes.includes('sent:secret'));
  assert.ok(log.deletes.includes('invoker'));
});

test('a deferred ephemeral reply is also private', async () => {
  const { ix, log } = make();
  await ix.deferReply({ flags: MessageFlags.Ephemeral });
  await ix.editReply('quiet');
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(log.deletes.includes('sent:quiet'));
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
