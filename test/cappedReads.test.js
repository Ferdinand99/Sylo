// The fetches of fixed hosts (a changelog from GitHub, YouTube pages and feeds) read at most a
// set number of bytes: a huge body is dropped, not held in memory.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { readTextCapped, SafeFetchError } from '../src/lib/safeFetch.js';
import { fetchChangelogBlock } from '../src/modules/githubAlerts.js';
import { checkLive, resolveYtChannel } from '../src/modules/youtubeAlerts.js';

const CHUNK = 1024 * 1024;

/** A response of `megabytes` MiB that is produced on demand; `pulled.count` says how much was read. */
function hugeResponse(megabytes, { withLength = false } = {}) {
  const pulled = { count: 0 };
  const body = new ReadableStream({
    pull(controller) {
      if (pulled.count >= megabytes) return controller.close();
      pulled.count += 1;
      controller.enqueue(new Uint8Array(CHUNK).fill(97));
    },
  });
  const headers = withLength ? { 'content-length': String(megabytes * CHUNK) } : {};
  return { response: new Response(body, { status: 200, headers }), pulled };
}

async function withFetch(response, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => response;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('readTextCapped: a body under the cap is read whole', async () => {
  assert.equal(await readTextCapped(new Response('hello'), 10), 'hello');
});

test('readTextCapped: a 50 MB body is cut off after the cap, not read to the end', async () => {
  const { response, pulled } = hugeResponse(50);
  await assert.rejects(readTextCapped(response, 2 * CHUNK), SafeFetchError);
  assert.ok(pulled.count < 10, `stopped early (read ${pulled.count} MB of 50)`);
});

test('readTextCapped: a declared length over the cap is refused before reading', async () => {
  const { response, pulled } = hugeResponse(50, { withLength: true });
  await assert.rejects(readTextCapped(response, CHUNK), /too large/);
  assert.equal(pulled.count, 0);
});

test('fetchChangelogBlock: a huge file gives null, not a huge read', async () => {
  const { response, pulled } = hugeResponse(50);
  const block = await withFetch(response, () => fetchChangelogBlock('o/r', 'CHANGELOG.md', 'abcdef1'));
  assert.equal(block, null);
  assert.ok(pulled.count < 10, `stopped early (read ${pulled.count} MB of 50)`);
});

test('YouTube pages: a huge page is dropped (live check and channel lookup)', async () => {
  const live = hugeResponse(50);
  assert.deepEqual(await withFetch(live.response, () => checkLive('UC' + 'a'.repeat(22))), { live: false });
  assert.ok(live.pulled.count < 10, `live check stopped early (read ${live.pulled.count} MB)`);

  const page = hugeResponse(50);
  assert.equal(await withFetch(page.response, () => resolveYtChannel('somechannel')), null);
  assert.ok(page.pulled.count < 10, `lookup stopped early (read ${page.pulled.count} MB)`);
});
