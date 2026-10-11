import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime, setClient, clientFor, setClientFor, isDiscordReady, guildCount } from '../src/runtime.js';

test('runtime.client read/write alias runtime.clients.discord (back-compat)', () => {
  const fake = { isReady: () => true, guilds: { cache: new Map([['a', 1]]) } };
  runtime.client = fake; // direct assignment, as the existing test suite does throughout
  assert.equal(runtime.clients.discord, fake);
  assert.equal(runtime.client, fake);
  runtime.client = null;
  assert.equal(runtime.clients.discord, null);
});

test('setClient() sets the Discord client via the new clients map', () => {
  const fake = { isReady: () => true, guilds: { cache: new Map() } };
  setClient(fake);
  assert.equal(clientFor('discord'), fake);
  assert.equal(runtime.client, fake);
  setClient(null);
});

test('setClientFor()/clientFor() work for an arbitrary platform', () => {
  const fakeFluxer = { isReady: () => true };
  setClientFor('fluxer', fakeFluxer);
  assert.equal(clientFor('fluxer'), fakeFluxer);
  assert.equal(runtime.clients.fluxer, fakeFluxer);
  setClientFor('fluxer', null);
});

test('clientFor() returns null for a platform with no client set', () => {
  assert.equal(clientFor('fluxer'), null);
});

test('isDiscordReady()/guildCount() keep reading the Discord client unchanged', () => {
  assert.equal(isDiscordReady(), false);
  assert.equal(guildCount(), 0);
  setClient({
    isReady: () => true,
    guilds: {
      cache: new Map([
        ['a', 1],
        ['b', 2],
      ]),
    },
  });
  assert.equal(isDiscordReady(), true);
  assert.equal(guildCount(), 2);
  setClient(null);
});
