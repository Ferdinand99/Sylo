import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import {
  platformOfClient,
  platformOfGuild,
  guildSupports,
  guildKey,
  guildKeyOf,
  allGuilds,
  guildByKey,
  anyClientReady,
  allClientsReady,
  keyedGuild,
  allGuildKeys,
} from '../src/platform/platformOf.js';
import { supports } from '../src/platform/capabilities.js';

const discord = { name: 'discord-client' };
const fluxer = { name: 'fluxer-client' };

test.beforeEach(() => {
  runtime.clients.discord = discord;
  runtime.clients.fluxer = fluxer;
});
test.after(() => {
  runtime.clients.discord = null;
  runtime.clients.fluxer = null;
});

test('a client is identified by which runtime slot holds it', () => {
  assert.equal(platformOfClient(fluxer), 'fluxer');
  assert.equal(platformOfClient(discord), 'discord');
});

test('anything unknown is Discord, the platform every existing code path assumes', () => {
  assert.equal(platformOfClient(undefined), 'discord');
  assert.equal(platformOfClient({ other: true }), 'discord');
  runtime.clients.fluxer = null;
  assert.equal(platformOfClient(undefined), 'discord');
});

test('a guild belongs to the platform of its client', () => {
  assert.equal(platformOfGuild({ client: fluxer }), 'fluxer');
  assert.equal(platformOfGuild({ client: discord }), 'discord');
  assert.equal(platformOfGuild({}), 'discord');
  assert.equal(platformOfGuild(null), 'discord');
});

test('guildSupports asks the capability table for the guild platform', () => {
  assert.equal(guildSupports({ client: fluxer }, 'nativeAutomod'), false);
  assert.equal(guildSupports({ client: discord }, 'nativeAutomod'), true);
});

test('the capability table: Discord has everything, Fluxer lacks what it has no API for', () => {
  for (const f of ['components', 'nativeAutomod', 'threads', 'moveMembers', 'slashCommands'])
    assert.equal(supports('discord', f), true, f);
  for (const f of ['components', 'nativeAutomod', 'threads', 'moveMembers', 'slashCommands'])
    assert.equal(supports('fluxer', f), false, f);
});

// --- guild keys: the id every DB row, timer and dashboard URL uses ------------

const RAW = '900000000000000123';

test('guildKey: a Discord guild keeps its bare id, a Fluxer guild gets the fluxer: prefix', () => {
  assert.equal(guildKey({ id: RAW, client: discord }), RAW);
  assert.equal(guildKey({ id: RAW, client: fluxer }), `fluxer:${RAW}`);
  assert.equal(guildKey({ id: RAW }), RAW); // no client: Discord, as every existing test fake assumes
  assert.equal(guildKey({ id: 'g1', client: discord }), 'g1'); // test-style ids pass through on Discord
});

test('guildKey never prefixes twice (an interaction guild already carries the key)', () => {
  assert.equal(guildKey({ id: `fluxer:${RAW}`, client: fluxer }), `fluxer:${RAW}`);
});

test('guildKeyOf: reads the guild from a message, member, channel or ban', () => {
  const guild = { id: RAW, client: fluxer };
  assert.equal(guildKeyOf({ guild }), `fluxer:${RAW}`);
  assert.equal(guildKeyOf({ guildId: RAW, client: fluxer }), `fluxer:${RAW}`);
  assert.equal(guildKeyOf({ guildId: RAW, client: discord }), RAW);
  assert.equal(guildKeyOf({}), null);
  assert.equal(guildKeyOf(null), null);
});

test('allGuilds: every guild of every connected client; a missing platform contributes nothing', () => {
  const d1 = { id: 'd1' };
  const f1 = { id: 'f1' };
  runtime.clients.discord = { guilds: { cache: new Map([['d1', d1]]) } };
  runtime.clients.fluxer = { guilds: { cache: new Map([['f1', f1]]) } };
  assert.deepEqual(allGuilds(), [d1, f1]);
  runtime.clients.fluxer = null;
  assert.deepEqual(allGuilds(), [d1]);
  runtime.clients.discord = null;
  assert.deepEqual(allGuilds(), []);
});

test('guildByKey: finds the guild a stored key refers to, on the right platform', () => {
  const d = { id: RAW };
  const f = { id: RAW };
  runtime.clients.discord = { guilds: { cache: new Map([[RAW, d]]) } };
  runtime.clients.fluxer = { guilds: { cache: new Map([[RAW, f]]) } };
  assert.equal(guildByKey(RAW), d);
  assert.equal(guildByKey(`fluxer:${RAW}`), f);
  assert.equal(guildByKey('nope'), undefined);
  assert.equal(guildByKey(null), undefined);
  runtime.clients.fluxer = null;
  assert.equal(guildByKey(`fluxer:${RAW}`), undefined); // platform not connected
});

test('guildByKey falls back to Discord for non-snowflake ids (legacy test fixtures)', () => {
  const g = { id: 'g1' };
  runtime.clients.discord = { guilds: { cache: new Map([['g1', g]]) } };
  assert.equal(guildByKey('g1'), g);
});

test('anyClientReady: true when at least one connected client is ready', () => {
  runtime.clients.discord = { isReady: () => false };
  runtime.clients.fluxer = null;
  assert.equal(anyClientReady(), false);
  runtime.clients.fluxer = { isReady: () => true };
  assert.equal(anyClientReady(), true); // a Fluxer-only deployment still runs its sweeps
  runtime.clients.fluxer = null;
  runtime.clients.discord = { isReady: () => true };
  assert.equal(anyClientReady(), true);
  runtime.clients.discord = null;
  assert.equal(anyClientReady(), false);
});

test('keyedGuild: a Discord guild is returned untouched', () => {
  const g = { id: RAW, client: discord, name: 'D' };
  assert.equal(keyedGuild(g), g);
  assert.equal(keyedGuild(null), null);
  assert.equal(keyedGuild(undefined), null);
});

test('keyedGuild: a Fluxer guild reports its key as .id and the SDK object for everything else', () => {
  const calls = [];
  const real = {
    id: RAW,
    client: fluxer,
    name: 'F',
    channels: { cache: new Map([['c', 1]]) },
    rawIdSeenByMethod() {
      calls.push(this.id);
      return this.id;
    },
  };
  const g = keyedGuild(real);
  assert.equal(g.id, `fluxer:${RAW}`);
  assert.equal(g.name, 'F');
  assert.equal(g.channels, real.channels);
  assert.equal(g.client, fluxer);
  // Methods run against the real guild, so the SDK still sees its own id.
  assert.equal(g.rawIdSeenByMethod(), RAW);
  assert.equal(guildKey(g), `fluxer:${RAW}`); // and the key is stable through the wrapper
});

test('rawGuildId gives the platform id even through keyedGuild', async () => {
  const { rawGuildId } = await import('../src/platform/platformOf.js');
  const real = { id: RAW, client: fluxer };
  assert.equal(rawGuildId(keyedGuild(real)), RAW);
  assert.equal(rawGuildId({ id: RAW, client: discord }), RAW);
});

test('allGuildKeys: the key of every guild on every connected platform', () => {
  runtime.clients.discord = {
    guilds: {
      cache: new Map([
        [RAW, {}],
        ['g1', {}],
      ]),
    },
  };
  runtime.clients.fluxer = { guilds: { cache: new Map([[RAW, {}]]) } };
  assert.deepEqual(allGuildKeys(), [RAW, 'g1', `fluxer:${RAW}`]);
  runtime.clients.fluxer = null;
  runtime.clients.discord = null;
  assert.deepEqual(allGuildKeys(), []);
});

test('allClientsReady: every connected client must be ready, so a sweep never reads a down platform as "guild gone"', () => {
  runtime.clients.discord = null;
  runtime.clients.fluxer = null;
  assert.equal(allClientsReady(), false); // nothing connected
  runtime.clients.discord = { isReady: () => true };
  assert.equal(allClientsReady(), true);
  runtime.clients.fluxer = { isReady: () => false }; // registered, still logging in or reconnecting
  assert.equal(allClientsReady(), false);
  runtime.clients.fluxer = { isReady: () => true };
  assert.equal(allClientsReady(), true);
  runtime.clients.discord = null;
  runtime.clients.fluxer = null;
});
