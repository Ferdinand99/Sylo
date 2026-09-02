import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseTwitchConfig, fillMessage } from '../src/modules/twitchAlerts.js';

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
