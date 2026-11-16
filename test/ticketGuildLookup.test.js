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
  LONG_MEMORY_TTL_MS,
  OPEN_PROBES_PER_DM,
  OPEN_PROBES_PER_USER_PER_MINUTE,
  SHARED_OPEN_LIMIT,
  STARTER_PROBES,
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
  // Two messages a minute, as a member who retries would send them.
  for (let n = 0; n < 6; n++) {
    await lookupTicketGuilds(SENDER, client);
    if (!(await lookupTicketGuilds(SENDER, client)).incomplete) break;
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

// --- round 3: left servers, fairness, how long "not a member" is remembered ---------------------

test('a member with open tickets in servers they left costs at most one fetch per server per 10 minutes', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 20_000_000 });
  const user = { id: '750000000000000001' };
  const fetches = [];
  const guilds = [];
  for (let i = 0; i < 20; i++) {
    const g = await ticketGuild(fetches); // the member left: every fetch says unknown member
    await createTicket(g.id, user.id);
    guilds.push(g);
  }
  const client = clientOf(guilds);
  // A DM every 11 seconds for 9 minutes.
  for (let n = 0; n < 49; n++) {
    await lookupTicketGuilds(user, client);
    t.mock.timers.tick(11_000);
  }
  assert.ok(fetches.length <= 20, `${fetches.length} fetches for 20 servers in 9 minutes`);
  assert.equal(new Set(fetches.map((f) => f.guild)).size, fetches.length, 'no server asked twice');
  const settled = await lookupTicketGuilds(user, client);
  assert.deepEqual([settled.openGuilds.length, settled.openComplete], [0, true]);
  // After the memory runs out each server is asked again, still within the caps per DM and minute.
  t.mock.timers.tick(11 * 60_000);
  fetches.length = 0;
  const after = await lookupTicketGuilds(user, client);
  assert.ok(fetches.length <= 5, 'at most 5 open-ticket fetches in one DM');
  assert.equal(after.openComplete, false, 'not all checked yet: the DM handler asks again');
});

test('the open ticket checks have a cap per DM and a small allowance per user and minute', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 21_000_000 });
  const user = { id: '750000000000000002' };
  const fetches = [];
  const guilds = [];
  for (let i = 0; i < 30; i++) {
    const g = await ticketGuild(fetches, { members: [user.id] });
    await createTicket(g.id, user.id);
    guilds.push(g);
  }
  const client = clientOf(guilds);
  const first = await lookupTicketGuilds(user, client);
  assert.equal(fetches.length, OPEN_PROBES_PER_DM);
  assert.equal(first.openComplete, false);
  await lookupTicketGuilds(user, client);
  await lookupTicketGuilds(user, client);
  assert.equal(fetches.length, OPEN_PROBES_PER_USER_PER_MINUTE, 'the user allowance for open tickets');
  // It does not touch the user budget for new-ticket lookups, nor the shared one.
  const extra = await ticketGuild(fetches);
  const before = fetches.length;
  await lookupTicketGuilds(user, clientOf([extra]));
  assert.equal(fetches.length, before + 1, 'a new-ticket lookup is not blocked by the open ticket allowance');
});

test('a repeated menu pick for a server the member left costs one fetch', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 22_000_000 });
  const user = { id: '750000000000000003' };
  const fetches = [];
  const left = await ticketGuild(fetches);
  for (let n = 0; n < 30; n++) assert.equal(await canOpenTicketIn(user, left), false);
  assert.equal(fetches.length, 1);
});

test('the shared budget keeps a share for users who have used little of it', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 23_000_000 });
  const fetches = [];
  const guilds = [];
  for (let i = 0; i < 60; i++) guilds.push(await ticketGuild(fetches));
  const client = clientOf(guilds);
  // Eight busy accounts use their whole minute each.
  for (let u = 0; u < 8; u++) {
    const busy = { id: `76000000000000000${u}` };
    for (let n = 0; n < 3; n++) await lookupTicketGuilds(busy, client);
  }
  assert.ok(
    fetches.length <= SHARED_OPEN_LIMIT + STARTER_PROBES * 2,
    `the busy ones stopped at ${fetches.length}`
  );
  assert.ok(
    fetches.length < 8 * MEMBER_PROBES_PER_USER_PER_MINUTE,
    'not all of their allowance went through'
  );
  const fresh = { id: '770000000000000000' };
  const r = await lookupTicketGuilds(fresh, client);
  assert.equal(
    fetches.filter((f) => f.id === fresh.id).length,
    STARTER_PROBES,
    'a new user still gets a start'
  );
  assert.equal(r.incomplete, true);
});

test('"not a member" is remembered shortly, a refused lookup for long, and a join clears it', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 24_000_000 });
  const user = { id: '750000000000000004' };
  const fetches = [];
  const plain = await ticketGuild(fetches);
  const refusing = await ticketGuild(fetches, { refuse: true });
  const client = clientOf([plain, refusing]);
  await lookupTicketGuilds(user, client);
  assert.equal(fetches.length, 2);

  t.mock.timers.tick(NOT_MEMBER_TTL_MS + 1000);
  await lookupTicketGuilds(user, client);
  assert.deepEqual(
    fetches.slice(2).map((f) => f.guild),
    [plain.id],
    'the plain one is asked again, the refusing one is not yet'
  );

  t.mock.timers.tick(LONG_MEMORY_TTL_MS);
  await lookupTicketGuilds(user, client);
  assert.ok(
    fetches.slice(3).some((f) => f.guild === refusing.id),
    'the refusal expires too'
  );

  // A join event clears the memory at once.
  fetches.length = 0;
  await lookupTicketGuilds(user, client);
  assert.equal(fetches.length, 0, 'remembered');
  const events = new EventEmitter();
  register(events);
  events.emit('guildMemberAdd', { id: user.id, guild: plain });
  t.mock.timers.tick(LOOKUP_REUSE_MS + 1);
  await lookupTicketGuilds(user, client);
  assert.deepEqual(
    fetches.map((f) => f.guild),
    [plain.id]
  );
});

test('an open ticket server remembered as "left" does not decide an automatic new ticket elsewhere', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 25_000_000 });
  const user = { id: '780000000000000001' };
  const fetches = [];
  const x = await ticketGuild(fetches); // the member has an open ticket here, and is not a member
  await createTicket(x.id, user.id);
  const y = await ticketGuild(fetches, { cached: [user.id] }); // the only other server
  const guilds = [x, y];
  const replies = [];
  const events = new EventEmitter();
  register(events);

  // First DM: a fresh answer says not a member of X, so the one server found is used.
  events.emit('messageCreate', dmFrom(user, guilds, replies));
  await settle();
  assert.ok(await getOpenTicket(y.id, user.id), 'a fresh answer: opened in the one server found');

  // Second member, same situation, but the answer for X comes from memory (they may have come back).
  const user2 = { id: '780000000000000002' };
  const x2 = await ticketGuild(fetches);
  await createTicket(x2.id, user2.id);
  const y2 = await ticketGuild(fetches, { cached: [user2.id] });
  const first = await lookupTicketGuilds(user2, clientOf([x2, y2]));
  assert.equal(first.openRemembered, false);
  t.mock.timers.tick(LOOKUP_REUSE_MS + 1);
  const second = await lookupTicketGuilds(user2, clientOf([x2, y2]));
  assert.equal(second.openRemembered, true);
  const before = replies.length;
  events.emit('messageCreate', dmFrom(user2, [x2, y2], replies));
  await settle();
  assert.equal(await getOpenTicket(y2.id, user2.id), undefined, 'nothing opened in the other server');
  assert.equal(replies.length, before + 1);
  assert.ok(replies.at(-1).components, 'the member gets the picker');
  const options = replies.at(-1).components[0].components[0].options.map((o) => o.data.value);
  assert.deepEqual(options.sort(), [x2.id, y2.id].sort(), 'the remembered server is an option too');

  // Picking it: the member came back, so asking Discord once finds them there.
  runtime.client = clientOf([x2, y2]);
  t.after(() => {
    runtime.client = null;
  });
  x2.members.fetch = async (id) => ({ id });
  const sent = [];
  await routeComponent({
    customId: 'ticket-guild',
    values: [x2.id],
    user: { ...user2, tag: 'tester#0002', send: async () => {} },
    client: runtime.client,
    isRepliable: () => true,
    update: async (x) => sent.push(x),
    reply: async (x) => sent.push(x),
  });
  assert.match(sent.at(-1).content, /Opened ticket/);
  const ticket = await getOpenTicket(x2.id, user2.id);
  assert.equal((await ticketMessages(ticket.id)).length, 1, 'the message went to the open ticket');
});
