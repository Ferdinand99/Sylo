// The plain-words summary of a module on the overview ("#welcome · Verified role", "Not set up yet"): the
// wording per module, and that no card falls back to words like "Status: enabled" or "Channel: set".
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { setGuildModule } from '../src/db/modules.js';
import { buildOverview } from '../src/web/lib/overviewSummary.js';
import { summaryInfo, summaryParts, waitsForOwnerKeys } from '../src/web/lib/cardSummary.js';
import { config } from '../src/config.js';
import { MODULES } from '../src/modules/registry.js';

const G = '700000000000000555';
const line = (label, value, state) => ({ label, value, state });

test('a module with nothing set says "Not set up yet"', () => {
  assert.deepEqual(
    summaryParts('logging', [
      line('Log channel', 'not set', 'off'),
      line('Events tracked', '0 of 12', 'off'),
    ]),
    ['Not set up yet']
  );
  assert.deepEqual(
    summaryParts('twitch-alerts', [line('Streamers', 'none', 'off'), line('API', 'x', 'off')]),
    ['Waiting for the bot owner'],
    'missing keys come first: nothing will ever post'
  );
  assert.deepEqual(summaryParts('rss', [line('Feeds', 'none', 'off')]), ['No feeds yet']);
});

test('channels and roles read as #channel and "Name role"', () => {
  assert.deepEqual(
    summaryParts('welcome', [
      line('Welcome when', 'a member gets Verified', 'on'),
      line('Welcome message', '#welcome', 'on'),
      line('Leave message', 'off', 'off'),
      line('Welcome DM', 'on', 'on'),
    ]),
    ['#welcome', 'Verified role', 'DM']
  );
  assert.deepEqual(
    summaryParts('verification', [
      line('Verified role', '@Member', 'on'),
      line('Channel', '#welcome', 'on'),
      line('Mode', 'button', 'neutral'),
    ]),
    ['Member role', '#welcome']
  );
  assert.deepEqual(
    summaryParts('logging', [
      line('Log channel', '#server-log', 'on'),
      line('Events tracked', '8 of 12', 'on'),
    ]),
    ['#server-log', '8 of 12 events']
  );
});

test('counts are nouns with the right plural, and zero says nothing', () => {
  assert.deepEqual(
    summaryParts('twitch-alerts', [line('Streamers', '1', 'on'), line('API', 'connected', 'neutral')]),
    ['1 streamer']
  );
  assert.deepEqual(summaryParts('rss', [line('Feeds', '2', 'on')]), ['2 feeds']);
  assert.deepEqual(
    summaryParts('polls', [
      line('Open polls', '0', 'neutral'),
      line('Vote restriction', 'everyone', 'neutral'),
    ]),
    []
  );
  assert.deepEqual(
    summaryParts('economy', [
      line('Currency', '🪙 Harbor Coins', 'neutral'),
      line('Accounts', '10', 'neutral'),
      line('Robbing', 'on', 'on'),
    ]),
    ['🪙 Harbor Coins', '10 accounts', 'robbing on']
  );
  assert.deepEqual(
    summaryParts('economy', [
      line('Currency', '🪙 coins', 'neutral'),
      line('Accounts', '0', 'neutral'),
      line('Robbing', 'off', 'off'),
    ]),
    ['🪙 coins']
  );
});

test('reminders and level-ups read naturally', () => {
  assert.deepEqual(summaryParts('reminders', [line('Reminders', '3 active', 'on')]), ['3 active reminders']);
  assert.deepEqual(summaryParts('reminders', [line('Reminders', '1 active · 2 off', 'on')]), [
    '1 active reminder',
    '2 off',
  ]);
  assert.deepEqual(
    summaryParts('leveling', [line('Announce', 'channel', 'neutral'), line('Reward roles', '3', 'on')]),
    ['level-ups in a channel', '3 reward roles']
  );
  assert.deepEqual(
    summaryParts('leveling', [line('Announce', 'dm', 'neutral'), line('Reward roles', 'none', 'off')]),
    ['level-ups by DM']
  );
});

test('every card of the overview has summary parts, and none says "Status: enabled" or "Channel: set"', async () => {
  const guild = {
    id: G,
    members: { me: { permissions: new PermissionsBitField(PermissionsBitField.All) } },
    channels: { cache: { get: () => undefined } },
  };
  for (const m of MODULES) await setGuildModule(G, m.id, { enabled: true, config: {} });
  const cards = (await buildOverview(guild)).groups.flatMap((g) => g.cards);
  assert.ok(cards.length > 30);
  for (const card of cards) {
    assert.ok(Array.isArray(card.summaryParts), `${card.id} has summaryParts`);
    assert.equal(card.summary, card.summaryParts.join(' · '));
    const text = `${card.summary} ${card.lines.map((l) => `${l.label}: ${l.value}`).join(' ')}`;
    assert.ok(!/Status: enabled/.test(text), `${card.id}: ${text}`);
    assert.ok(!/Channel: set\b/.test(text), `${card.id}: ${text}`);
  }
  // an empty server: a module that needs a channel says it is not set up
  const logging = cards.find((c) => c.id === 'logging');
  assert.deepEqual(logging.summaryParts, ['Not set up yet']);
});

test('a module whose bot-owner keys are missing says it waits for the bot owner, and still names what is set up', () => {
  assert.deepEqual(
    summaryParts('twitch-alerts', [
      line('Streamers', '1', 'on'),
      line('API', 'not added by the bot owner', 'off'),
    ]),
    ['Waiting for the bot owner', '1 streamer']
  );
  assert.deepEqual(summaryParts('kick-alerts', [line('Streamers', '2', 'on'), line('API', 'x', 'off')]), [
    'Waiting for the bot owner',
    '2 streamers',
  ]);
  assert.deepEqual(
    summaryParts('apple-connect', [line('Channel', '#releases', 'on'), line('API', 'x', 'off')]),
    ['Waiting for the bot owner', '#releases']
  );
  // keys present: the ordinary summary, no waiting
  assert.deepEqual(
    summaryParts('twitch-alerts', [line('Streamers', '1', 'on'), line('API', 'connected', 'neutral')]),
    ['1 streamer']
  );
  const info = summaryInfo('twitch-alerts', [line('Streamers', '1', 'on'), line('API', 'x', 'off')]);
  assert.equal(info.waitingForOwner, true);
  assert.equal(
    summaryInfo('twitch-alerts', [line('Streamers', '1', 'on'), line('API', 'connected', 'neutral')])
      .waitingForOwner,
    false
  );
  assert.equal(
    waitsForOwnerKeys('polls', [line('API', 'x', 'off')]),
    false,
    'only the three key-bound modules'
  );
});

test('an empty module says what is missing, not just "On"', () => {
  assert.deepEqual(summaryParts('auto-react', [line('Rules', 'none', 'off')]), ['No rules yet']);
  assert.deepEqual(summaryParts('auto-react', [line('Rules', '2', 'on')]), ['2 rules']);
  assert.deepEqual(summaryParts('auto-react', [line('Rules', '1', 'on')]), ['1 rule']);
  assert.deepEqual(
    summaryParts('honeypot', [line('Traps set', 'none', 'off'), line('Exempt roles', '0', 'neutral')]),
    ['No traps yet']
  );
  assert.deepEqual(summaryParts('github', [line('Repositories', 'none', 'off')]), ['No repositories yet']);
  assert.equal(summaryInfo('github', [line('Repositories', 'none', 'off')]).empty, true);
  assert.equal(summaryInfo('github', [line('Repositories', '1', 'on')]).empty, false);
});

test('the overview card of Auto-react counts its rules, and flags a module that waits for keys', async () => {
  const id = '700000000000000556';
  const guild = {
    id,
    members: { me: { permissions: new PermissionsBitField(PermissionsBitField.All) } },
    channels: { cache: { get: () => undefined } },
  };
  await setGuildModule(id, 'auto-react', { enabled: true, config: { rules: [] } });
  await setGuildModule(id, 'twitch-alerts', { enabled: true, config: { alerts: [] } });
  // the test environment has no Twitch keys
  assert.equal(config.twitchEnabled, false);
  {
    const cards = (await buildOverview(guild)).groups.flatMap((g) => g.cards);
    const react = cards.find((c) => c.id === 'auto-react');
    assert.deepEqual(react.summaryParts, ['No rules yet']);
    assert.equal(react.empty, true);
    assert.deepEqual(react.lines[0], { label: 'Rules', value: 'none', state: 'off' });
    const twitch = cards.find((c) => c.id === 'twitch-alerts');
    assert.equal(twitch.waitingForOwner, true);
    assert.equal(twitch.summaryParts[0], 'Waiting for the bot owner');
    // the first two lines keep the "label: value" shape the iOS app reads
    for (const c of cards)
      for (const l of c.lines.slice(0, 2)) assert.ok(l.label && 'value' in l && l.state, c.id);
  }
});
