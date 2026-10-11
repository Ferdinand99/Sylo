import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { platformOfClient, platformOfGuild, guildSupports } from '../src/platform/platformOf.js';
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
  for (const f of ['components', 'nativeAutomod', 'threads', 'moveMembers'])
    assert.equal(supports('discord', f), true, f);
  for (const f of ['components', 'nativeAutomod', 'threads', 'moveMembers'])
    assert.equal(supports('fluxer', f), false, f);
});
