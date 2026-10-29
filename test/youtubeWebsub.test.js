import './helpers/tmpDb.js';
import './helpers/openMode.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startWebApp } from './helpers/webApp.js';
import { CH, GID } from './helpers/fakeGuild.js';
import { setGuildModule } from '../src/db/modules.js';
import { markVideoSeen, isVideoSeen } from '../src/db/youtubeAlerts.js';
import { getWebsub, wantWebsub, setWebsubLease, unwantWebsub } from '../src/db/youtubeWebsub.js';
import { runAlert } from '../src/modules/youtubeAlerts.js';
import {
  HUB,
  RENEW_BEFORE_MS,
  callbackUrl,
  handleNotification,
  renewDue,
  subscribe,
  syncSubscriptions,
  topicUrl,
  _setDashboardUrlForTests,
  unsubscribe,
  verifySignature,
  websubEnabled,
} from '../src/modules/youtubeWebsub.js';

const PUBLIC_URL = 'https://sylo.example.com';
const DAY = 24 * 60 * 60 * 1000;
const realFetch = globalThis.fetch;

let nextChannel = 0;
/** A valid, unique YouTube channel id. */
const newChannel = () => `UC${String(++nextChannel).padStart(22, 'x')}`;

const atom = (channelId, videoId, { published = new Date().toISOString(), title = 'New upload' } = {}) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <link rel="hub" href="https://pubsubhubbub.appspot.com"/>
  <title>YouTube video feed</title>
  <entry>
    <id>yt:video:${videoId}</id>
    <yt:videoId>${videoId}</yt:videoId>
    <yt:channelId>${channelId}</yt:channelId>
    <title>${title}</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${videoId}"/>
    <author><name>Some Channel</name><uri>https://www.youtube.com/channel/${channelId}</uri></author>
    <published>${published}</published>
    <updated>${published}</updated>
  </entry>
</feed>`;

const sign = (alg, secret, body) => `${alg}=${createHmac(alg, secret).update(body).digest('hex')}`;

/**
 * Stand-in for the hub and for youtube.com: records the hub's requests, answers a feed for the poll,
 * and lets everything else (the test's own requests to the local app) through.
 */
function fakeInternet({ hubStatus = 202, feed = () => '', delayMs = 0 } = {}) {
  const hub = [];
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u === HUB) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      hub.push(Object.fromEntries(new URLSearchParams(String(init.body))));
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      inFlight -= 1;
      return { ok: hubStatus < 400, status: hubStatus };
    }
    if (u.startsWith('https://www.youtube.com/feeds/videos.xml')) {
      return { ok: true, status: 200, text: async () => feed(u) };
    }
    return realFetch(url, init);
  };
  return {
    hub,
    get maxInFlight() {
      return maxInFlight;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

/** A running app with WebSub on: a public https DASHBOARD_URL, one guild watching `channelId`. */
async function withWebsub(fn, { channelId = newChannel(), internet = {}, watch = true } = {}) {
  _setDashboardUrlForTests(PUBLIC_URL);
  const net = fakeInternet(internet);
  const app = await startWebApp();
  try {
    if (watch) {
      await setGuildModule(GID, 'youtube-alerts', {
        enabled: true,
        config: { alerts: [{ ytChannelId: channelId, discordChannelId: CH.general, onVideo: true }] },
      });
    }
    await fn({ app, net, channelId });
  } finally {
    app.close();
    net.restore();
    _setDashboardUrlForTests(undefined);
  }
}

const verifyUrl = (base, channelId, params) =>
  `${base}/webhooks/youtube/${channelId}?${new URLSearchParams(params)}`;

const postPush = (base, channelId, body, signature) =>
  realFetch(`${base}/webhooks/youtube/${channelId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/atom+xml',
      ...(signature ? { 'X-Hub-Signature': signature } : {}),
    },
    body,
  });

test('the callback URL and topic follow the brief', () => {
  const channelId = 'UC' + 'a'.repeat(22);
  assert.equal(
    callbackUrl(channelId, 'https://sylo.example.com/'),
    `https://sylo.example.com/webhooks/youtube/${channelId}`
  );
  assert.equal(topicUrl(channelId), `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`);
});

test('subscribe sends the hub a callback, topic, mode and a 32-byte hex secret, and keeps the secret', async () => {
  await withWebsub(async ({ net, channelId }) => {
    assert.equal(await subscribe(channelId), true);
    const req = net.hub[0];
    assert.equal(req['hub.mode'], 'subscribe');
    assert.equal(req['hub.callback'], `${PUBLIC_URL}/webhooks/youtube/${channelId}`);
    assert.equal(req['hub.topic'], topicUrl(channelId));
    assert.match(req['hub.secret'], /^[0-9a-f]{64}$/);
    const row = await getWebsub(channelId);
    assert.equal(row.secret, req['hub.secret']);
    assert.equal(row.wanted, 1);
    assert.equal(row.lease_expires_at, null);

    await subscribe(channelId); // a renewal keeps the secret
    assert.equal(net.hub[1]['hub.secret'], req['hub.secret']);
  });
});

test('verification GET: the challenge is echoed only for a known topic and mode', async () => {
  await withWebsub(async ({ app, channelId }) => {
    await subscribe(channelId);
    const ok = { 'hub.mode': 'subscribe', 'hub.topic': topicUrl(channelId), 'hub.challenge': 'abc123' };

    // Wrong mode, wrong topic, a topic of another channel, no challenge: all 404.
    for (const bad of [
      { ...ok, 'hub.mode': 'denied' },
      { ...ok, 'hub.mode': 'publish' },
      { ...ok, 'hub.mode': undefined },
      { ...ok, 'hub.topic': topicUrl(channelId) + '&x=1' },
      { ...ok, 'hub.topic': topicUrl(newChannel()) },
      { ...ok, 'hub.challenge': undefined },
      { ...ok, 'hub.mode': 'unsubscribe' }, // we want this subscription: nobody may cancel it
    ]) {
      const clean = Object.fromEntries(Object.entries(bad).filter(([, v]) => v !== undefined));
      const res = await realFetch(verifyUrl(app.base, channelId, clean));
      assert.equal(res.status, 404, JSON.stringify(bad));
    }
    assert.equal((await getWebsub(channelId)).lease_expires_at, null, 'a refused request stores nothing');

    // A channel nobody subscribed to.
    const stranger = newChannel();
    const res = await realFetch(verifyUrl(app.base, stranger, { ...ok, 'hub.topic': topicUrl(stranger) }));
    assert.equal(res.status, 404);

    // The real thing: echoed as text/plain, and the lease is stored.
    const before = Date.now();
    const good = await realFetch(verifyUrl(app.base, channelId, { ...ok, 'hub.lease_seconds': '432000' }));
    assert.equal(good.status, 200);
    assert.match(good.headers.get('content-type'), /^text\/plain/);
    assert.equal(await good.text(), 'abc123');
    const lease = (await getWebsub(channelId)).lease_expires_at;
    assert.ok(lease >= before + 432000 * 1000 - 5 && lease <= Date.now() + 432000 * 1000);
  });
});

test('an unsubscribe is verified only after we asked for it, and then the row goes', async () => {
  await withWebsub(async ({ app, net, channelId }) => {
    await subscribe(channelId);
    assert.equal(await unsubscribe(channelId), true);
    assert.equal(net.hub.at(-1)['hub.mode'], 'unsubscribe');

    const params = { 'hub.topic': topicUrl(channelId), 'hub.challenge': 'bye' };
    // We no longer want it, so a subscribe verification is refused...
    assert.equal(
      (await realFetch(verifyUrl(app.base, channelId, { ...params, 'hub.mode': 'subscribe' }))).status,
      404
    );
    // ...and the unsubscribe one is answered and removes the row.
    const res = await realFetch(verifyUrl(app.base, channelId, { ...params, 'hub.mode': 'unsubscribe' }));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'bye');
    assert.equal(await getWebsub(channelId), null);
  });
});

test('an invalid channel id is a 404 before any database access', async () => {
  await withWebsub(async ({ app }) => {
    for (const id of ['UCshort', 'UC' + 'x'.repeat(23), 'ab' + 'x'.repeat(22), 'UC' + 'x'.repeat(21) + '!']) {
      const get = await realFetch(
        verifyUrl(app.base, encodeURIComponent(id), {
          'hub.mode': 'subscribe',
          'hub.topic': topicUrl(id),
          'hub.challenge': 'x',
        })
      );
      assert.equal(get.status, 404, id);
      const post = await postPush(app.base, encodeURIComponent(id), 'x', 'sha1=00');
      assert.equal(post.status, 404, id);
      assert.equal(await getWebsub(id), null);
    }
  });
});

test('signature check: sha1 and sha256 only, constant-time compare on equal lengths', () => {
  const body = Buffer.from('<feed/>');
  const secret = 'ab'.repeat(32);
  assert.equal(verifySignature(secret, body, sign('sha1', secret, body)), true);
  assert.equal(verifySignature(secret, body, sign('sha256', secret, body)), true);
  assert.equal(verifySignature(secret, body, sign('sha512', secret, body)), false);
  assert.equal(verifySignature(secret, body, sign('sha384', secret, body)), false);
  assert.equal(verifySignature(secret, body, sign('sha1', 'other', body)), false);
  assert.equal(verifySignature(secret, body, undefined), false);
  assert.equal(verifySignature(secret, body, ''), false);
  assert.equal(verifySignature(secret, body, sign('sha1', secret, body).slice(0, -2)), false); // shorter
  assert.equal(verifySignature(secret, body, sign('sha1', secret, body) + '00'), false); // longer
  assert.equal(verifySignature(secret, body, sign('sha1', secret, body).replace('sha1=', 'sha256=')), false);
  assert.equal(verifySignature(secret, body, 'sha1=zz'), false);
  assert.equal(verifySignature(secret, Buffer.from('<feed>x</feed>'), sign('sha1', secret, body)), false);
});

test('a push with a missing, wrong or wrong-algorithm signature is acknowledged but announces nothing', async () => {
  await withWebsub(async ({ app, channelId }) => {
    await markVideoSeen(GID, channelId, 'seeded-video'); // the channel has been polled once
    await subscribe(channelId);
    const { secret } = await getWebsub(channelId);
    const body = atom(channelId, 'badsig00001');

    for (const signature of [
      undefined,
      '',
      'sha1=' + '0'.repeat(40),
      sign('sha1', 'not-the-secret', body),
      sign('sha512', secret, body),
      sign('md5', secret, body),
      'garbage',
    ]) {
      const res = await postPush(app.base, channelId, body, signature);
      assert.equal(res.status, 204, `a 2xx so the hub stops retrying (${signature})`);
    }
    assert.equal(app.sink.messages.length, 0);
    assert.equal(await isVideoSeen(GID, channelId, 'badsig00001'), false);

    // A push for a channel we never subscribed to is not ours.
    const res = await postPush(app.base, newChannel(), body, sign('sha1', secret, body));
    assert.equal(res.status, 404);
  });
});

test('a good push announces once; a repeated push does not announce again', async () => {
  await withWebsub(async ({ app, channelId }) => {
    await markVideoSeen(GID, channelId, 'seeded-video');
    await subscribe(channelId);
    const { secret } = await getWebsub(channelId);
    const body = atom(channelId, 'pushvideo01');

    const first = await postPush(app.base, channelId, body, sign('sha1', secret, body));
    assert.equal(first.status, 204);
    assert.equal(app.sink.messages.length, 1);
    assert.equal(app.sink.messages[0].channel, CH.general);
    assert.match(JSON.stringify(app.sink.messages[0].payload), /pushvideo01/);
    assert.equal(await isVideoSeen(GID, channelId, 'pushvideo01'), true);
    assert.ok((await getWebsub(channelId)).last_notified_at > 0);

    // The same entry again (the hub retries, or YouTube pushes an edit), signed with sha256 this time.
    await postPush(app.base, channelId, body, sign('sha256', secret, body));
    await postPush(app.base, channelId, body, sign('sha1', secret, body));
    assert.equal(app.sink.messages.length, 1);
  });
});

test('a poll and a push for the same video announce once, in either order', async () => {
  const xmlFor = {};
  await withWebsub(
    async ({ app, channelId }) => {
      await markVideoSeen(GID, channelId, 'seeded-video');
      await subscribe(channelId);
      const { secret } = await getWebsub(channelId);
      const alert = { ytChannelId: channelId, discordChannelId: CH.general, onVideo: true };

      // Push first, then the poll sees the same video in the feed.
      xmlFor.feed = atom(channelId, 'pushfirst01');
      const a = atom(channelId, 'pushfirst01');
      await postPush(app.base, channelId, a, sign('sha1', secret, a));
      await runAlert(GID, alert);
      assert.equal(app.sink.messages.length, 1);

      // Poll first, then the push for the same video.
      xmlFor.feed = atom(channelId, 'pollfirst01');
      await runAlert(GID, alert);
      const b = atom(channelId, 'pollfirst01');
      await postPush(app.base, channelId, b, sign('sha1', secret, b));
      assert.equal(app.sink.messages.length, 2);
    },
    { internet: { feed: () => xmlFor.feed } }
  );
});

test('a push and a poll at the same moment announce once', async () => {
  const xmlFor = {};
  await withWebsub(
    async ({ app, channelId }) => {
      await markVideoSeen(GID, channelId, 'seeded-video');
      xmlFor.feed = atom(channelId, 'racevideo01');
      const alert = { ytChannelId: channelId, discordChannelId: CH.general, onVideo: true };
      await Promise.all([
        runAlert(GID, alert),
        handleNotification(channelId, atom(channelId, 'racevideo01')),
        handleNotification(channelId, atom(channelId, 'racevideo01')),
      ]);
      assert.equal(app.sink.messages.length, 1);
    },
    { internet: { feed: () => xmlFor.feed } }
  );
});

test('push ignores deleted entries, other channels, old videos, and a channel not polled yet', async () => {
  await withWebsub(async ({ app, channelId }) => {
    const deleted = `<feed xmlns:at="http://purl.org/atompub/tombstones/1.0"><at:deleted-entry ref="yt:video:gone0000001" when="${new Date().toISOString()}"><link href="https://www.youtube.com/watch?v=gone0000001"/><at:by><name>X</name></at:by></at:deleted-entry></feed>`;

    // Not seeded yet: the first poll seeds silently, so a push does not announce either.
    assert.equal(await handleNotification(channelId, atom(channelId, 'unseeded0001')), 0);

    await markVideoSeen(GID, channelId, 'seeded-video');
    assert.equal(await handleNotification(channelId, deleted), 0);
    assert.equal(await handleNotification(channelId, atom(newChannel(), 'otherchan001')), 0);
    const old = atom(channelId, 'oldvideo0001', { published: new Date(Date.now() - 30 * DAY).toISOString() });
    assert.equal(await handleNotification(channelId, old), 0);
    assert.equal(app.sink.messages.length, 0);

    assert.equal(await handleNotification(channelId, atom(channelId, 'freshvideo01')), 1);
  });
});

test('a push does not announce for a guild with the alert switched off or onVideo off', async () => {
  await withWebsub(async ({ app, channelId }) => {
    await markVideoSeen(GID, channelId, 'seeded-video');
    await setGuildModule(GID, 'youtube-alerts', { enabled: false });
    assert.equal(await handleNotification(channelId, atom(channelId, 'disabled0001')), 0);
    await setGuildModule(GID, 'youtube-alerts', {
      enabled: true,
      config: {
        alerts: [{ ytChannelId: channelId, discordChannelId: CH.general, onVideo: false, onLive: true }],
      },
    });
    assert.equal(await handleNotification(channelId, atom(channelId, 'liveonly0001')), 0);
    assert.equal(app.sink.messages.length, 0);
  });
});

test('renewDue picks only rows with under a day of lease left (or never verified)', async () => {
  await withWebsub(
    async ({ net }) => {
      const now = Date.now();
      const rows = {
        soon: [newChannel(), now + RENEW_BEFORE_MS - 60_000],
        expired: [newChannel(), now - 1000],
        plenty: [newChannel(), now + 3 * DAY],
        unverified: [newChannel(), null],
        unwanted: [newChannel(), now + 1000],
      };
      for (const [id, lease] of Object.values(rows)) {
        await wantWebsub(id, 'secret-' + id);
        if (lease !== null) await setWebsubLease(id, lease);
      }
      await unwantWebsub(rows.unwanted[0]);

      // Rows left by earlier tests in this file are due too; look at this test's own.
      const ids = Object.values(rows).map(([id]) => id);
      const asked = (await renewDue(now)).filter((id) => ids.includes(id));
      assert.deepEqual(
        asked.sort(),
        [rows.soon[0], rows.expired[0], rows.unverified[0]].sort(),
        'only the close-to-expiry and unverified wanted rows'
      );
      const mine = net.hub.filter((r) => ids.some((id) => r['hub.topic'].endsWith(id)));
      assert.deepEqual(mine.map((r) => r['hub.topic']).sort(), asked.map(topicUrl).sort());
      // The secret is kept across the renewal.
      for (const req of mine) {
        assert.equal(req['hub.secret'], 'secret-' + req['hub.topic'].split('=')[1]);
      }
    },
    { watch: false }
  );
});

test('syncSubscriptions subscribes watched channels and unsubscribes ones nobody watches', async () => {
  const kept = newChannel();
  await withWebsub(
    async ({ net }) => {
      const added = newChannel();
      // Rows left by earlier tests in this file are reconciled too; look at this test's own.
      const mine = () =>
        net.hub
          .filter((r) => r['hub.topic'].endsWith(kept) || r['hub.topic'].endsWith(added))
          .map((r) => `${r['hub.mode']} ${r['hub.topic'].split('=')[1]}`)
          .sort();
      await syncSubscriptions();
      assert.deepEqual(mine(), [`subscribe ${kept}`]);

      // A save removes the channel and adds another.
      net.hub.length = 0;
      await setGuildModule(GID, 'youtube-alerts', {
        enabled: true,
        config: { alerts: [{ ytChannelId: added, discordChannelId: CH.general, onVideo: true }] },
      });
      await syncSubscriptions();
      assert.deepEqual(mine(), [`subscribe ${added}`, `unsubscribe ${kept}`].sort());
      assert.equal((await getWebsub(kept)).wanted, 0, 'kept until the hub verifies the unsubscribe');
    },
    { channelId: kept }
  );
});

test('hub requests are queued: at most 5 in flight at once', async () => {
  await withWebsub(
    async ({ net }) => {
      const ids = Array.from({ length: 14 }, newChannel);
      await Promise.all(ids.map((id) => subscribe(id)));
      assert.equal(net.hub.length, 14);
      assert.ok(net.maxInFlight <= 5, `saw ${net.maxInFlight} in flight`);
      assert.ok(net.maxInFlight > 1, 'but they do run in parallel');
    },
    { internet: { delayMs: 15 }, watch: false }
  );
});

test('a hub that refuses leaves the row for the next renewal and does not throw', async () => {
  await withWebsub(
    async ({ channelId }) => {
      assert.equal(await subscribe(channelId), false);
      assert.equal((await getWebsub(channelId)).lease_expires_at, null);
      assert.ok((await renewDue()).includes(channelId));
    },
    { internet: { hubStatus: 500 } }
  );
});

for (const [label, url] of [
  ['unset', ''],
  ['http', 'http://sylo.example.com'],
  ['localhost', 'https://localhost:3001'],
  ['a .local name', 'https://sylo.local'],
  ['a single-label host', 'https://sylo'],
  ['a LAN address', 'https://192.168.1.20'],
]) {
  test(`nothing is subscribed or mounted when DASHBOARD_URL is ${label}`, async () => {
    _setDashboardUrlForTests(url || null);
    const net = fakeInternet();
    const channelId = newChannel();
    const app = await startWebApp();
    try {
      assert.equal(websubEnabled(), false);
      await setGuildModule(GID, 'youtube-alerts', {
        enabled: true,
        config: { alerts: [{ ytChannelId: channelId, discordChannelId: CH.general, onVideo: true }] },
      });
      assert.equal(await subscribe(channelId), false);
      await syncSubscriptions();
      assert.deepEqual(await renewDue(), []);
      assert.equal(net.hub.length, 0, 'the hub was never asked');
      assert.equal(await getWebsub(channelId), null);

      // Even with a row, the routes are not there.
      await wantWebsub(channelId, 'secret');
      const res = await realFetch(
        verifyUrl(app.base, channelId, {
          'hub.mode': 'subscribe',
          'hub.topic': topicUrl(channelId),
          'hub.challenge': 'x',
        })
      );
      assert.equal(res.status, 404);
      assert.notEqual(await res.text(), 'x');
      const post = await postPush(app.base, channelId, 'x', sign('sha1', 'secret', 'x'));
      assert.equal(post.status, 404);
    } finally {
      app.close();
      net.restore();
      _setDashboardUrlForTests(undefined);
    }
  });
}

test('an oversized push is refused with 413 and announces nothing', async () => {
  await withWebsub(async ({ app, channelId }) => {
    await markVideoSeen(GID, channelId, 'seeded-video');
    await subscribe(channelId);
    const { secret } = await getWebsub(channelId);
    const pad = ' '.repeat(64 * 1024);
    const body = atom(channelId, 'bigvideo0001') + pad;
    assert.ok(Buffer.byteLength(body) > 64 * 1024);

    const res = await postPush(app.base, channelId, body, sign('sha1', secret, body));
    assert.equal(res.status, 413);
    assert.equal(app.sink.messages.length, 0);

    // A normal one still works afterwards.
    const small = atom(channelId, 'smallvideo01');
    assert.equal((await postPush(app.base, channelId, small, sign('sha1', secret, small))).status, 204);
    assert.equal(app.sink.messages.length, 1);
  });
});

test('importing the module registers its schedules without starting a timer', async () => {
  const { scheduledCount, activeTimerCount } = await import('../src/modules/schedule.js');
  assert.ok(scheduledCount() >= 1);
  assert.equal(activeTimerCount(), 0);
});
