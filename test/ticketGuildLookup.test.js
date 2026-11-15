// A DM to the bot must not cost a member fetch in every ticket server of the instance.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setGuildModule } from '../src/db/modules.js';
import {
  lookupTicketGuilds,
  canOpenTicketIn,
  _resetTicketLookup,
  MEMBER_PROBES_PER_DM,
  MEMBER_PROBES_PER_MINUTE,
  LOOKUP_REUSE_MS,
} from '../src/modules/tickets.js';
import { register } from '../src/bot/events/dmTickets.js';

const SENDER = { id: '700000000000000001' };
let nextId = 800000000000000000n;

/**
 * A ticket-enabled fake guild. `complete`: the member cache holds every member (so a miss means
 * "not a member"). `members`: ids that really are members (a REST fetch finds them).
 */
async function ticketGuild(fetches, { complete = false, members = [], cached = [] } = {}) {
  const guild = {
    id: String(nextId++),
    client: {},
    memberCount: complete ? 3 : 5000,
    members: {
      cache: new Map(cached.map((id) => [id, { id, partial: false }])),
      fetch: async (id) => {
        fetches.push({ guild: guild.id, id });
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

test('a sender in no server: complete caches answer without any REST fetch', async () => {
  _resetTicketLookup();
  const fetches = [];
  const guilds = [];
  for (let i = 0; i < 30; i++) guilds.push(await ticketGuild(fetches, { complete: true }));
  const r = await lookupTicketGuilds(SENDER, clientOf(guilds));
  assert.deepEqual(r, { guilds: [], incomplete: false });
  assert.equal(fetches.length, 0);
});

test('a cached member is found without a fetch, in the right server only', async () => {
  _resetTicketLookup();
  const fetches = [];
  const a = await ticketGuild(fetches, { cached: [SENDER.id] });
  const guilds = [a];
  for (let i = 0; i < 20; i++) guilds.push(await ticketGuild(fetches, { complete: true }));
  const r = await lookupTicketGuilds(SENDER, clientOf(guilds));
  assert.deepEqual(
    r.guilds.map((g) => g.id),
    [a.id]
  );
  assert.equal(fetches.length, 0);
});

test('a cached member of a server with tickets off is not offered', async () => {
  _resetTicketLookup();
  const fetches = [];
  const g = await ticketGuild(fetches, { cached: [SENDER.id] });
  await setGuildModule(g.id, 'tickets', { enabled: false });
  assert.deepEqual((await lookupTicketGuilds(SENDER, clientOf([g]))).guilds, []);
});

test('incomplete caches: fetches per DM are capped, remembered, and continue on the next DM', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const fetches = [];
  const guilds = [];
  for (let i = 0; i < 20; i++) guilds.push(await ticketGuild(fetches));
  const client = clientOf(guilds);

  const first = await lookupTicketGuilds(SENDER, client);
  assert.equal(fetches.length, MEMBER_PROBES_PER_DM);
  assert.deepEqual(first, { guilds: [], incomplete: true });

  // Sending again at once reuses the answer: no new fetches (per-user cooldown).
  await lookupTicketGuilds(SENDER, client);
  assert.equal(fetches.length, MEMBER_PROBES_PER_DM);

  // Later, the next servers are checked; the ones already known as "not a member" are skipped.
  t.mock.timers.tick(LOOKUP_REUSE_MS + 1);
  await lookupTicketGuilds(SENDER, client);
  assert.equal(fetches.length, MEMBER_PROBES_PER_DM * 2);
  t.mock.timers.tick(LOOKUP_REUSE_MS + 1);
  const last = await lookupTicketGuilds(SENDER, client);
  assert.equal(fetches.length, 20, 'each server was fetched exactly once');
  assert.equal(last.incomplete, false);
  assert.equal(new Set(fetches.map((f) => f.guild)).size, 20);
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

  await lookupTicketGuilds(SENDER, client); // first 8 servers, not found
  t.mock.timers.tick(LOOKUP_REUSE_MS + 1);
  const r = await lookupTicketGuilds(SENDER, client);
  assert.deepEqual(
    r.guilds.map((g) => g.id),
    [mine.id]
  );

  // Hint: the next lookup (everything forgotten except the hint) tries that server first.
  t.mock.timers.tick(LOOKUP_REUSE_MS + 3 * 60_000);
  fetches.length = 0;
  const again = await lookupTicketGuilds(SENDER, client);
  assert.equal(fetches[0].guild, mine.id);
  assert.deepEqual(
    again.guilds.map((g) => g.id),
    [mine.id]
  );
});

test('all DMs together stay within the per-minute fetch budget', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 3_000_000 });
  const fetches = [];
  const guilds = [];
  for (let i = 0; i < 20; i++) guilds.push(await ticketGuild(fetches));
  const client = clientOf(guilds);
  for (let u = 0; u < 40; u++)
    await lookupTicketGuilds({ id: `71000000000000${String(u).padStart(4, '0')}` }, client);
  assert.equal(fetches.length, MEMBER_PROBES_PER_MINUTE);
  const late = await lookupTicketGuilds({ id: '720000000000000000' }, client);
  assert.equal(late.incomplete, true);
  t.mock.timers.tick(61_000);
  await lookupTicketGuilds({ id: '720000000000000001' }, client);
  assert.ok(fetches.length > MEMBER_PROBES_PER_MINUTE, 'the budget resets after a minute');
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
  t.mock.timers.tick(LOOKUP_REUSE_MS + 1);
  const second = await lookupTicketGuilds(SENDER, clientOf([g]));
  assert.equal(second.guilds.length, 1);
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

test('the DM handler asks the sender to try again when the lookup was cut short', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 6_000_000 });
  const guilds = [];
  for (let i = 0; i < 12; i++) guilds.push(await ticketGuild([]));
  const replies = [];
  const message = {
    guild: null,
    partial: false,
    content: 'I need help',
    author: { id: '730000000000000001', bot: false },
    attachments: new Map(),
    client: { ...clientOf(guilds), user: { id: '555555555555555555' } },
    reply: async (text) => replies.push(text),
    react: async () => {},
  };
  const client = new EventEmitter();
  register(client);
  const settle = () => new Promise((r) => setImmediate(r));
  client.emit('messageCreate', message);
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(replies.length, 1);
  assert.match(replies[0], /could not check all servers/);

  t.mock.timers.tick(LOOKUP_REUSE_MS + 1);
  client.emit('messageCreate', message);
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(replies.length, 2);
  assert.match(replies[1], /not set up/, 'all servers checked by the second DM: a definite answer');
});

test('a platform that answers null for a non-member (and has no member cache) is handled', async () => {
  _resetTicketLookup();
  const g = await ticketGuild([]);
  g.members = { fetch: async (id) => (id === SENDER.id ? null : { id }) };
  const r = await lookupTicketGuilds(SENDER, clientOf([g]));
  assert.deepEqual(r, { guilds: [], incomplete: false });
  const mine = await ticketGuild([]);
  mine.members = { fetch: async (id) => ({ id }) };
  assert.equal((await lookupTicketGuilds({ id: '700000000000000077' }, clientOf([mine]))).guilds.length, 1);
});
