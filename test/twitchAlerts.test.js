import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseTwitchConfig, fillMessage, buildPayload } from '../src/modules/twitchAlerts.js';

test('normaliseTwitchConfig: cleans logins, requires a channel, dedupes, caps', () => {
  const c = normaliseTwitchConfig({
    alerts: [
      { login: '  Ninja ', channelId: '123456789012345678', roleId: '999999999999999999', message: 'live!' },
      { login: 'https://twitch.tv/shroud', channelId: '123456789012345678' },
      { login: 'nochannel', channelId: '' }, // dropped
      { login: '!!bad!!', channelId: '123456789012345678' }, // dropped: invalid login
      { login: 'ninja', channelId: '123456789012345678' }, // dropped: dupe login+channel
    ],
  });
  assert.deepEqual(
    c.alerts.map((a) => a.login),
    ['ninja', 'shroud']
  );
  assert.equal(c.alerts[0].roleId, '999999999999999999');
  assert.equal(c.alerts[1].roleId, ''); // invalid/absent role cleared
});

test('normaliseTwitchConfig: caps at 50 alerts', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    login: `streamer${i}`,
    channelId: '123456789012345678',
  }));
  assert.equal(normaliseTwitchConfig({ alerts: many }).alerts.length, 50);
});

test('fillMessage: substitutes placeholders and falls back to the default', () => {
  assert.equal(
    fillMessage('{name} is live: {title} ({game}) {url} · {viewers}', {
      name: 'Ninja',
      title: 'ranked grind',
      game: 'Fortnite',
      url: 'https://twitch.tv/ninja',
      viewers: 4200,
    }),
    'Ninja is live: ranked grind (Fortnite) https://twitch.tv/ninja · 4200'
  );
  assert.match(fillMessage('', { name: 'x' }), /is live on Twitch/);
});

const STREAM = {
  user_login: 'Ninja',
  user_name: 'Ninja',
  title: 'ranked grind',
  game_name: 'Fortnite',
  viewer_count: 4200,
  started_at: '2026-09-02T20:00:00Z',
};

test('normaliseTwitchConfig: keeps the plainText flag', () => {
  const c = normaliseTwitchConfig({
    alerts: [{ login: 'ninja', channelId: '123456789012345678', plainText: true }],
  });
  assert.equal(c.alerts[0].plainText, true);
});

test('normaliseTwitchConfig: onEnd defaults to delete, clamps unknown values', () => {
  const ch = '123456789012345678';
  const c = normaliseTwitchConfig({
    alerts: [
      { login: 'aaa', channelId: ch },
      { login: 'bbb', channelId: ch, onEnd: 'edit' },
      { login: 'ccc', channelId: ch, onEnd: 'bogus' },
    ],
  });
  assert.deepEqual(
    c.alerts.map((a) => a.onEnd),
    ['delete', 'edit', 'delete']
  );
});

test('buildPayload: embed mode by default', () => {
  const p = buildPayload(STREAM, {}, { message: '', roleId: '' });
  assert.equal(p.embeds.length, 1);
  assert.match(p.content, /Ninja/);
});

test('buildPayload: plainText mode sends no embed and always includes the url', () => {
  const p = buildPayload(STREAM, {}, { message: '', roleId: '999999999999999999', plainText: true });
  assert.deepEqual(p.embeds, []);
  assert.match(p.content, /^<@&999999999999999999> /);
  assert.match(p.content, /twitch\.tv\/ninja/);
  // a custom template that omits {url} still gets the link appended
  const p2 = buildPayload(STREAM, {}, { message: '{name} live now', plainText: true });
  assert.match(p2.content, /^Ninja live now\nhttps:\/\/twitch\.tv\/ninja$/);
});
