import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseKickConfig, fillMessage, streamKey, buildPayload } from '../src/modules/kickAlerts.js';

test('normaliseKickConfig: cleans slugs, requires a channel, dedupes, caps', () => {
  const c = normaliseKickConfig({
    alerts: [
      { slug: '  xQc ', channelId: '123456789012345678', roleId: '999999999999999999', message: 'live!' },
      { slug: 'https://kick.com/trainwreckstv', channelId: '123456789012345678' },
      { slug: '@adin-ross', channelId: '123456789012345678' },
      { slug: 'nochannel', channelId: '' }, // dropped
      { slug: 'has spaces', channelId: '123456789012345678' }, // dropped: invalid slug
      { slug: 'xqc', channelId: '123456789012345678' }, // dropped: dupe slug+channel
    ],
  });
  assert.deepEqual(
    c.alerts.map((a) => a.slug),
    ['xqc', 'trainwreckstv', 'adin-ross']
  );
  assert.equal(c.alerts[0].roleId, '999999999999999999');
  assert.equal(c.alerts[1].roleId, ''); // invalid/absent role cleared
});

test('normaliseKickConfig: caps at 50 alerts', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    slug: `streamer${i}`,
    channelId: '123456789012345678',
  }));
  assert.equal(normaliseKickConfig({ alerts: many }).alerts.length, 50);
});

test('fillMessage: substitutes placeholders and falls back to the default', () => {
  assert.equal(
    fillMessage('{name} is live: {title} ({game}) {url} · {viewers}', {
      name: 'xQc',
      title: 'watching stuff',
      game: 'Just Chatting',
      url: 'https://kick.com/xqc',
      viewers: 55000,
    }),
    'xQc is live: watching stuff (Just Chatting) https://kick.com/xqc · 55000'
  );
  assert.match(fillMessage('', { name: 'x' }), /is live on Kick/);
});

test('streamKey uses the broadcast start time so a new stream re-announces', () => {
  assert.equal(streamKey({ stream: { start_time: '2026-09-02T20:00:00Z' } }), '2026-09-02T20:00:00Z');
  assert.notEqual(
    streamKey({ stream: { start_time: '2026-09-02T20:00:00Z' } }),
    streamKey({ stream: { start_time: '2026-09-03T09:00:00Z' } })
  );
  assert.equal(streamKey({}), 'live'); // tolerates a missing stream object
});

test('buildPayload: renders an embed + prepends the ping role', () => {
  const channel = {
    slug: 'xqc',
    stream_title: 'ranked',
    category: { name: 'Fortnite' },
    banner_picture: 'https://files.kick.com/banner.jpg',
    stream: {
      is_live: true,
      viewer_count: 4200,
      start_time: '2026-09-02T20:00:00Z',
      thumbnail: 'https://files.kick.com/thumb.jpg',
      url: 'https://kick.com/xqc',
    },
  };
  const payload = buildPayload(channel, { roleId: '123456789012345678', message: '{name} live!' });
  assert.match(payload.content, /^<@&123456789012345678> xqc live!$/);
  assert.equal(payload.embeds[0].data.url, 'https://kick.com/xqc');
  assert.match(payload.embeds[0].data.description, /Fortnite.*4200 viewers/);
  assert.deepEqual(payload.allowedMentions, { roles: ['123456789012345678'] });
});
