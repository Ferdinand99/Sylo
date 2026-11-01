// The fetch behind the images of a public event page (modules/lib/eventImage.js): what is accepted,
// what is refused, what is remembered, and that the memory it uses is bounded.
import './helpers/tmpDb.js';
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAILED_TTL_MS,
  MAX_ENTRIES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  OK_TTL_MS,
  _clearImageCache,
  _imageCacheSize,
  _setImageFetcher,
  loadImage,
  sniffImageType,
  sweepImageCache,
} from '../src/modules/lib/eventImage.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]);
const url = (n) => `https://cdn.discordapp.com/attachments/1/2/p${n}.png`;
const reply = (body, type = 'image/png', status = 200) => ({
  status,
  ok: status === 200,
  headers: new Headers({ 'content-type': type }),
  body,
});

let calls;
function fetcher(answer = async () => reply(PNG)) {
  calls = [];
  _setImageFetcher(async (link, options) => {
    calls.push({ link, options });
    return answer(link, options);
  });
}
afterEach(() => {
  mock.restoreAll();
  _setImageFetcher(null);
  _clearImageCache();
});

test('sniffImageType: PNG, JPEG, GIF and WebP by their first bytes, nothing else', () => {
  assert.equal(sniffImageType(PNG), 'image/png');
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])), 'image/jpeg');
  assert.equal(sniffImageType(Buffer.from('GIF87a--')), 'image/gif');
  assert.equal(sniffImageType(Buffer.from('GIF89a--')), 'image/gif');
  assert.equal(
    sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')])),
    'image/webp'
  );
  for (const not of [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    Buffer.from('<?xml version="1.0"?><svg/>'),
    Buffer.from('<html></html>'),
    Buffer.from('BM12345678'),
    Buffer.from('RIFF....WAVEfmt '),
    Buffer.alloc(0),
    Buffer.from([0x89, 0x50]),
  ]) {
    assert.equal(sniffImageType(not), null, not.toString('latin1').slice(0, 20));
  }
});

test('loadImage fetches an allowed Discord link once and asks for what it will accept', async () => {
  fetcher();
  const image = await loadImage(url(1));
  assert.equal(image.type, 'image/png');
  assert.deepEqual(image.body, PNG);
  assert.equal(calls.length, 1);
  const { options } = calls[0];
  assert.equal(options.maxRedirects, 0);
  assert.equal(options.allowPrivate, false);
  assert.equal(options.maxBytes, MAX_IMAGE_BYTES);
  assert.ok(options.timeoutMs <= 10_000);
  assert.doesNotMatch(options.headers.accept, /svg/);
});

test('loadImage never calls the network for a link that is not on the list, or is not a link', async () => {
  fetcher();
  for (const link of [
    null,
    undefined,
    '',
    42,
    'https://example.com/a.png',
    'http://cdn.discordapp.com/a.png',
    'https://cdn.discordapp.com.example.com/a.png',
    'https://cdn.discordapp.com@example.com/a.png',
    'https://127.0.0.1/a.png',
    'https://cdn.discordapp.com:8443/a.png',
    'file:///etc/passwd',
  ]) {
    assert.equal(await loadImage(link), null, String(link));
  }
  assert.equal(calls.length, 0);
});

test('loadImage answers null for every kind of failure', async () => {
  const answers = [
    async () => reply(PNG, 'image/png', 404),
    async () => reply(PNG, 'image/png', 302),
    async () => reply(PNG, 'image/png', 204),
    async () => {
      throw new Error('boom');
    },
    async () => reply(Buffer.from('<svg/>'), 'image/svg+xml'),
    async () => reply(Buffer.from('<svg/>'), 'image/png'),
    async () => reply(PNG, 'text/html'),
    async () => reply(PNG, ''),
    async () => reply(Buffer.alloc(0)),
    async () => reply('not a buffer'),
    async () => ({ status: 200, body: PNG }), // no headers at all
  ];
  for (const [i, answer] of answers.entries()) {
    fetcher(answer);
    assert.equal(await loadImage(url(100 + i)), null, `answer ${i}`);
  }
});

test('a content type with parameters or capitals is read, and the bytes decide what is served', async () => {
  fetcher(async () => reply(Buffer.from([0xff, 0xd8, 0xff, 0xdb]), 'Image/PNG; charset=binary'));
  assert.equal((await loadImage(url(1))).type, 'image/jpeg');
});

test('an answer is kept for OK_TTL_MS, a failure for the shorter FAILED_TTL_MS', async () => {
  let now = 1_000_000;
  mock.method(Date, 'now', () => now);
  fetcher();
  await loadImage(url(1));
  await loadImage(url(1));
  assert.equal(calls.length, 1, 'kept');
  now += OK_TTL_MS - 1;
  await loadImage(url(1));
  assert.equal(calls.length, 1, 'still kept');
  now += 1;
  await loadImage(url(1));
  assert.equal(calls.length, 2, 'fetched again after the time');

  fetcher(async () => reply(PNG, 'image/png', 404));
  now += 10;
  assert.equal(await loadImage(url(2)), null);
  assert.equal(await loadImage(url(2)), null);
  assert.equal(calls.length, 1, 'the failure is remembered');
  now += FAILED_TTL_MS;
  await loadImage(url(2));
  assert.equal(calls.length, 2, 'and tried again soon, since a link can be mended');
});

test('visitors who arrive together share one fetch', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  fetcher(async () => {
    await gate;
    return reply(PNG);
  });
  const all = Promise.all(Array.from({ length: 10 }, () => loadImage(url(1))));
  release();
  const results = await all;
  assert.equal(calls.length, 1);
  assert.ok(results.every((r) => r?.type === 'image/png'));
});

test('the memory is bounded: by the number of entries, and by the bytes', async () => {
  fetcher();
  for (let n = 0; n < MAX_ENTRIES + 20; n += 1) await loadImage(url(n));
  assert.ok(_imageCacheSize().entries <= MAX_ENTRIES, 'entries');

  _clearImageCache();
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES - PNG.length - 1)]);
  fetcher(async () => reply(big));
  for (let n = 0; n < 20; n += 1) await loadImage(url(n));
  assert.ok(_imageCacheSize().bytes <= MAX_TOTAL_BYTES, 'bytes');
  assert.ok(_imageCacheSize().bytes > 0);
  // the oldest went out first: the newest is still kept
  const before = calls.length;
  await loadImage(url(19));
  assert.equal(calls.length, before);
});

test('an entry whose time is up leaves the memory at the next sweep, with no new fetch needed', async () => {
  let now = 5_000_000;
  mock.method(Date, 'now', () => now);
  fetcher();
  await loadImage(url(1));
  fetcher(async () => reply(PNG, 'image/png', 404));
  await loadImage(url(2));
  assert.equal(_imageCacheSize().entries, 2);
  assert.ok(_imageCacheSize().bytes > 0);

  now += FAILED_TTL_MS;
  sweepImageCache();
  assert.equal(_imageCacheSize().entries, 1, 'the failure is gone first');
  assert.ok(_imageCacheSize().bytes > 0, 'the image is still within its time');

  now += OK_TTL_MS - FAILED_TTL_MS - 1;
  sweepImageCache();
  assert.equal(_imageCacheSize().entries, 1, 'one millisecond short');
  now += 1;
  sweepImageCache();
  assert.deepEqual(_imageCacheSize(), { entries: 0, bytes: 0 }, 'nothing kept past its time');
});

test('any use sweeps too, so an idle instance does not keep a stale copy for long', async () => {
  let now = 9_000_000;
  mock.method(Date, 'now', () => now);
  fetcher();
  await loadImage(url(1));
  now += OK_TTL_MS + 1;
  fetcher(async () => reply(PNG, 'image/png', 404));
  await loadImage(url(2)); // a different link: the old copy goes out on the way
  assert.equal(_imageCacheSize().bytes, 0);
  assert.equal(_imageCacheSize().entries, 1);
});
