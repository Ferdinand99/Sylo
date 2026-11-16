// Issue #377: the live check used to take the first video id on the /live page, which on a page
// without the channel's own player response is a recommended stream from another channel. These use
// small synthetic pages shaped like the real ones (the same markers, not the same size).
import './helpers/tmpDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkLive, runAlert } from '../src/modules/youtubeAlerts.js';
import { _resetFeedHealthForTests } from '../src/modules/lib/youtubeFeedHealth.js';
import { markLive, liveVideoId } from '../src/db/youtubeAlerts.js';
import { runtime } from '../src/runtime.js';

const OWN = 'UC' + 'o'.repeat(22);
const OTHER = 'UC' + 'z'.repeat(22);
const OWN_VIDEO = 'ownstream01';
const DISCORD_CHANNEL = '123456789012345678';

/** Recommended videos of other channels. Each can look live, as a real sidebar does. */
const recommendations = (seed) =>
  Array.from(
    { length: 4 },
    (_, i) =>
      `{"videoRenderer":{"videoId":"r${String(seed).padStart(2, '0')}x${String(i).padStart(7, '0')}",` +
      `"title":{"runs":[{"text":"Someone else ${seed}"}]},` +
      `"longBylineText":{"runs":[{"navigationEndpoint":{"browseEndpoint":{"browseId":"${OTHER}"}}}]},` +
      '"badges":[{"metadataBadgeRenderer":{"style":"BADGE_STYLE_TYPE_LIVE_NOW","isLive":true}}]}}'
  ).join(',');

/** The player response's videoDetails; `titleJson` is the raw JSON of the title. */
const details = ({
  videoId = OWN_VIDEO,
  channelId = OWN,
  titleJson = '"My stream"',
  isLive = true,
  channelFirst = false,
} = {}) => {
  const description = JSON.stringify('A } brace, a "quote" and \\ more');
  const own = `"channelId":"${channelId}"`;
  return (
    `"videoDetails":{"videoId":"${videoId}","title":${titleJson},"lengthSeconds":"0",` +
    (channelFirst ? `${own},` : '') +
    `"shortDescription":${description},` +
    (channelFirst ? '' : `${own},`) +
    `"isLiveContent":true${isLive ? ',"isLive":true' : ''}}`
  );
};

const canonical = (id) => `<link rel="canonical" href="https://www.youtube.com/watch?v=${id}">`;

/**
 * A watch page with no player videoDetails (LOGIN_REQUIRED). The real page still carries two other
 * "videoDetails" objects: the microformat's { externalVideoId } and the player overlay's, and only
 * ytInitialData says which video it is.
 */
const loginRequiredPage = ({ seed = 1, owner = OWN, videoId = OWN_VIDEO } = {}) =>
  `<html><script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED"},` +
  `"microformat":{"playerMicroformatRenderer":{"title":{"simpleText":"x"},"videoDetails":{"externalVideoId":"${videoId}"}}}};</script>` +
  `<script>var ytInitialData = {"contents":{"secondaryResults":[${recommendations(seed)}]},` +
  `"currentVideoEndpoint":{"clickTrackingParams":"x","commandMetadata":{"webCommandMetadata":{"url":"/watch?v=${videoId}"}},` +
  `"watchEndpoint":{"videoId":"${videoId}","nofollow":true}},` +
  `"playerOverlays":{"playerOverlayRenderer":{"videoDetails":{"playerOverlayVideoDetailsRenderer":{"title":{"simpleText":"x"},"subtitle":{"runs":[{"text":"y"}]}}}}},` +
  `"videoOwnerRenderer":{"title":{"runs":[{"text":"Me"}]},"navigationEndpoint":{"browseEndpoint":{"browseId":"${owner}"}}}};</script></html>`;

/** The same stream, answered with its player response. */
const okPage = ({ seed = 1 } = {}) =>
  `<html>${canonical(OWN_VIDEO)}<script>${recommendations(seed)}</script>` +
  `<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},${details()}};</script></html>`;

function withPage(page, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(typeof page === 'function' ? page() : page);
  return fn().finally(() => {
    globalThis.fetch = realFetch;
  });
}
const check = (page, channel = OWN) => withPage(page, () => checkLive(channel));

test('canonical link and videoDetails of the watched channel: live, with that id and title', async () => {
  const page =
    `<html>${canonical(OWN_VIDEO)}<script>${recommendations(1)}</script>` +
    `<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},${details({
      titleJson: '"Ben \\u0026 Jerry\\u0027s live"',
    })}};</script></html>`;
  assert.deepEqual(await check(page), { live: true, videoId: OWN_VIDEO, title: "Ben & Jerry's live" });
});

test('videoDetails alone (no canonical link) names the video, whatever the field order', async () => {
  for (const channelFirst of [false, true]) {
    const page = `<html>${recommendations(2)}<script>{"playabilityStatus":{"status":"OK"},${details({ channelFirst })}}</script></html>`;
    assert.deepEqual(await check(page), { live: true, videoId: OWN_VIDEO, title: 'My stream' });
  }
});

test('no canonical link, no videoDetails (LOGIN_REQUIRED): the current video of ytInitialData, never an earlier recommendation', async () => {
  const state = await check(loginRequiredPage({ seed: 3 }));
  assert.deepEqual(state, { live: true, videoId: OWN_VIDEO, title: 'Live now' });
});

test('the title comes from videoDetails, then the title meta tag, then the runs text, then "Live now"', async () => {
  const runs = '"videoPrimaryInfoRenderer":{"title":{"runs":[{"text":"From runs"}]}}';
  const meta = '<meta name="title" content="From meta">';
  const noTitle = details({ titleJson: '""' });
  const page = (...parts) => `<html>${canonical(OWN_VIDEO)}${parts.join('')}</html>`;
  const withTitle = details({ titleJson: '"From details"' });
  assert.equal((await check(page(meta, `<script>${runs}${withTitle}</script>`))).title, 'From details');
  assert.equal((await check(page(meta, `<script>${runs}${noTitle}</script>`))).title, 'From meta');
  assert.equal((await check(page(`<script>${runs}${noTitle}</script>`))).title, 'From runs');
  assert.equal((await check(page(`<script>${noTitle}</script>`))).title, 'Live now');
});

test('the current video belongs to another channel: not live', async () => {
  const viaDetails = `<html>${canonical('otherstream')}<script>${details({ videoId: 'otherstream', channelId: OTHER })}</script></html>`;
  assert.deepEqual(await check(viaDetails), { live: false });
  assert.deepEqual(await check(loginRequiredPage({ owner: OTHER, videoId: 'otherstream' })), { live: false });
  const viaMicroformat = `<html>${canonical('otherstream')}"isLive":true"pageOwnerDetails":{"name":"x","externalChannelId":"${OTHER}"}</html>`;
  assert.deepEqual(await check(viaMicroformat), { live: false });
});

test('the owner is not found: unknown (live: null), never announced', async () => {
  const page = `<html>${canonical(OWN_VIDEO)}"isLive":true<script>${recommendations(4)}</script></html>`;
  assert.deepEqual(await check(page), { live: null, reason: 'owner unknown' });
});

test("a recommendation's owner field is not taken for the current video's", async () => {
  // No videoDetails and no owner block of its own: only a recommendation names a channel.
  const page = `<html>${canonical(OWN_VIDEO)}"isLive":true<script>${recommendations(5)}</script></html>`;
  assert.deepEqual(await check(page, OTHER), { live: null, reason: 'owner unknown' });
});

test("videoDetails decides: the channel's own video is not live while a recommendation is", async () => {
  const page = `<html>${canonical(OWN_VIDEO)}<script>${recommendations(6)}${details({ isLive: false })}</script></html>`;
  assert.deepEqual(await check(page), { live: false });
});

test('a page with only recommendations (a channel that is not live) is not live', async () => {
  const notLive =
    `<html><link rel="canonical" href="https://www.youtube.com/channel/${OWN}">` +
    `<meta itemprop="identifier" content="${OWN}"><script>${recommendations(7)}</script></html>`;
  assert.deepEqual(await check(notLive), { live: false });
  const markersOnly = `<html><script>${recommendations(8)}"isLiveNow":true</script></html>`;
  assert.deepEqual(await check(markersOnly), { live: false });
});

test('a channel id past the old 300 KB scan cap is still found', async () => {
  const pad = 'x'.repeat(350_000);
  const page = `<html>"isLive":true${pad}${canonical(OWN_VIDEO)}"pageOwnerDetails":{"name":"x","externalChannelId":"${OWN}"}</html>`;
  assert.deepEqual(await check(page), { live: true, videoId: OWN_VIDEO, title: 'Live now' });
});

test('an earlier videoDetails of another shape (microformat) does not hide the player one', async () => {
  const page = `<html>"videoDetails":{"externalVideoId":"${OWN_VIDEO}"}<script>${recommendations(9)}${details()}</script></html>`;
  assert.deepEqual(await check(page), { live: true, videoId: OWN_VIDEO, title: 'My stream' });
});

test('the current video endpoint is read as an object: a watchEndpoint after it is not its video', async () => {
  const page =
    `<html><script>${recommendations(11)}"currentVideoEndpoint":{"browseEndpoint":{"browseId":"${OWN}"}},` +
    `"watchEndpoint":{"videoId":"r11x0000000"},"videoOwnerRenderer":{"navigationEndpoint":{"browseEndpoint":{"browseId":"${OWN}"}}}` +
    `"isLive":true</script></html>`;
  assert.deepEqual(await check(page), { live: false });
});

test('an externalChannelId outside pageOwnerDetails is not the owner', async () => {
  const page = `<html>${canonical(OWN_VIDEO)}"isLive":true<script>{"externalChannelId":"${OWN}"}</script></html>`;
  assert.deepEqual(await check(page), { live: null, reason: 'owner unknown' });
});

// --- through runAlert ---------------------------------------------------

let sends = [];
let nextGuild = 900000000000000500n;
let GUILD_ID = '';
beforeEach(() => {
  _resetFeedHealthForTests();
  sends = [];
  GUILD_ID = String((nextGuild += 1n));
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (msg) => {
      sends.push(msg);
      return { id: `msg${sends.length}` };
    },
    messages: { delete: async () => {} },
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
});

const ALERT = { ytChannelId: OWN, discordChannelId: DISCORD_CHANNEL, onLive: true };

test("runAlert: two polls where only the recommendations change post once, with the channel's own link", async () => {
  let seed = 10;
  await withPage(
    () => loginRequiredPage({ seed: (seed += 1) }),
    async () => {
      await runAlert(GUILD_ID, ALERT);
      await runAlert(GUILD_ID, ALERT);
      await runAlert(GUILD_ID, ALERT);
    }
  );
  assert.equal(sends.length, 1, 'no repost loop');
  assert.ok(JSON.stringify(sends[0]).includes(`watch?v=${OWN_VIDEO}`));
  assert.equal(await liveVideoId(GUILD_ID, OWN), OWN_VIDEO);
});

test('runAlert: an owner that cannot be found posts nothing and leaves a running post alone', async () => {
  const unknown = `<html>${canonical('r20x0000001')}"isLive":true<script>${recommendations(20)}</script></html>`;
  await withPage(unknown, () => runAlert(GUILD_ID, ALERT));
  assert.equal(sends.length, 0, 'nothing announced');
  assert.equal(await liveVideoId(GUILD_ID, OWN), null);

  // A post that is already running stays: not verifiable is not "ended".
  await markLive(GUILD_ID, OWN, OWN_VIDEO, { channelId: DISCORD_CHANNEL, messageId: 'msg-running' });
  _resetFeedHealthForTests();
  await withPage(unknown, () => runAlert(GUILD_ID, ALERT));
  assert.equal(await liveVideoId(GUILD_ID, OWN), OWN_VIDEO);
  assert.equal(sends.length, 0);
});

test("runAlert: another channel's stream on the page posts nothing", async () => {
  await withPage(loginRequiredPage({ owner: OTHER, videoId: 'otherstream' }), () =>
    runAlert(GUILD_ID, ALERT)
  );
  assert.equal(sends.length, 0);
  assert.equal(await liveVideoId(GUILD_ID, OWN), null);
});

test('runAlert: a page that alternates between OK and LOGIN_REQUIRED neither ends nor reposts the running post', async () => {
  let n = 0;
  await withPage(
    () => (n++ % 2 === 0 ? okPage({ seed: 30 + n }) : loginRequiredPage({ seed: 30 + n })),
    async () => {
      for (let i = 0; i < 6; i += 1) await runAlert(GUILD_ID, ALERT);
    }
  );
  assert.equal(sends.length, 1, 'one post, no end message, no repost');
  assert.equal(await liveVideoId(GUILD_ID, OWN), OWN_VIDEO);
});
