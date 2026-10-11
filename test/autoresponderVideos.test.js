import { startWebApp, post } from './helpers/webApp.js';
import { GID, CH } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseAutoresponder,
  buildAutoresponderReply,
  prepareAutoresponderReply,
  autoresponderValidationError,
} from '../src/modules/autoresponder.js';
import {
  canDownloadVideo,
  videoExtension,
  downloadAutoresponderVideo,
  MAX_VIDEO_BYTES,
} from '../src/modules/lib/autoresponderVideo.js';
import { getGuildModule } from '../src/db/modules.js';

const video =
  'https://packaged-media.redd.it/example/pb/m2-res_1080p.mp4?m=DASHPlaylist.mpd&e=1791741600&s=signature';
const image = 'https://example.com/image.png';
const context = {
  userId: '123456789012345678',
  username: 'tester',
  guildName: 'Test',
  channelId: CH.general,
};
const rule = (extra = {}) =>
  normaliseAutoresponder({
    responders: [
      {
        trigger: 'f',
        match: 'exact',
        responseType: 'random-media',
        imageUrls: [video],
        response: '',
        ...extra,
      },
    ],
  }).responders[0];

test('video reply recognizes signed MP4 URLs and mixed image/video pools without breaking old rules', () => {
  assert.equal(videoExtension(video), 'mp4');
  assert.equal(videoExtension('https://example.com/a.WEBM?x=1'), 'webm');
  assert.equal(autoresponderValidationError([rule()]), null);
  const mixed = rule({ imageUrls: [image, video] });
  assert.equal(buildAutoresponderReply(mixed, context, () => 0).embeds[0].toJSON().image.url, image);
  const payload = buildAutoresponderReply(mixed, context, () => 0.99);
  assert.equal(payload.content, video);
  assert.equal(payload.embeds, undefined);
  assert.equal(buildAutoresponderReply(rule({ responseType: 'random-image' }), context).content, video);
});

test('video attachment preserves caption placeholders and falls back when uploads are unavailable', async () => {
  const r = rule({ response: 'Hej {username}' });
  let fetched;
  const buffer = Buffer.from('video');
  const uploaded = await prepareAutoresponderReply(r, context, {
    download: async (url) => {
      fetched = url;
      return buffer;
    },
  });
  assert.equal(fetched, video);
  assert.equal(uploaded.content, 'Hej tester');
  assert.equal(uploaded.files[0].name, 'odpowiedz.mp4');
  assert.equal(uploaded.files[0].attachment, buffer);
  assert.deepEqual(uploaded.allowedMentions.roles, []);
  const failed = await prepareAutoresponderReply(r, context, {
    download: async () => {
      throw new Error('expired');
    },
  });
  assert.equal(failed.content, `Hej tester\n${video}`);
  const missingPermission = await prepareAutoresponderReply(r, context, {
    attachVideos: false,
    download: async () => {
      assert.fail('Must not download');
    },
  });
  assert.equal(missingPermission.content, `Hej tester\n${video}`);
  const embedded = await prepareAutoresponderReply(
    rule({ embed: true, response: 'Hej {username}' }),
    context,
    { download: async () => buffer }
  );
  assert.equal(embedded.embeds[0].toJSON().description, 'Hej tester');
  assert.equal(embedded.content, undefined);
});

test('video link fallback stays within Discord content limits and preserves the complete signed URL', () => {
  const payload = buildAutoresponderReply(rule({ response: 'x'.repeat(2000) }), context);
  assert.ok(payload.content.length <= 2000);
  assert.ok(payload.content.endsWith(video));
});

test('video downloader never fetches arbitrary hosts, local addresses, credentials, ports or HTTP', async () => {
  for (const url of [
    'http://packaged-media.redd.it/x.mp4',
    'https://localhost/a.mp4',
    'https://127.0.0.1/a.mp4',
    'https://example.com/a.mp4',
    'https://packaged-media.redd.it.evil.example/a.mp4',
    'https://user:pass@v.redd.it/a.mp4',
    'https://v.redd.it:8443/a.mp4',
    'https://v.redd.it/a.png',
  ]) {
    assert.equal(canDownloadVideo(url), false, url);
    assert.equal(
      await downloadAutoresponderVideo(url, { fetchImpl: async () => assert.fail('Forbidden fetch') }),
      null
    );
  }
});

test('video downloader accepts a bounded video, rejects HTML/expired/oversized responses and forbids redirects', async () => {
  const bytes = Buffer.from('video');
  const result = await downloadAutoresponderVideo(video, {
    fetchImpl: async (url, options) => {
      assert.equal(url, video);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(bytes, { headers: { 'content-type': 'video/mp4' } });
    },
  });
  assert.deepEqual(result, bytes);
  for (const response of [
    new Response('expired', { status: 403 }),
    new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    new Response(bytes, {
      headers: { 'content-type': 'video/mp4', 'content-length': String(MAX_VIDEO_BYTES + 1) },
    }),
    new Response(Buffer.alloc(MAX_VIDEO_BYTES + 1), { headers: { 'content-type': 'video/mp4' } }),
  ])
    assert.equal(await downloadAutoresponderVideo(video, { fetchImpl: async () => response }), null);
  assert.equal(
    await downloadAutoresponderVideo(video, {
      fetchImpl: async () => {
        throw new Error('redirect blocked');
      },
    }),
    null
  );
});

test('video downloader limits concurrent transfers', async () => {
  const releases = [];
  const fetchImpl = () =>
    new Promise((resolve) =>
      releases.push(() => resolve(new Response('video', { headers: { 'content-type': 'video/mp4' } })))
    );
  const first = downloadAutoresponderVideo(video, { fetchImpl });
  const second = downloadAutoresponderVideo(video, { fetchImpl });
  assert.equal(await downloadAutoresponderVideo(video, { fetchImpl }), null);
  assert.equal(releases.length, 2);
  releases.forEach((release) => release());
  await Promise.all([first, second]);
});

test('V1 and V2 save and reload mixed media pools including signed URLs', async () => {
  const app = await startWebApp();
  try {
    const body = new URLSearchParams({
      ar_trigger: 'f',
      ar_match: 'exact',
      ar_response: '',
      ar_response_type: 'random-media',
      ar_images: `${image}\n${video}`,
      ar_embed: 'text',
      ar_delete: 'keep',
    });
    const saved = await post(app.base, `/guilds/${GID}/m/autoresponder/config`, body.toString());
    assert.equal(saved.status, 302);
    let config = (await getGuildModule(GID, 'autoresponder')).config;
    assert.deepEqual(config.responders[0].imageUrls, [image, video]);
    const html = await (await fetch(`${app.base}/guilds/${GID}/m/autoresponder`)).text();
    assert.match(html, /Losowy obrazek lub film/);
    assert.match(html, /random-media/);
    const api = await fetch(`${app.base}/api/v2/guilds/${GID}/modules/autoresponder/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ responders: [{ ...rule(), imageUrls: [video] }] }),
    });
    assert.equal(api.status, 200);
    config = (await api.json()).config;
    assert.deepEqual(config.responders[0].imageUrls, [video]);
    assert.equal(config.responders[0].responseType, 'random-media');
  } finally {
    app.close();
  }
});

test('message dispatch uploads videos, uses links without Attach Files and retries rejected uploads as links', async (t) => {
  const { dispatch } = await import('../src/modules/dispatch.js');
  const { setGuildModule } = await import('../src/db/modules.js');
  const app = await startWebApp();
  try {
    await setGuildModule(GID, 'autoresponder', {
      enabled: true,
      config: { cooldownSeconds: 0, responders: [rule()] },
    });
    t.mock.method(globalThis, 'fetch', async (url) => {
      assert.equal(url, video);
      return new Response('video', { headers: { 'content-type': 'video/mp4' } });
    });
    const channel = app.guild.channels.cache.get(CH.general);
    const message = {
      guild: app.guild,
      channel,
      channelId: CH.general,
      member: { roles: { cache: new Map() } },
      author: { id: context.userId, username: 'tester', bot: false },
      content: 'f',
    };
    await dispatch('messageCreate', GID, message);
    assert.equal(app.sink.messages.at(-1).payload.files[0].name, 'odpowiedz.mp4');
    assert.equal(app.sink.messages.at(-1).payload.content, undefined);
    const noAttachments = { ...channel, permissionsFor: () => ({ has: (p) => p !== 'AttachFiles' }) };
    await dispatch('messageCreate', GID, { ...message, channel: noAttachments });
    assert.equal(app.sink.messages.at(-1).payload.content, video);
    const sent = [];
    const rejectsUpload = {
      ...channel,
      send: async (payload) => {
        if (payload.files?.length) throw new Error('Discord upload rejected');
        sent.push(payload);
      },
    };
    await dispatch('messageCreate', GID, { ...message, channel: rejectsUpload });
    assert.equal(sent[0].content, video);
    assert.deepEqual(sent[0].files, []);
  } finally {
    app.close();
  }
});
