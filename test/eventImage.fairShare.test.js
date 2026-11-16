// One server must not use all of the event image memory, or make Sylo download over and over
// (modules/lib/eventImage.js).
import './helpers/tmpDb.js';
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CONCURRENT_DOWNLOADS,
  MAX_ENTRIES,
  MAX_IMAGE_BYTES,
  MAX_OWNER_BYTES,
  MAX_OWNER_ENTRIES,
  MAX_TOTAL_BYTES,
  OWNER_FETCHES_PER_MINUTE,
  _clearImageCache,
  _imageCacheSize,
  _setImageFetcher,
  loadImage,
} from '../src/modules/lib/eventImage.js';

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SMALL = Buffer.concat([PNG_HEAD, Buffer.from('x')]);
const BIG = Buffer.concat([PNG_HEAD, Buffer.alloc(MAX_IMAGE_BYTES - PNG_HEAD.length - 16)]);
const url = (name) => `https://cdn.discordapp.com/attachments/1/2/${name}.png`;
const reply = (body) => ({
  status: 200,
  ok: true,
  headers: new Headers({ 'content-type': 'image/png' }),
  body,
});

let calls;
function fetcher(answer) {
  calls = [];
  _setImageFetcher(async (link) => {
    calls.push(link);
    return answer(link);
  });
}
afterEach(() => {
  mock.restoreAll();
  _setImageFetcher(null);
  _clearImageCache();
});

test('limits are consistent: a server share is a fraction of the whole', () => {
  assert.ok(MAX_OWNER_BYTES * 2 <= MAX_TOTAL_BYTES);
  assert.ok(MAX_OWNER_ENTRIES * 2 <= MAX_ENTRIES);
  assert.ok(MAX_OWNER_BYTES >= MAX_IMAGE_BYTES, 'one image of the biggest size fits in a share');
});

test('a server with many big images cannot push another server image out', async () => {
  fetcher((link) => reply(link.includes('small') ? SMALL : BIG));
  await loadImage(url('small-b'), 'guild-b');
  for (let n = 0; n < 9; n += 1) await loadImage(url(`big-a${n}`), 'guild-a');
  const before = calls.length;
  await loadImage(url('small-b'), 'guild-b');
  assert.equal(calls.length, before, 'guild B image is still cached');
  assert.ok(_imageCacheSize().bytes <= MAX_OWNER_BYTES + SMALL.length, 'guild A holds only its share');
});

test('when the whole memory is full, the biggest holder gives way first', async () => {
  fetcher((link) => reply(link.includes('small') ? SMALL : BIG));
  // Four servers fill their share each (16 MiB in all), then a small server adds one image.
  for (const owner of ['a', 'b', 'c', 'd']) {
    for (let n = 0; n < 2; n += 1) await loadImage(url(`big-${owner}${n}`), owner);
  }
  await loadImage(url('small-e'), 'e');
  await loadImage(url('small-f'), 'f');
  assert.ok(_imageCacheSize().bytes <= MAX_TOTAL_BYTES);
  const before = calls.length;
  await loadImage(url('small-e'), 'e');
  await loadImage(url('small-f'), 'f');
  assert.equal(calls.length, before, 'the small servers images stayed');
});

test('a refetch storm is bounded: one server starts at most OWNER_FETCHES_PER_MINUTE downloads a minute', async () => {
  fetcher(() => reply(BIG));
  for (let round = 0; round < 5; round += 1) {
    for (let n = 0; n < 9; n += 1) await loadImage(url(`storm${n}`), 'guild-a');
  }
  assert.ok(calls.length <= OWNER_FETCHES_PER_MINUTE, `made ${calls.length} downloads`);
  assert.equal(await loadImage(url('storm-new'), 'guild-a'), null, 'over the limit: no image, no download');
  assert.equal(calls.length, OWNER_FETCHES_PER_MINUTE);
});

test('the limit is per server, and it renews after a minute', async () => {
  const now = mock.method(Date, 'now', () => 1_000_000);
  fetcher(() => reply(SMALL));
  for (let n = 0; n < OWNER_FETCHES_PER_MINUTE + 5; n += 1) await loadImage(url(`a${n}`), 'guild-a');
  assert.equal(calls.length, OWNER_FETCHES_PER_MINUTE);
  assert.ok(await loadImage(url('b0'), 'guild-b'), 'another server is not affected');
  now.mock.mockImplementation(() => 1_000_000 + 61_000);
  assert.ok(await loadImage(url('a-later'), 'guild-a'), 'a minute later it may download again');
});

test('a failure is remembered, so a broken link costs one download', async () => {
  fetcher(async () => ({ status: 404, ok: false, headers: new Headers(), body: Buffer.alloc(0) }));
  for (let n = 0; n < 10; n += 1) assert.equal(await loadImage(url('gone'), 'guild-a'), null);
  assert.equal(calls.length, 1);
});

test('visitors who arrive together share one download, and it counts once', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  fetcher(async () => {
    await gate;
    return reply(SMALL);
  });
  const all = Promise.all(Array.from({ length: 30 }, () => loadImage(url('same'), 'guild-a')));
  release();
  await all;
  assert.equal(calls.length, 1);
});

test('at most MAX_CONCURRENT_DOWNLOADS run at once across servers', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  fetcher(async () => {
    await gate;
    return reply(SMALL);
  });
  const loads = Array.from({ length: MAX_CONCURRENT_DOWNLOADS + 3 }, (_, n) =>
    loadImage(url(`c${n}`), `guild-${n}`)
  );
  assert.equal(calls.length, MAX_CONCURRENT_DOWNLOADS);
  release();
  const results = await Promise.all(loads);
  assert.equal(results.filter(Boolean).length, MAX_CONCURRENT_DOWNLOADS);
  assert.ok(await loadImage(url('after'), 'guild-x'), 'the slots are free again');
});

test('entry-count pressure takes from the server with the most entries, not the most bytes', async () => {
  const HALF_MB = Buffer.concat([PNG_HEAD, Buffer.alloc(500 * 1024)]);
  fetcher((link) => reply(link.includes('real') ? HALF_MB : SMALL));
  // Four servers fill their entry share with tiny images: the 64 entries of the whole cache.
  for (const owner of ['a', 'b', 'c', 'd']) {
    for (let n = 0; n < MAX_OWNER_ENTRIES; n += 1) await loadImage(url(`tiny-${owner}${n}`), owner);
  }
  assert.equal(_imageCacheSize().entries, MAX_ENTRIES);
  // A real server then loads its icon and its event image.
  await loadImage(url('real-icon'), 'guild-b');
  await loadImage(url('real-image'), 'guild-b');
  const before = calls.length;
  assert.ok(await loadImage(url('real-icon'), 'guild-b'));
  assert.ok(await loadImage(url('real-image'), 'guild-b'));
  assert.equal(calls.length, before, 'both images of the real server stayed cached');
  assert.ok(_imageCacheSize().entries <= MAX_ENTRIES);
});
