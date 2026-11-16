// A DM to the bot must not cost a member fetch in every ticket server of the instance, and a
// lookup that the caps cut short must never send a DM to the wrong server.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setGuildModule } from '../src/db/modules.js';
import { createTicket, getOpenTicket, ticketMessages, openTicketGuildKeys } from '../src/db/tickets.js';
import {
  lookupTicketGuilds,
  canOpenTicketIn,
  _resetTicketLookup,
  MEMBER_PROBES_PER_DM,
  MEMBER_PROBES_PER_MINUTE,
  MEMBER_PROBES_PER_USER_PER_MINUTE,
  LOOKUP_REUSE_MS,
  NOT_MEMBER_TTL_MS,
} from '../src/modules/tickets.js';
import { register } from '../src/bot/events/dmTickets.js';
import { routeComponent } from '../src/bot/lib/components.js';
import { runtime } from '../src/runtime.js';

const SENDER = { id: '700000000000000001' };
let nextId = 800000000000000000n;

/**
 * A ticket-enabled fake guild. `complete`: the member cache holds every member (so a miss means
 * "not a member"). `members`: ids that really are members (a REST fetch finds them). `refuse`:
 * every fetch answers 403 (the bot may not look in this server).
 */
async function ticketGuild(fetches, { complete = false, members = [], cached = [], refuse = false } = {}) {
  const guild = {
    id: String(nextId++),
    name: 'Test server',
    client: {},
    memberCount: complete ? 3 : 5000,
    channels: { cache: new Map(), fetch: async () => null },
    members: {
      cache: new Map(cached.map((id) => [id, { id, partial: false }])),
      fetch: async (id) => {
        fetches.push({ guild: guild.id, id });
        if (refuse) throw Object.assign(new Error('Missing Access'), { status: 403, code: 50001 });
        if (members.includes(id)) return { id };
        throw Object.assign(new Error('Unknown Member'), { code: 10007 });
      },
    },
  };
  if (complete) for (let i = guild.members.cache.size; i < 3; i++) guild.members.cache.set(`x${i}`, {});
  await setGuildModule(guild.id, 'tickets', { enabled: true });
  return guild;
}

const clientOf = (guilds) => ({ guilds: { cache: new Map(guilds.map((g) => [g.id, g])) } });
const ids = (guilds) => guilds.map((g) => g.id);

test('a sender in no server: complete caches answer without any REST fetch', async () => {
  _resetTicketLookup();
  const fetches = [];
  const guilds = [];
  for (let i = 0; i < 30; i++) guilds.push(await ticketGuild(fetches, { complete: true }));
  const r = await lookupTicketGuilds(SENDER, clientOf(guilds));
  assert.deepEqual([r.guilds, r.openGuilds, r.incomplete], [[], [], false]);
  assert.equal(fetches.length, 0);
});

test('a cached member is found without a fetch, in the right server only', async () => {
  _resetTicketLookup();
  const fetches = [];
  const a = await ticketGuild(fetches, { cached: [SENDER.id] });
  const guilds = [a];
  for (let i = 0; i < 20; i++) guilds.push(await ticketGuild(fetches, { complete: true }));
  const r = await lookupTicketGuilds(SENDER, clientOf(guilds));
  assert.deepEqual(ids(r.guilds), [a.id]);
  assert.equal(fetches.length, 0);
});

test('a cached member of a server with tickets off is not offered', async () => {
  _resetTicketLookup();
  const fetches = [];
  const g = await ticketGuild(fetches, { cached: [SENDER.id] });
  await setGuildModule(g.id, 'tickets', { enabled: false });
  assert.deepEqual((await lookupTicketGuilds(SENDER, clientOf([g]))).guilds, []);
});

test('incomplete caches: fetches are capped per DM and per user, remembered, and a retry makes progress', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const fetches = [];
  const guilds = [];
  for (let i = 0; i < 40; i++) guilds.push(await ticketGuild(fetches));
  const client = clientOf(guilds);

  const first = await lookupTicketGuilds(SENDER, client);
  assert.equal(fetches.length, MEMBER_PROBES_PER_DM);
  assert.equal(first.incomplete, true);

  // A retry at once is not answered from the first, incomplete answer: it checks the next servers.
  await lookupTicketGuilds(SENDER, client);
  assert.equal(fetches.length, MEMBER_PROBES_PER_DM * 2);
  assert.equal(new Set(fetches.map((f) => f.guild)).size, fetches.length, 'no server asked twice');

  // The user's own budget for the minute is used up: no more fetches until it renews.
  assert.equal(MEMBER_PROBES_PER_USER_PER_MINUTE, MEMBER_PROBES_PER_DM * 2);
  const third = await lookupTicketGuilds(SENDER, client);
  assert.equal(fetches.length, MEMBER_PROBES_PER_DM * 2);
  assert.equal(third.incomplete, true);

  t.mock.timers.tick(61_000);
  for (let n = 0; n < 6 && (await lookupTicketGuilds(SENDER, client)).incomplete; n++) {
    t.mock.timers.tick(61_000);
  }
  assert.equal(fetches.length, 40, 'each server was fetched exactly once');
});

test('a complete answer is reused for a few seconds', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 1_500_000 });
  const fetches = [];
  const guilds = [await ticketGuild(fetches), await ticketGuild(fetches)];
  await lookupTicketGuilds(SENDER, clientOf(guilds));
  await lookupTicketGuilds(SENDER, clientOf(guilds));
  assert.equal(fetches.length, 2);
  t.mock.timers.tick(LOOKUP_REUSE_MS + 1);
  await lookupTicketGuilds(SENDER, clientOf(guilds));
  assert.equal(fetches.length, 2, 'the not-a-member answers are still remembered');
  t.mock.timers.tick(NOT_MEMBER_TTL_MS);
  await lookupTicketGuilds(SENDER, clientOf(guilds));
  assert.equal(fetches.length, 4);
});

test('a real member in a late server is found, and found first the next time', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 2_000_000 });
  const fetches = [];
  const guilds = [];
  for (let i = 0; i < 12; i++) guilds.push(await ticketGuild(fetches));
  const mine = await ticketGuild(fetches, { members: [SENDER.id] });
  guilds.push(mine);
  const client = clientOf(guilds);

  const first = await lookupTicketGuilds(SENDER, client); // first 8 servers, not found
  assert.equal(first.incomplete, true);
  const r = await lookupTicketGuilds(SENDER, client);
  assert.deepEqual(ids(r.guilds), [mine.id]);

  // Hint: later (everything else forgotten) the next lookup tries that server first.
  t.mock.timers.tick(LOOKUP_REUSE_MS + 3 * 60_000);
  fetches.length = 0;
  const again = await lookupTicketGuilds(SENDER, client);
  assert.equal(fetches[0].guild, mine.id);
  assert.deepEqual(ids(again.guilds), [mine.id]);
});

test('all users together stay within the per-minute fetch budget', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 3_000_000 });
  const fetches = [];
  const guilds = [];
  for (let i = 0; i < 20; i++) guilds.push(await ticketGuild(fetches));
  const client = clientOf(guilds);
  for (let u = 0; u < 40; u++) {
    await lookupTicketGuilds({ id: `71000000000000${String(u).padStart(4, '0')}` }, client);
  }
  assert.equal(fetches.length, MEMBER_PROBES_PER_MINUTE);
  const late = await lookupTicketGuilds({ id: '720000000000000000' }, client);
  assert.equal(late.incomplete, true);
  t.mock.timers.tick(61_000);
  await lookupTicketGuilds({ id: '720000000000000001' }, client);
  assert.ok(fetches.length > MEMBER_PROBES_PER_MINUTE, 'the budget resets after a minute');
});

test('one user cannot use the whole budget: another user still gets fetches', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 3_500_000 });
  const fetches = [];
  const guilds = [];
  for (let i = 0; i < 60; i++) guilds.push(await ticketGuild(fetches));
  const client = clientOf(guilds);
  for (let n = 0; n < 20; n++) await lookupTicketGuilds(SENDER, client); // way over its own budget
  assert.equal(fetches.filter((f) => f.id === SENDER.id).length, MEMBER_PROBES_PER_USER_PER_MINUTE);
  const other = { id: '730000000000000009' };
  await lookupTicketGuilds(other, client);
  assert.equal(fetches.filter((f) => f.id === other.id).length, MEMBER_PROBES_PER_DM);
});

test('a rate limit error is not remembered as "not a member"', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 4_000_000 });
  const g = await ticketGuild([]);
  let calls = 0;
  g.members.fetch = async (id) => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('rate limited'), { status: 429 });
    return { id };
  };
  const first = await lookupTicketGuilds(SENDER, clientOf([g]));
  assert.equal(first.incomplete, true);
  const second = await lookupTicketGuilds(SENDER, clientOf([g]));
  assert.equal(second.guilds.length, 1);
});

test('a server that refuses member lookups (403) is skipped for a while and does not keep the sender waiting', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 4_500_000 });
  const fetches = [];
  const refusing = await ticketGuild(fetches, { refuse: true });
  const client = clientOf([refusing]);
  const first = await lookupTicketGuilds(SENDER, client);
  assert.deepEqual(
    [first.guilds.length, first.incomplete],
    [0, false],
    'a definite answer, not "send again"'
  );
  t.mock.timers.tick(LOOKUP_REUSE_MS + 1);
  await lookupTicketGuilds(SENDER, client);
  assert.equal(fetches.length, 1, 'not asked again within the remember time');
});

test('canOpenTicketIn: cache, or the lookup that just ran, or one fetch', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
  const fetches = [];
  const cachedIn = await ticketGuild(fetches, { cached: [SENDER.id] });
  const memberOf = await ticketGuild(fetches, { members: [SENDER.id] });
  const notIn = await ticketGuild(fetches);
  const completeNot = await ticketGuild(fetches, { complete: true });
  assert.equal(await canOpenTicketIn(SENDER, cachedIn), true);
  assert.equal(fetches.length, 0);
  assert.equal(await canOpenTicketIn(SENDER, completeNot), false);
  assert.equal(fetches.length, 0);
  assert.equal(await canOpenTicketIn(SENDER, memberOf), true);
  assert.equal(await canOpenTicketIn(SENDER, notIn), false);
  assert.equal(fetches.length, 2);
  await setGuildModule(cachedIn.id, 'tickets', { enabled: false });
  assert.equal(await canOpenTicketIn(SENDER, cachedIn), false);
});

test('a platform that answers null for a non-member (and has no member cache) is handled', async () => {
  _resetTicketLookup();
  const g = await ticketGuild([]);
  g.members = { fetch: async (id) => (id === SENDER.id ? null : { id }) };
  const r = await lookupTicketGuilds(SENDER, clientOf([g]));
  assert.deepEqual([r.guilds, r.incomplete], [[], false]);
  const mine = await ticketGuild([]);
  mine.members = { fetch: async (id) => ({ id }) };
  assert.equal((await lookupTicketGuilds({ id: '700000000000000077' }, clientOf([mine]))).guilds.length, 1);
});

// --- open tickets decide where a follow-up goes -------------------------------------------------

test('an open ticket is found from the database, beyond the per-DM cap and without the budgets', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 6_000_000 });
  const fetches = [];
  const guilds = [];
  for (let i = 0; i < 40; i++) guilds.push(await ticketGuild(fetches));
  const x = await ticketGuild(fetches, { members: [SENDER.id] });
  guilds.push(x);
  await createTicket(x.id, SENDER.id);
  assert.deepEqual(await openTicketGuildKeys(SENDER.id), [x.id]);

  const r = await lookupTicketGuilds(SENDER, clientOf(guilds));
  assert.deepEqual(ids(r.openGuilds), [x.id]);
  assert.equal(r.openComplete, true);
  assert.equal(fetches[0].guild, x.id, 'the open ticket server is checked first');
  assert.equal(r.incomplete, true, 'the rest was cut short');

  // Even with the user budget used up, the open ticket server is still found.
  await lookupTicketGuilds(SENDER, clientOf(guilds));
  const again = await lookupTicketGuilds(SENDER, clientOf(guilds));
  assert.equal(again.incomplete, true);
  assert.deepEqual(ids(again.openGuilds), [x.id]);
});

function dmFrom(user, guilds, replies) {
  return {
    guild: null,
    partial: false,
    content: 'follow-up message',
    author: { ...user, bot: false, tag: 'tester#0001', send: async () => {} },
    attachments: new Map(),
    client: { ...clientOf(guilds), user: { id: '555555555555555555' } },
    reply: async (x) => replies.push(x),
    react: async () => {},
  };
}
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

test('a follow-up DM goes to the server with the open ticket, not to another server found first', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 7_000_000 });
  const user = { id: '740000000000000001' };
  const fetches = [];
  const y = await ticketGuild(fetches, { cached: [user.id] }); // cached, first in cache order
  const filler = [];
  for (let i = 0; i < 14; i++) filler.push(await ticketGuild(fetches));
  const x = await ticketGuild(fetches, { members: [user.id] }); // not cached, beyond the cap
  await createTicket(x.id, user.id);
  const guilds = [y, ...filler, x];

  const replies = [];
  const client = new EventEmitter();
  register(client);
  client.emit('messageCreate', dmFrom(user, guilds, replies));
  await settle();

  const inX = await getOpenTicket(x.id, user.id);
  assert.equal((await ticketMessages(inX.id)).length, 1, 'the follow-up is in the open ticket');
  assert.equal(await getOpenTicket(y.id, user.id), undefined, 'nothing was opened in the other server');
  assert.deepEqual(replies, []);
});

test('with no open ticket and a cut-short lookup, no ticket is opened: the member is asked to send again', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 8_000_000 });
  const user = { id: '740000000000000002' };
  const fetches = [];
  const y = await ticketGuild(fetches, { cached: [user.id] });
  const filler = [];
  for (let i = 0; i < 14; i++) filler.push(await ticketGuild(fetches));
  const guilds = [y, ...filler];

  const replies = [];
  const client = new EventEmitter();
  register(client);
  client.emit('messageCreate', dmFrom(user, guilds, replies));
  await settle();
  assert.equal(await getOpenTicket(y.id, user.id), undefined, 'not opened in the only server found');
  assert.equal(replies.length, 1);
  assert.match(replies[0], /could not check all servers yet/);

  // The retry continues with the servers not yet checked, and then goes through.
  client.emit('messageCreate', dmFrom(user, guilds, replies));
  await settle();
  assert.ok(await getOpenTicket(y.id, user.id), 'all servers checked: now it opens in the one server');
});

test('a refused server pick keeps the stashed message and the menu', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 9_000_000 });
  const user = { id: '740000000000000003' };
  const fetches = [];
  const a = await ticketGuild(fetches, { cached: [user.id] });
  const b = await ticketGuild(fetches, { cached: [user.id] });
  runtime.client = clientOf([a, b]);
  t.after(() => {
    runtime.client = null;
  });
  const replies = [];
  const client = new EventEmitter();
  register(client);
  client.emit('messageCreate', dmFrom(user, [a, b], replies));
  await settle();
  assert.equal(replies.length, 1);
  assert.ok(replies[0].components, 'the picker');

  const sent = [];
  const pick = (guild) => ({
    customId: 'ticket-guild',
    values: [guild.id],
    user: { ...user, tag: 'tester#0001', send: async () => {} },
    client: { guilds: { cache: new Map([[a.id, a]]) } },
    isRepliable: () => true,
    update: async (x) => sent.push(['update', x]),
    reply: async (x) => sent.push(['reply', x]),
  });
  // A server the bot does not know (or cannot confirm): refused, nothing lost.
  const ghost = { id: '999999999999999999' };
  await routeComponent(pick(ghost));
  assert.equal(sent.at(-1)[0], 'reply');
  assert.match(sent.at(-1)[1].content, /could not confirm/);
  // Picking a real one afterwards still works: the message was kept.
  await routeComponent(pick(a));
  assert.equal(sent.at(-1)[0], 'update');
  assert.match(sent.at(-1)[1].content, /Opened ticket/);
});

test('the DM handler asks the sender to try again when the lookup was cut short, then answers for real', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 10_000_000 });
  const user = { id: '740000000000000004' };
  const guilds = [];
  for (let i = 0; i < 12; i++) guilds.push(await ticketGuild([]));
  const replies = [];
  const client = new EventEmitter();
  register(client);
  client.emit('messageCreate', dmFrom(user, guilds, replies));
  await settle();
  assert.equal(replies.length, 1);
  assert.match(replies[0], /could not check all servers/);

  client.emit('messageCreate', dmFrom(user, guilds, replies));
  await settle();
  assert.equal(replies.length, 2);
  assert.match(replies[1], /not set up/, 'all servers checked by the second DM: a definite answer');
});
