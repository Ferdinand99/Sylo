import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseYoutubeConfig, parseFeed, fillMessage } from '../src/modules/youtubeAlerts.js';

const UC = 'UC' + 'x'.repeat(22);
const CH = '123456789012345678';

test('normaliseYoutubeConfig: needs a UC id + discord channel, dedupes, caps', () => {
  const c = normaliseYoutubeConfig({
    alerts: [
      { ytChannelId: UC, discordChannelId: CH, name: 'MrBeast', roleId: '999999999999999999', onLive: true },
      { ytChannelId: UC, discordChannelId: CH }, // dupe
      { ytChannelId: 'not-a-uc', discordChannelId: CH }, // dropped
      { ytChannelId: UC, discordChannelId: '' }, // dropped
    ],
  });
  assert.equal(c.alerts.length, 1);
  assert.equal(c.alerts[0].name, 'MrBeast');
  assert.equal(c.alerts[0].onVideo, true); // default
  assert.equal(c.alerts[0].onLive, true);
  assert.equal(c.alerts[0].roleId, '999999999999999999');
});

test('normaliseYoutubeConfig: caps at 50', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ ytChannelId: 'UC' + String(i).padStart(22, '0'), discordChannelId: CH }));
  assert.equal(normaliseYoutubeConfig({ alerts: many }).alerts.length, 50);
});

test('parseFeed: pulls entries newest-first with ids, titles, urls', () => {
  const xml = `<?xml version="1.0"?><feed><author><name>Some Channel</name></author>
    <entry><yt:videoId>aaaaaaaaaaa</yt:videoId><title>Older &amp; wiser</title>
      <published>2024-01-01T00:00:00+00:00</published>
      <media:thumbnail url="https://img/a.jpg"/></entry>
    <entry><yt:videoId>bbbbbbbbbbb</yt:videoId><title>Newest</title>
      <published>2024-06-01T00:00:00+00:00</published></entry></feed>`;
  const out = parseFeed(xml);
  assert.deepEqual(out.map((e) => e.videoId), ['bbbbbbbbbbb', 'aaaaaaaaaaa']);
  assert.equal(out[1].title, 'Older & wiser');
  assert.equal(out[0].url, 'https://www.youtube.com/watch?v=bbbbbbbbbbb');
  assert.equal(out[1].thumb, 'https://img/a.jpg');
  assert.match(out[0].thumb, /i\.ytimg\.com/); // fallback thumb
});

test('fillMessage: substitutes and falls back to the default', () => {
  assert.equal(
    fillMessage('{name}: {title} → {url}', 'D', { name: 'Ch', title: 'Vid', url: 'u' }),
    'Ch: Vid → u'
  );
  assert.equal(fillMessage('', 'the default', {}), 'the default');
});
