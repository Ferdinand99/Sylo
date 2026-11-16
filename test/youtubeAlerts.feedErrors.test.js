import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAlert } from '../src/modules/youtubeAlerts.js';
import {
  FEED_BACKOFF_CAP_MS,
  FEED_DEAD_AFTER_MS,
  FEED_WARN_AFTER,
  FeedUnavailableError,
  _resetFeedHealthForTests,
  deadFeedFor,
  feedBackoffMs,
  feedDue,
  feedHealthSize,
  liveDue,
  liveHealthSize,
  pruneFeedHealth,
  pruneLiveHealth,
  recordFeedFailure,
  recordLiveFailure,
} from '../src/modules/lib/youtubeFeedHealth.js';
import { markVideoSeen, isVideoSeen, markLive, liveVideoId } from '../src/db/youtubeAlerts.js';
import { runtime } from '../src/runtime.js';

const YT_CHANNEL = 'UC' + 'f'.repeat(22);
const DISCORD_CHANNEL = '123456789012345678';
// Every test gets its own two servers, so what one test seeds in the database never reaches another.
let nextGuild = 900000000000000100n;
let GUILD_ID = '';
let GUILD_B = '';
const POLL = 3 * 60_000;
const HOUR = 60 * 60_000;
const ALERT = { ytChannelId: YT_CHANNEL, discordChannelId: DISCORD_CHANNEL, onVideo: true };

let sends = [];
let deletes = [];
function setClient(guildIds) {
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (msg) => {
      sends.push(msg);
      return { id: `msg${sends.length}` };
    },
    messages: {
      delete: async (id) => {
        deletes.push(id);
      },
    },
  };
  runtime.client = {
    guilds: {
      cache: new Map(
        guildIds.map((id) => [
          id,
          {
            channels: { cache: new Map([[DISCORD_CHANNEL, channel]]), fetch: async () => channel },
            members: { me: {} },
          },
        ])
      ),
    },
  };
}

const FEED_XML = (videoId) =>
  `<?xml version="1.0"?><feed><author><name>Some Channel</name></author>
    <entry><yt:videoId>${videoId}</yt:videoId><title>New upload</title>
      <published>2024-06-01T00:00:00+00:00</published></entry></feed>`;

/** Run `fn` with fetch stubbed by `respond(url)`; returns the number of fetches and the log lines it caused. */
async function withFeed(respond, fn) {
  const real = { fetch: globalThis.fetch, log: console.log, err: console.error };
  const calls = { fetches: 0, out: [], err: [] };
  globalThis.fetch = async (url) => {
    calls.fetches += 1;
    return respond(String(url));
  };
  console.log = (...a) => calls.out.push(a.join(' '));
  console.error = (...a) => calls.err.push(a.join(' '));
  try {
    await fn();
  } finally {
    globalThis.fetch = real.fetch;
    console.log = real.log;
    console.error = real.err;
  }
  return calls;
}

const status = (code) => async () => new Response('gone', { status: code });

test.beforeEach(() => {
  _resetFeedHealthForTests();
  sends = [];
  deletes = [];
  GUILD_ID = String((nextGuild += 1n));
  GUILD_B = String((nextGuild += 1n));
  setClient([GUILD_ID, GUILD_B]);
});

const LIVE_HTML = (videoId) =>
  `<html>"isLive":true<link rel="canonical" href="https://www.youtube.com/watch?v=${videoId}"></html>`;
const isFeedUrl = (url) => url.includes('feeds/videos.xml');

test('a feed that answers 404 or 5xx does not throw and logs nothing for the first failures', async () => {
  const t0 = 1_000_000_000_000;
  const calls = await withFeed(status(404), async () => {
    for (let i = 0; i < FEED_WARN_AFTER - 1; i += 1) {
      await runAlert(GUILD_ID, ALERT, t0 + i * HOUR);
    }
  });
  assert.equal(calls.fetches, FEED_WARN_AFTER - 1);
  assert.deepEqual([...calls.out, ...calls.err], []);

  _resetFeedHealthForTests();
  const five = await withFeed(status(503), () => runAlert(GUILD_ID, ALERT, t0 + 100 * HOUR));
  assert.deepEqual([...five.out, ...five.err], []);
});

test('a timeout or a dropped connection is a quiet failure too', async () => {
  const calls = await withFeed(
    async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    },
    async () => {
      await runAlert(GUILD_ID, ALERT, 1_000_000_000_000);
    }
  );
  assert.deepEqual([...calls.out, ...calls.err], []);
  assert.equal(feedDue(YT_CHANNEL, 1_000_000_000_000), false, 'it now backs off');

  _resetFeedHealthForTests();
  const reset = await withFeed(
    async () => {
      throw new TypeError('fetch failed');
    },
    async () => {
      await runAlert(GUILD_ID, ALERT, 1_000_000_000_000);
    }
  );
  assert.deepEqual([...reset.out, ...reset.err], []);
});

test('one warning after 6 failures in a row, with the channel id and the status, and no second one', async () => {
  const t0 = 1_000_000_000_000;
  const calls = await withFeed(status(404), async () => {
    for (let i = 0; i < FEED_WARN_AFTER + 3; i += 1) await runAlert(GUILD_ID, ALERT, t0 + i * HOUR);
  });
  assert.equal(calls.out.length, 0);
  assert.equal(calls.err.length, 1);
  assert.match(calls.err[0], /WARN\s+youtube-alerts/);
  assert.ok(calls.err[0].includes(YT_CHANNEL));
  assert.match(calls.err[0], /HTTP 404/);
  assert.match(calls.err[0], /6 polls in a row/);
});

test('one line when the feed answers again after the warning (reaching the stored dev log), none after a short blip', async () => {
  const t0 = 1_000_000_000_000;
  await markVideoSeen(GUILD_ID, YT_CHANNEL, 'seed-feed-errors-1');
  let fail = true;
  const calls = await withFeed(
    async () => (fail ? new Response('x', { status: 404 }) : new Response(FEED_XML('seenvideo01'))),
    async () => {
      for (let i = 0; i < FEED_WARN_AFTER; i += 1) await runAlert(GUILD_ID, ALERT, t0 + i * HOUR);
      fail = false;
      await runAlert(GUILD_ID, ALERT, t0 + 10 * HOUR);
      await runAlert(GUILD_ID, ALERT, t0 + 11 * HOUR);
    }
  );
  assert.equal(calls.out.length, 0);
  assert.equal(calls.err.length, 2, 'the warning, then the recovery');
  assert.match(calls.err[0], /WARN\s+youtube-alerts.*failed 6 polls/);
  // Warn level too: log.js sends only warnings and errors on to the stored dev log.
  assert.match(calls.err[1], /WARN\s+youtube-alerts/);
  assert.ok(calls.err[1].includes(YT_CHANNEL));
  assert.match(calls.err[1], /answers again/);

  // A blip shorter than the warning threshold recovers without any line.
  _resetFeedHealthForTests();
  fail = true;
  const blip = await withFeed(
    async () => (fail ? new Response('x', { status: 404 }) : new Response(FEED_XML('seenvideo01'))),
    async () => {
      await runAlert(GUILD_ID, ALERT, t0);
      fail = false;
      await runAlert(GUILD_ID, ALERT, t0 + HOUR);
    }
  );
  assert.deepEqual([...blip.out, ...blip.err], []);
});

test('backoff: 3, 6, 12, 24 then 30 minutes, capped, and reset by an answer', async () => {
  const min = 60_000;
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 50].map((n) => feedBackoffMs(n, POLL) / min),
    [3, 6, 12, 24, 30, 30, 30, 30]
  );
  assert.equal(feedBackoffMs(1000, POLL), FEED_BACKOFF_CAP_MS);

  const t0 = 1_000_000_000_000;
  let respond = status(404);
  const at = [];
  const poll = async (n) => {
    const before = fetches;
    await runAlert(GUILD_ID, ALERT, t0 + n * POLL);
    at.push([n, fetches - before]);
  };
  let fetches = 0;
  await withFeed(
    (url) => {
      fetches += 1;
      return respond(url);
    },
    async () => {
      await poll(0); // fails (1st); the next poll is due one interval later
      await poll(1); // due: fails (2nd); back off two intervals
      await poll(2); // skipped
      await poll(3); // due: fails (3rd); back off four intervals
      for (const n of [4, 5, 6]) await poll(n); // skipped
      respond = async () => new Response(FEED_XML('backoffvid1'));
      await poll(7); // due: answers, the back-off is reset
      respond = status(404);
      await poll(8); // polled at the normal rate again: fails (1st)
      await poll(9); // due one interval later
    }
  );
  assert.deepEqual(at, [
    [0, 1],
    [1, 1],
    [2, 0],
    [3, 1],
    [4, 0],
    [5, 0],
    [6, 0],
    [7, 1],
    [8, 1],
    [9, 1],
  ]);
});

test('a second alert on a failing channel in the same pass is skipped, not counted twice', async () => {
  const t0 = 1_000_000_000_000;
  const calls = await withFeed(status(404), async () => {
    await runAlert(GUILD_ID, ALERT, t0);
    await runAlert(GUILD_ID, { ...ALERT, discordChannelId: '123456789012345679' }, t0 + 5_000);
  });
  assert.equal(calls.fetches, 1);
});

test('a parse or size failure on our side is not swallowed as a feed outage', async () => {
  const calls = await withFeed(
    async () => new Response('x', { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } }),
    async () => {
      await assert.rejects(runAlert(GUILD_ID, ALERT, 1_000_000_000_000), /too large/i);
    }
  );
  assert.equal(calls.fetches, 1);
  assert.equal(feedDue(YT_CHANNEL, 1_000_000_000_000), true, 'not counted as a feed failure');
});

test('a failing feed does not stop the live check of a seeded alert', async () => {
  await markVideoSeen(GUILD_ID, YT_CHANNEL, 'seed-feed-errors-live');
  const calls = await withFeed(
    async (url) =>
      isFeedUrl(url) ? new Response('x', { status: 404 }) : new Response(LIVE_HTML('livefeederr')),
    async () => {
      await runAlert(GUILD_ID, { ...ALERT, onLive: true }, 1_000_000_000_000);
    }
  );
  assert.equal(calls.fetches, 2);
  assert.equal(sends.length, 1);
});

test('a new alert whose feed is not read yet goes live only after the seed, so the first good poll does not flood old uploads', async () => {
  const t0 = 1_000_000_000_000;
  const alert = { ...ALERT, onLive: true };
  let feedUp = false;
  const oldUploads = ['olduploads1', 'olduploads2', 'olduploads3'];
  const entry = (v) =>
    `<entry><yt:videoId>${v}</yt:videoId><title>Old</title><published>2024-01-01T00:00:00+00:00</published></entry>`;
  const feed = () => `<feed>${oldUploads.map(entry).join('')}</feed>`;
  await withFeed(
    async (url) => {
      if (isFeedUrl(url)) return feedUp ? new Response(feed()) : new Response('x', { status: 404 });
      return new Response(LIVE_HTML('livestream1'));
    },
    async () => {
      await runAlert(GUILD_ID, alert, t0); // feed 404, unseeded: the live check waits
      await runAlert(GUILD_ID, alert, t0 + POLL); // feed due again and fails again, still unseeded: waits
      assert.equal(sends.length, 0, 'no live post before the seed');
      feedUp = true;
      await runAlert(GUILD_ID, alert, t0 + HOUR); // first good poll: seeds quietly, then the live post
    }
  );
  assert.equal(sends.length, 1, 'one live post, no old uploads');
  assert.equal(sends[0].embeds[0].data.title, 'Live now');
  for (const v of oldUploads) assert.equal(await isVideoSeen(GUILD_ID, YT_CHANNEL, v), true);
});

test('with a feed that is backing off, an unseeded server waits for its seed and a seeded one still goes live', async () => {
  const t0 = 1_000_000_000_000;
  recordFeedFailure(YT_CHANNEL, new FeedUnavailableError('YT feed 404', 404), POLL, t0);
  await markVideoSeen(GUILD_ID, YT_CHANNEL, 'seed-other-server');
  const calls = await withFeed(
    async () => new Response(LIVE_HTML('livestream2')),
    async () => {
      await runAlert(GUILD_B, { ...ALERT, onLive: true }, t0 + 1_000); // never seeded: no live post
      assert.equal(sends.length, 0);
      await runAlert(GUILD_ID, { ...ALERT, onLive: true }, t0 + 1_000); // seeded: the live check runs
    }
  );
  assert.equal(sends.length, 1);
  assert.equal(calls.fetches, 1);
});

test('a live-only alert does not wait for a feed it does not use', async () => {
  const calls = await withFeed(
    async () => new Response(LIVE_HTML('livestream3')),
    async () => {
      await runAlert(GUILD_ID, { ...ALERT, onVideo: false, onLive: true }, 1_000_000_000_000);
    }
  );
  assert.equal(calls.fetches, 1);
  assert.equal(sends.length, 1);
});

test('a live page that cannot be read is unknown: the running live post stays and nothing is announced again', async () => {
  const t0 = 1_000_000_000_000;
  const alert = { ...ALERT, onVideo: false, onLive: true };
  await markLive(GUILD_ID, YT_CHANNEL, 'livestream4', {
    channelId: DISCORD_CHANNEL,
    messageId: 'live-post-1',
  });
  let page = async () => new Response('x', { status: 503 });
  const calls = await withFeed(
    () => page(),
    async () => {
      await runAlert(GUILD_ID, alert, t0);
      await runAlert(GUILD_ID, alert, t0 + HOUR);
    }
  );
  assert.deepEqual([...calls.out, ...calls.err], [], 'no log per failed check');
  assert.deepEqual(deletes, [], 'the live post is not deleted');
  assert.equal(await liveVideoId(GUILD_ID, YT_CHANNEL), 'livestream4');
  assert.equal(sends.length, 0);

  // The page answers and the stream is still on: still no second announcement.
  page = async () => new Response(LIVE_HTML('livestream4'));
  await withFeed(
    () => page(),
    () => runAlert(GUILD_ID, alert, t0 + 2 * HOUR)
  );
  assert.equal(sends.length, 0);
  assert.deepEqual(deletes, []);

  // A definite "not live" still ends the post.
  page = async () => new Response('<html>offline</html>');
  await withFeed(
    () => page(),
    () => runAlert(GUILD_ID, alert, t0 + 3 * HOUR)
  );
  assert.deepEqual(deletes, ['live-post-1']);
  assert.equal(await liveVideoId(GUILD_ID, YT_CHANNEL), null);
});

test('a live page that has answered 404 for 6 hours ends the live post, for every server that watches the channel', async () => {
  const t0 = 1_000_000_000_000;
  const alert = { ...ALERT, onVideo: false, onLive: true };
  await markLive(GUILD_ID, YT_CHANNEL, 'livestream5', {
    channelId: DISCORD_CHANNEL,
    messageId: 'gone-post-a',
  });
  await markLive(GUILD_B, YT_CHANNEL, 'livestream5', {
    channelId: DISCORD_CHANNEL,
    messageId: 'gone-post-b',
  });
  await withFeed(status(404), async () => {
    // A poll every 30 minutes, the last two minutes short of 6 hours: the posts stay.
    for (let m = 0; m < 6 * 60 - 2; m += 30) {
      await runAlert(GUILD_ID, alert, t0 + m * 60_000);
      await runAlert(GUILD_B, alert, t0 + m * 60_000 + 5_000);
    }
    assert.deepEqual(deletes, []);
    await runAlert(GUILD_ID, alert, t0 + 6 * HOUR);
    await runAlert(GUILD_B, alert, t0 + 6 * HOUR + 5_000);
  });
  assert.deepEqual(deletes.sort(), ['gone-post-a', 'gone-post-b']);
  assert.equal(await liveVideoId(GUILD_ID, YT_CHANNEL), null);
  assert.equal(await liveVideoId(GUILD_B, YT_CHANNEL), null);
});

test('a 5xx on the live page in between starts the 6 hour count again', async () => {
  const t0 = 1_000_000_000_000;
  const alert = { ...ALERT, onVideo: false, onLive: true };
  await markLive(GUILD_ID, YT_CHANNEL, 'livestream6', { channelId: DISCORD_CHANNEL, messageId: 'keep-post' });
  let code = 404;
  await withFeed(
    async () => new Response('x', { status: code }),
    async () => {
      await runAlert(GUILD_ID, alert, t0);
      code = 503;
      await runAlert(GUILD_ID, alert, t0 + 5 * HOUR);
      code = 404;
      await runAlert(GUILD_ID, alert, t0 + 6 * HOUR);
      await runAlert(GUILD_ID, alert, t0 + 7 * HOUR);
    }
  );
  assert.deepEqual(deletes, [], 'not 6 hours of 404 without a break');
  assert.equal(await liveVideoId(GUILD_ID, YT_CHANNEL), 'livestream6');
});

test('a new stream that replaces a known one ends the earlier post', async () => {
  const t0 = 1_000_000_000_000;
  const alert = { ...ALERT, onVideo: false, onLive: true };
  await markLive(GUILD_ID, YT_CHANNEL, 'oldstream01', { channelId: DISCORD_CHANNEL, messageId: 'old-post' });
  await withFeed(
    async () => new Response(LIVE_HTML('newstream01')),
    () => runAlert(GUILD_ID, alert, t0)
  );
  assert.equal(sends.length, 1, 'the new stream is announced');
  assert.deepEqual(deletes, ['old-post'], 'the earlier post is settled');
  assert.equal(await liveVideoId(GUILD_ID, YT_CHANNEL), 'newstream01');

  // The same stream again changes nothing.
  await withFeed(
    async () => new Response(LIVE_HTML('newstream01')),
    () => runAlert(GUILD_ID, alert, t0 + HOUR)
  );
  assert.equal(sends.length, 1);
  assert.deepEqual(deletes, ['old-post']);
});

test('if the new stream cannot be posted, the earlier post is left for the next poll', async () => {
  const alert = { ...ALERT, onVideo: false, onLive: true };
  await markLive(GUILD_ID, YT_CHANNEL, 'oldstream02', {
    channelId: DISCORD_CHANNEL,
    messageId: 'old-post-2',
  });
  runtime.client = { guilds: { cache: new Map() } }; // no server to post in
  await withFeed(
    async () => new Response(LIVE_HTML('newstream02')),
    () => runAlert(GUILD_ID, alert, 1_000_000_000_000)
  );
  assert.deepEqual(deletes, []);
  assert.equal(await liveVideoId(GUILD_ID, YT_CHANNEL), 'oldstream02');
});

test('live page failures follow the same pattern: nothing per poll, one warning after 6, one line on recovery', async () => {
  const t0 = 1_000_000_000_000;
  const alert = { ...ALERT, onVideo: false, onLive: true };
  let up = false;
  const calls = await withFeed(
    async () => (up ? new Response('<html>offline</html>') : new Response('x', { status: 404 })),
    async () => {
      for (let i = 0; i < FEED_WARN_AFTER; i += 1) {
        await runAlert(GUILD_ID, alert, t0 + i * HOUR);
        // Both servers watch the channel: the second one in the same pass is skipped, not counted again.
        await runAlert(GUILD_B, alert, t0 + i * HOUR + 5_000);
      }
      up = true;
      await runAlert(GUILD_ID, alert, t0 + 10 * HOUR);
      await runAlert(GUILD_B, alert, t0 + 10 * HOUR + 5_000);
    }
  );
  const lines = [...calls.out, ...calls.err];
  assert.equal(lines.length, 2, 'one warning, one recovery');
  assert.match(lines[0], /live page failed 6 polls in a row \(last: HTTP 404\)/);
  assert.match(lines[1], /live page answers again/);
  assert.equal(liveHealthSize(), 0);
});

test('the live check backs off while the page fails', () => {
  const t0 = 1_000_000_000_000;
  recordLiveFailure(YT_CHANNEL, new FeedUnavailableError('HTTP 503', 503), POLL, t0);
  assert.equal(liveDue(YT_CHANNEL, t0 + 1_000), false);
  assert.equal(liveDue(YT_CHANNEL, t0 + POLL), true);
});

test('after a recovery a video missed during the outage is announced once, never twice', async () => {
  const t0 = 1_000_000_000_000;
  await markVideoSeen(GUILD_ID, YT_CHANNEL, 'seed-feed-errors-2');
  await withFeed(status(404), async () => {
    for (let i = 0; i < FEED_WARN_AFTER; i += 1) await runAlert(GUILD_ID, ALERT, t0 + i * HOUR);
  });
  assert.equal(sends.length, 0);
  assert.equal(await isVideoSeen(GUILD_ID, YT_CHANNEL, 'missedvideo1'), false);

  await withFeed(
    async () => new Response(FEED_XML('missedvideo1')),
    async () => {
      await runAlert(GUILD_ID, ALERT, t0 + 10 * HOUR);
      assert.equal(sends.length, 1, 'the missed video is announced when the feed is back');
      await runAlert(GUILD_ID, ALERT, t0 + 11 * HOUR);
      await runAlert(GUILD_ID, ALERT, t0 + 12 * HOUR);
    }
  );
  assert.equal(sends.length, 1, 'later polls do not announce it again');
  assert.equal(await isVideoSeen(GUILD_ID, YT_CHANNEL, 'missedvideo1'), true);
});

test('two servers on one failing channel: one count, and both announce the missed video on recovery', async () => {
  const t0 = 1_000_000_000_000;
  await markVideoSeen(GUILD_ID, YT_CHANNEL, 'seed-a');
  await markVideoSeen(GUILD_B, YT_CHANNEL, 'seed-b');
  let up = false;
  const calls = await withFeed(
    async () => (up ? new Response(FEED_XML('bothservers1')) : new Response('x', { status: 404 })),
    async () => {
      for (let i = 0; i < FEED_WARN_AFTER; i += 1) {
        await runAlert(GUILD_ID, ALERT, t0 + i * HOUR);
        await runAlert(GUILD_B, ALERT, t0 + i * HOUR + 5_000);
      }
      up = true;
      await runAlert(GUILD_ID, ALERT, t0 + 10 * HOUR);
      await runAlert(GUILD_B, ALERT, t0 + 10 * HOUR + 5_000);
      await runAlert(GUILD_ID, ALERT, t0 + 11 * HOUR);
      await runAlert(GUILD_B, ALERT, t0 + 11 * HOUR + 5_000);
    }
  );
  // Six passes where the second server was skipped, then two good polls per server.
  assert.equal(calls.fetches, FEED_WARN_AFTER + 4);
  assert.equal(calls.err.filter((l) => /failed 6 polls/.test(l)).length, 1, 'one warning for both servers');
  assert.equal(sends.length, 2, 'once per server');
  assert.equal(await isVideoSeen(GUILD_ID, YT_CHANNEL, 'bothservers1'), true);
  assert.equal(await isVideoSeen(GUILD_B, YT_CHANNEL, 'bothservers1'), true);
});

test('pruning drops the state of a channel nobody watches any more and keeps the others', () => {
  const other = 'UC' + 'g'.repeat(22);
  const err = new FeedUnavailableError('YT feed 404', 404);
  const t0 = 1_000_000_000_000;
  recordFeedFailure(YT_CHANNEL, err, POLL, t0);
  recordFeedFailure(other, err, POLL, t0 - FEED_DEAD_AFTER_MS);
  recordLiveFailure(YT_CHANNEL, err, POLL, t0);
  recordLiveFailure(other, err, POLL, t0);
  assert.equal(feedHealthSize(), 2);
  assert.ok(deadFeedFor(other, t0), 'dead for a day');

  pruneFeedHealth(new Set([YT_CHANNEL]));
  assert.equal(feedHealthSize(), 1);
  assert.equal(deadFeedFor(other, t0), null, 'forgotten');
  assert.equal(liveHealthSize(), 2, 'the live state is pruned apart from the feed state');
  pruneLiveHealth(new Set([YT_CHANNEL]));
  assert.equal(liveHealthSize(), 1);
  pruneFeedHealth(new Set());
  assert.equal(feedHealthSize(), 0);
});

test('"404 without a break": another kind of failure starts the 24 hour count again', () => {
  const t0 = 1_000_000_000_000;
  const notFound = new FeedUnavailableError('YT feed 404', 404);
  const down = new FeedUnavailableError('YT feed 503', 503);
  recordFeedFailure(YT_CHANNEL, notFound, POLL, t0);
  recordFeedFailure(YT_CHANNEL, notFound, POLL, t0 + HOUR);
  assert.equal(deadFeedFor(YT_CHANNEL, t0 + FEED_DEAD_AFTER_MS)?.since, t0);
  recordFeedFailure(YT_CHANNEL, down, POLL, t0 + 2 * HOUR);
  assert.equal(deadFeedFor(YT_CHANNEL, t0 + FEED_DEAD_AFTER_MS + HOUR), null, 'a 503 in between');
  recordFeedFailure(YT_CHANNEL, notFound, POLL, t0 + 3 * HOUR);
  assert.equal(deadFeedFor(YT_CHANNEL, t0 + 3 * HOUR + FEED_DEAD_AFTER_MS - 1), null);
  assert.equal(deadFeedFor(YT_CHANNEL, t0 + 3 * HOUR + FEED_DEAD_AFTER_MS)?.since, t0 + 3 * HOUR);
});

test('failures never mark a video seen or announce anything', async () => {
  await markVideoSeen(GUILD_ID, YT_CHANNEL, 'seed-feed-errors-3');
  await withFeed(status(404), async () => {
    await runAlert(GUILD_ID, ALERT, 1_000_000_000_000);
  });
  assert.equal(sends.length, 0);
});
