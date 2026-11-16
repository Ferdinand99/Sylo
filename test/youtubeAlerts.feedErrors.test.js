import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAlert } from '../src/modules/youtubeAlerts.js';
import {
  FEED_BACKOFF_CAP_MS,
  FEED_WARN_AFTER,
  _resetFeedHealthForTests,
  feedBackoffMs,
  feedDue,
} from '../src/modules/lib/youtubeFeedHealth.js';
import { markVideoSeen, isVideoSeen } from '../src/db/youtubeAlerts.js';
import { runtime } from '../src/runtime.js';

const YT_CHANNEL = 'UC' + 'f'.repeat(22);
const DISCORD_CHANNEL = '123456789012345678';
const GUILD_ID = '900000000000000031';
const POLL = 3 * 60_000;
const HOUR = 60 * 60_000;
const ALERT = { ytChannelId: YT_CHANNEL, discordChannelId: DISCORD_CHANNEL, onVideo: true };

let sends = [];
function setClient() {
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (msg) => {
      sends.push(msg);
      return { id: `msg${sends.length}` };
    },
  };
  runtime.client = {
    guilds: {
      cache: new Map([
        [
          GUILD_ID,
          {
            channels: { cache: new Map([[DISCORD_CHANNEL, channel]]), fetch: async () => channel },
            members: { me: {} },
          },
        ],
      ]),
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
  setClient();
});

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

test('one info line when the feed answers again after the warning, none after a short blip', async () => {
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
  assert.equal(calls.err.length, 1, 'only the warning');
  assert.equal(calls.out.length, 1);
  assert.match(calls.out[0], /INFO\s+youtube-alerts/);
  assert.ok(calls.out[0].includes(YT_CHANNEL));
  assert.match(calls.out[0], /answers again/);

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

test('a failing feed does not stop the live check', async () => {
  const live = `<html>"isLive":true<link rel="canonical" href="https://www.youtube.com/watch?v=livefeederr"></html>`;
  const calls = await withFeed(
    async (url) =>
      url.includes('feeds/videos.xml') ? new Response('x', { status: 404 }) : new Response(live),
    async () => {
      await runAlert(GUILD_ID, { ...ALERT, onLive: true }, 1_000_000_000_000);
    }
  );
  assert.equal(calls.fetches, 2);
  assert.equal(sends.length, 1);
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

test('failures never mark a video seen or announce anything', async () => {
  await markVideoSeen(GUILD_ID, YT_CHANNEL, 'seed-feed-errors-3');
  await withFeed(status(404), async () => {
    await runAlert(GUILD_ID, ALERT, 1_000_000_000_000);
  });
  assert.equal(sends.length, 0);
});
