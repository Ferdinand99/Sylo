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
