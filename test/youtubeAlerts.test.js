import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseYoutubeConfig,
  parseFeed,
  fillMessage,
  resolveYtChannel,
  checkLive,
} from '../src/modules/youtubeAlerts.js';
import { log } from '../src/lib/log.js';

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

test('resolveYtChannel: a UC id or youtube.com URL resolves without a fetch', async () => {
  assert.deepEqual(await resolveYtChannel(UC), { channelId: UC, name: '' });
  assert.deepEqual(await resolveYtChannel(`https://www.youtube.com/channel/${UC}`), {
    channelId: UC,
    name: '',
  });
});

test('resolveYtChannel: a non-youtube URL is rejected (SSRF guard), never fetched', async () => {
  const realFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return { ok: false };
  };
  try {
    assert.equal(await resolveYtChannel('https://169.254.169.254/latest/meta-data/'), null);
    assert.equal(await resolveYtChannel('http://evil.example/@x'), null);
    assert.equal(await resolveYtChannel('https://youtube.evil.example/@x'), null);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// issue #178: "stopped working, nothing in the logs" — resolveYtChannel and
// checkLive used to swallow every fetch failure completely silently. These
// prove each failure mode now logs something useful, without changing the
// return value callers already depend on.
function withMockedFetch(response, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => response;
  const realWarn = log.warn;
  const warnings = [];
  log.warn = (...args) => warnings.push(args);
  return fn(warnings).finally(() => {
    globalThis.fetch = realFetch;
    log.warn = realWarn;
  });
}

test('resolveYtChannel: an HTTP error logs a warning with the status', async () => {
  await withMockedFetch({ ok: false, status: 429 }, async (warnings) => {
    assert.equal(await resolveYtChannel('@somechannel'), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].join(' '), /HTTP 429/);
  });
});

test('resolveYtChannel: a 200 with no recognisable channel id logs a warning', async () => {
  await withMockedFetch(
    { ok: true, text: async () => '<html>no channel id here</html>' },
    async (warnings) => {
      assert.equal(await resolveYtChannel('@somechannel'), null);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0].join(' '), /no channel id found/);
    }
  );
});

test('checkLive: an HTTP error logs a warning and reports not live', async () => {
  await withMockedFetch({ ok: false, status: 503 }, async (warnings) => {
    assert.deepEqual(await checkLive(UC), { live: false });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].join(' '), /HTTP 503/);
  });
});

test('checkLive: legitimately not live is silent (no warning) — the common case', async () => {
  await withMockedFetch({ ok: true, text: async () => '<html>not live</html>' }, async (warnings) => {
    assert.deepEqual(await checkLive(UC), { live: false });
    assert.equal(warnings.length, 0);
  });
});

// issue #178's actual root cause: YouTube's channel/live pages now run ~2 MB,
// but grab() (shared with the RSS/Atom feed parser) defaulted to a 300 KB scan
// cap sized for feed bodies — so a channelId/videoId sitting past 300 KB was
// silently never found, on an otherwise perfectly healthy 200 response. These
// pad the needle past the old cap and confirm the new one still reaches it.
const PAST_OLD_CAP = 'x'.repeat(350_000); // > the old 300 KB grab() default

test('resolveYtChannel: a channel id past the old 300 KB scan cap is still found', async () => {
  const html = `<html>${PAST_OLD_CAP}<script>"channelId":"${UC}"</script></html>`;
  await withMockedFetch({ ok: true, text: async () => html }, async (warnings) => {
    assert.deepEqual(await resolveYtChannel('@somechannel'), { channelId: UC, name: '' });
    assert.equal(warnings.length, 0);
  });
});

test('checkLive: a videoId past the old 300 KB scan cap is still found', async () => {
  const html = `<html>"isLive":true${PAST_OLD_CAP}<script>"videoId":"abcdefghijk"</script></html>`;
  await withMockedFetch({ ok: true, text: async () => html }, async (warnings) => {
    assert.deepEqual(await checkLive(UC), { live: true, videoId: 'abcdefghijk', title: 'Live now' });
    assert.equal(warnings.length, 0);
  });
});

test('normaliseYoutubeConfig: caps at 50', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    ytChannelId: 'UC' + String(i).padStart(22, '0'),
    discordChannelId: CH,
  }));
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
  assert.deepEqual(
    out.map((e) => e.videoId),
    ['bbbbbbbbbbb', 'aaaaaaaaaaa']
  );
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
