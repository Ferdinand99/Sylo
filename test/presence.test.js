import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getPresenceConfig, setPresenceConfig } from '../src/db/appSettings.js';
import { fillPresenceText } from '../src/bot/lib/presence.js';

test('presence config: default before anything is saved', async () => {
  const p = await getPresenceConfig();
  assert.equal(p.status, 'online');
  assert.equal(p.type, 'Listening');
  assert.ok(p.text.length > 0);
});

test('presence config: round-trips and sanitises', async () => {
  await setPresenceConfig({ status: 'dnd', type: 'Watching', text: 'over {servers} servers' });
  const p = await getPresenceConfig();
  assert.equal(p.status, 'dnd');
  assert.equal(p.type, 'Watching');
  assert.equal(p.text, 'over {servers} servers');

  const bad = await setPresenceConfig({ status: 'nonsense', type: 'nope', text: 'x'.repeat(300) });
  assert.equal(bad.status, 'online');
  assert.equal(bad.type, 'Custom');
  assert.equal(bad.text.length, 128);
});

test('fillPresenceText substitutes {servers} and {members}', () => {
  const client = {
    guilds: {
      cache: new Map([
        ['1', { memberCount: 10 }],
        ['2', { memberCount: 5 }],
      ]),
    },
  };
  assert.equal(
    fillPresenceText('in {servers} servers, {members} members', client),
    'in 2 servers, 15 members'
  );
});

test('random presence texts persist, trim empty rows, deduplicate and clamp intervals', async () => {
  const config = await setPresenceConfig({
    status: 'online',
    type: 'Custom',
    text: 'fallback',
    texts: 'pizza\n\n  frytki  \npizza',
    rotationSeconds: 1,
  });
  assert.deepEqual(config.texts, ['pizza', 'frytki']);
  assert.equal(config.rotationSeconds, 10);
  assert.deepEqual((await getPresenceConfig()).texts, ['pizza', 'frytki']);
  const capped = await setPresenceConfig({
    texts: Array.from({ length: 150 }, (_, i) => `${i}${'x'.repeat(150)}`),
    rotationSeconds: 99999,
  });
  assert.equal(capped.texts.length, 100);
  assert.ok(capped.texts.every((text) => text.length === 128));
  assert.equal(capped.rotationSeconds, 3600);
});

test('presence rotation waits for configured interval, avoids immediate repeats and keeps placeholders', async () => {
  const { applyPresence } = await import('../src/bot/lib/presence.js');
  const updates = [];
  const client = {
    guilds: { cache: new Map([['1', { memberCount: 12 }]]) },
    user: { setPresence: (value) => updates.push(value) },
  };
  await setPresenceConfig({
    status: 'dnd',
    type: 'Custom',
    text: 'fallback',
    texts: ['pizza {members}', 'frytki'],
    rotationSeconds: 60,
  });
  await applyPresence(client, { force: false, now: 0, random: () => 0 });
  assert.equal(updates[0].activities[0].state, 'pizza 12');
  await applyPresence(client, { force: false, now: 30000, random: () => 0 });
  assert.equal(updates.length, 1);
  await applyPresence(client, { force: false, now: 60000, random: () => 0 });
  assert.equal(updates[1].activities[0].state, 'frytki');
  await applyPresence(client, { force: false, now: 120000, random: () => 0 });
  assert.equal(updates[2].activities[0].state, 'pizza 12');
  await setPresenceConfig({ status: 'online', type: 'Playing', text: 'nowy status', texts: [] });
  await applyPresence(client, { force: false, now: 120001 });
  assert.equal(updates[3].activities[0].name, 'nowy status');
});

test('ten-second rotation is saved and updates at ten seconds, not earlier', async () => {
  const { applyPresence } = await import('../src/bot/lib/presence.js');
  const updates = [];
  const client = { guilds: { cache: new Map() }, user: { setPresence: (value) => updates.push(value) } };
  await setPresenceConfig({ status: 'online', type: 'Custom', texts: ['a', 'b'], rotationSeconds: 10 });
  assert.equal((await getPresenceConfig()).rotationSeconds, 10);
  await applyPresence(client, { force: false, now: 0, random: () => 0 });
  await applyPresence(client, { force: false, now: 9999, random: () => 0 });
  assert.equal(updates.length, 1);
  await applyPresence(client, { force: false, now: 10000, random: () => 0 });
  assert.equal(updates.length, 2);
  assert.equal(updates[1].activities[0].state, 'b');
});

test('presence pool exhausts every line before repeating, including cycle boundaries', async () => {
  const { applyPresence } = await import('../src/bot/lib/presence.js');
  const updates = [];
  const client = {
    guilds: { cache: new Map() },
    user: { setPresence: (v) => updates.push(v.activities[0].state) },
  };
  const texts = ['a', 'b', 'c', 'd'];
  await setPresenceConfig({ type: 'Custom', texts, rotationSeconds: 10 });
  for (let i = 0; i < 24; i++) {
    await applyPresence(client, { force: false, now: i * 10000, random: () => (Math.floor(i / texts.length) % 2 ? 0.999 : 0) });
  }
  for (let i = 0; i < updates.length; i += texts.length) {
    assert.deepEqual([...updates.slice(i, i + texts.length)].sort(), texts);
  }
  for (let i = 1; i < updates.length; i++) assert.notEqual(updates[i], updates[i - 1]);
});

test('presence pool survives timing/status edits, restarts on list edits and is per-client', async () => {
  const { applyPresence } = await import('../src/bot/lib/presence.js');
  const updates = [];
  const client = {
    guilds: { cache: new Map() },
    user: { setPresence: (v) => updates.push(v.activities[0].state) },
  };
  await setPresenceConfig({ type: 'Custom', texts: ['a', 'b', 'c'], rotationSeconds: 10 });
  await applyPresence(client, { now: 0, random: () => 0 });
  await setPresenceConfig({ status: 'dnd', type: 'Custom', texts: ['a', 'b', 'c'], rotationSeconds: 20 });
  await applyPresence(client, { now: 1, random: () => 0 });
  await applyPresence(client, { now: 2, random: () => 0 });
  assert.deepEqual(updates, ['a', 'b', 'c']);
  const other = {
    guilds: { cache: new Map() },
    user: { setPresence: (v) => updates.push(v.activities[0].state) },
  };
  await applyPresence(other, { now: 3, random: () => 0 });
  assert.equal(updates.at(-1), 'a');
  await setPresenceConfig({ type: 'Custom', texts: ['x', 'y'], rotationSeconds: 10 });
  await applyPresence(client, { now: 4, random: () => 0 });
  await applyPresence(client, { now: 5, random: () => 0 });
  assert.deepEqual(updates.slice(-2), ['x', 'y']);
});

test('presence pool handles a single line and does not consume failed updates', async () => {
  const { applyPresence } = await import('../src/bot/lib/presence.js');
  const updates = [];
  let fail = false;
  const client = {
    guilds: { cache: new Map() },
    user: {
      setPresence: (v) => {
        if (fail) throw new Error('test failure');
        updates.push(v.activities[0].state);
      },
    },
  };
  await setPresenceConfig({ type: 'Custom', texts: ['only'], rotationSeconds: 10 });
  await applyPresence(client, { now: 0 });
  await applyPresence(client, { now: 10000 });
  assert.deepEqual(updates, ['only', 'only']);
  await setPresenceConfig({ type: 'Custom', texts: ['a', 'b', 'c'], rotationSeconds: 10 });
  await applyPresence(client, { now: 20000, random: () => 0 });
  fail = true;
  await applyPresence(client, { now: 30000, random: () => 0 });
  fail = false;
  await applyPresence(client, { now: 30001, random: () => 0 });
  await applyPresence(client, { now: 40001, random: () => 0 });
  assert.deepEqual(updates.slice(-3), ['a', 'b', 'c']);
});
