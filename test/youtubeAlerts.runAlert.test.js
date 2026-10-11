import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAlert } from '../src/modules/youtubeAlerts.js';
import { markVideoSeen, isVideoSeen, liveVideoId } from '../src/db/youtubeAlerts.js';
import { runtime } from '../src/runtime.js';

const YT_CHANNEL = 'UC' + 'x'.repeat(22);
const DISCORD_CHANNEL = '123456789012345678';
const GUILD_ID = '900000000000000020';

function mockGuild({ sendOk }) {
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async () => {
      if (!sendOk) throw new Error('send failed');
      return { id: 'msg1' };
    },
  };
  return {
    channels: { cache: new Map([[DISCORD_CHANNEL, channel]]), fetch: async () => channel },
    members: { me: {} },
  };
}

function setClient(sendOk) {
  runtime.client = { guilds: { cache: new Map([[GUILD_ID, mockGuild({ sendOk })]]) } };
}

const VIDEO_FEED_XML = (videoId) =>
  `<?xml version="1.0"?><feed><author><name>Some Channel</name></author>
    <entry><yt:videoId>${videoId}</yt:videoId><title>New upload</title>
      <published>2024-06-01T00:00:00+00:00</published></entry></feed>`;

const LIVE_HTML = (videoId) =>
  `<html>"isLive":true<link rel="canonical" href="https://www.youtube.com/watch?v=${videoId}"></html>`;

test('runAlert (onVideo): a failed send leaves the video unseen so it retries next poll', async () => {
  const videoId = 'failvideo01';
  await markVideoSeen(GUILD_ID, YT_CHANNEL, 'seed-so-hasSeenAny-is-true');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => VIDEO_FEED_XML(videoId) });
  setClient(false);

  try {
    await runAlert(GUILD_ID, { ytChannelId: YT_CHANNEL, discordChannelId: DISCORD_CHANNEL, onVideo: true });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(await isVideoSeen(GUILD_ID, YT_CHANNEL, videoId), false);
});

test('runAlert (onVideo): a successful send marks the video seen', async () => {
  const videoId = 'okvideo0001';
  await markVideoSeen(GUILD_ID, YT_CHANNEL, 'seed-so-hasSeenAny-is-true-2');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => VIDEO_FEED_XML(videoId) });
  setClient(true);

  try {
    await runAlert(GUILD_ID, { ytChannelId: YT_CHANNEL, discordChannelId: DISCORD_CHANNEL, onVideo: true });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(await isVideoSeen(GUILD_ID, YT_CHANNEL, videoId), true);
});

test('runAlert (onLive): a failed post leaves the stream unrecorded so it retries next poll', async () => {
  const ytChannel = YT_CHANNEL + '-live-fail';
  const videoId = 'livefail001';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => LIVE_HTML(videoId) });
  setClient(false);

  try {
    await runAlert(GUILD_ID, { ytChannelId: ytChannel, discordChannelId: DISCORD_CHANNEL, onLive: true });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(await liveVideoId(GUILD_ID, ytChannel), null);
  assert.equal(await isVideoSeen(GUILD_ID, ytChannel, videoId), false);
});

test('runAlert (onLive): a successful post records the stream as known', async () => {
  const ytChannel = YT_CHANNEL + '-live-ok';
  const videoId = 'liveok00001';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => LIVE_HTML(videoId) });
  setClient(true);

  try {
    await runAlert(GUILD_ID, { ytChannelId: ytChannel, discordChannelId: DISCORD_CHANNEL, onLive: true });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(await liveVideoId(GUILD_ID, ytChannel), videoId);
  assert.equal(await isVideoSeen(GUILD_ID, ytChannel, videoId), true);
});
