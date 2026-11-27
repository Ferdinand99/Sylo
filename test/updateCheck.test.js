// The update check (src/lib/updateCheck.js): comparing versions, the cache, the switch that turns it off,
// quiet failures, and what the release notes become (data with https links only, never markup).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_TTL_MS,
  FORCE_MIN_INTERVAL_MS,
  RETRY_AFTER_FAILURE_MS,
  UPDATE_COMMAND,
  compareVersions,
  createUpdateChecker,
  parseVersion,
  shapeNotes,
  shapeRelease,
} from '../src/lib/updateCheck.js';

const BODY = `## [5.3.0](https://github.com/Ferdinand99/Sylo/compare/v5.2.0...v5.3.0) (2026-11-20)


### Features

* **dashboard:** update notice ([#370](https://github.com/Ferdinand99/Sylo/issues/370)) ([abc1234](https://github.com/Ferdinand99/Sylo/commit/abc1234def))
* a [bad link](javascript:alert(1)) and an [http link](http://example.com/x) and [good](https://example.com/ok)

### Bug Fixes

* **security:** something ([#371](http://github.com/Ferdinand99/Sylo/issues/371))
`;

const release = (over = {}) => ({
  tag_name: 'v5.3.0',
  html_url: 'https://github.com/Ferdinand99/Sylo/releases/tag/v5.3.0',
  published_at: '2026-11-20T10:00:00Z',
  draft: false,
  prerelease: false,
  body: BODY,
  ...over,
});

const okFetch = (payload, calls = []) =>
  async function fakeFetch(url, init) {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

test('versions compare as numbers, a release outranks its prereleases, junk is null', () => {
  assert.equal(compareVersions('5.3.0', '5.2.0'), 1);
  assert.equal(compareVersions('5.2.0', '5.3.0'), -1);
  assert.equal(compareVersions('v5.2.0', '5.2.0'), 0);
  assert.equal(compareVersions('5.10.0', '5.9.9'), 1, 'numbers, not text');
  assert.equal(compareVersions('6.0.0', '5.99.99'), 1);
  assert.equal(compareVersions('5.3.0', '5.3.0-rc.1'), 1);
  assert.equal(compareVersions('5.3.0-rc.2', '5.3.0-rc.10'), -1);
  assert.equal(compareVersions('5.3.0-alpha', '5.3.0-beta'), -1);
  assert.equal(compareVersions('5.3.0-rc.1', '5.3.0-rc'), 1);
  assert.equal(compareVersions('latest', '5.3.0'), null);
  assert.equal(compareVersions('5.3', '5.3.0'), null);
  assert.equal(compareVersions(undefined, '5.3.0'), null);
  assert.equal(parseVersion('5.3.0+build.5').nums.join('.'), '5.3.0');
});

test('a release becomes the version, a GitHub page and notes as data', () => {
  const r = shapeRelease(release());
  assert.equal(r.version, '5.3.0');
  assert.equal(r.url, 'https://github.com/Ferdinand99/Sylo/releases/tag/v5.3.0');
  assert.equal(r.publishedAt, '2026-11-20T10:00:00Z');
  assert.equal(r.notesText, null);
  assert.deepEqual(
    r.notes.sections.map((s) => [s.title, s.kind, s.items.length]),
    [
      ['New', 'features', 2],
      ['Fixes', 'fixes', 1],
    ]
  );
  assert.equal(r.notes.items, undefined);
});

test('the notes keep https links only, as links or as plain labels', () => {
  const { notes } = shapeRelease(release());
  const items = notes.sections[0].items;
  assert.equal(items[0].scope, 'dashboard');
  // The text carries no HTML and the bad and http links are only their labels.
  const text = items[1].text;
  assert.doesNotMatch(text, /javascript:/);
  assert.doesNotMatch(text, /http:\/\/example\.com/);
  assert.match(text, /\[good\]\(https:\/\/example\.com\/ok\)/);
  assert.match(text, /bad link/);
  assert.match(text, /http link/);
  // The PR reference on the other link: an http one is dropped, an https one kept.
  assert.deepEqual(items[0].refs, [{ label: '#370', url: 'https://github.com/Ferdinand99/Sylo/issues/370' }]);
  assert.deepEqual(notes.sections[1].items[0].refs, []);
});

test('notes that are not in the changelog format come back as short plain text', () => {
  const { notes, notesText } = shapeNotes(
    'Plain **text** with a [link](http://x.test/a).\n\nAnd more.',
    '5.3.0'
  );
  assert.equal(notes, null);
  assert.match(notesText, /^Plain \*\*text\*\* with a link\./);
  assert.equal(shapeNotes('', '5.3.0').notesText, null);
  assert.equal(shapeNotes('x'.repeat(10000), '5.3.0').notesText.length, 4000);
});

test('drafts, prereleases and non-versions are not offered', () => {
  assert.equal(shapeRelease(release({ draft: true })), null);
  assert.equal(shapeRelease(release({ prerelease: true })), null);
  assert.equal(shapeRelease(release({ tag_name: 'nightly' })), null);
  assert.equal(shapeRelease(null), null);
  // A release page outside the Sylo repository is not passed on.
  assert.equal(shapeRelease(release({ html_url: 'https://evil.test/x' })).url, null);
});

test('a newer release is available, with notes and the command; the same version is not', async () => {
  const calls = [];
  const newer = createUpdateChecker({ version: '5.2.0', fetchImpl: okFetch(release(), calls) });
  const s = await newer.get();
  assert.equal(s.enabled, true);
  assert.equal(s.available, true);
  assert.equal(s.current, '5.2.0');
  assert.equal(s.latest, '5.3.0');
  assert.equal(s.checkFailed, false);
  assert.equal(s.command, UPDATE_COMMAND);
  assert.equal(s.command, 'docker compose pull && docker compose up -d');
  assert.ok(s.notes.sections.length);
  assert.ok(Date.parse(s.checkedAt));

  const same = await createUpdateChecker({ version: '5.3.0', fetchImpl: okFetch(release()) }).get();
  assert.equal(same.available, false);
  assert.equal(same.latest, '5.3.0');
  assert.equal(same.notes, null, 'no notes for a version the operator already runs');
  const ahead = await createUpdateChecker({ version: '5.4.0', fetchImpl: okFetch(release()) }).get();
  assert.equal(ahead.available, false);
});

test('the request is anonymous, to the fixed GitHub address, with a timeout', async () => {
  const calls = [];
  await createUpdateChecker({ version: '5.2.0', fetchImpl: okFetch(release(), calls) }).get();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/Ferdinand99/Sylo/releases/latest');
  const headers = calls[0].init.headers;
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.cookie, undefined);
  assert.match(headers['user-agent'], /^Sylo\/5\.2\.0/);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.redirect, 'error');
});

test('the answer is cached for six hours, then asked again; many callers share one request', async () => {
  let clock = 1_000_000;
  const calls = [];
  const checker = createUpdateChecker({
    version: '5.2.0',
    now: () => clock,
    fetchImpl: okFetch(release(), calls),
  });
  await Promise.all([checker.get(), checker.get(), checker.get()]);
  assert.equal(calls.length, 1, 'one request for three callers at once');
  clock += CHECK_TTL_MS - 1000;
  await checker.get();
  assert.equal(calls.length, 1, 'still cached');
  clock += 2000;
  await checker.get();
  assert.equal(calls.length, 2, 'asked again after six hours');
  await checker.get({ force: true });
  assert.equal(calls.length, 2, 'a forced check right after a look is served from the cache');
  clock += FORCE_MIN_INTERVAL_MS;
  await checker.get({ force: true });
  assert.equal(calls.length, 3, 'a forced check asks again after the minimum interval');
});

test('UPDATE_CHECK=off: nothing is requested', async () => {
  const calls = [];
  const checker = createUpdateChecker({
    enabled: false,
    version: '5.2.0',
    fetchImpl: okFetch(release(), calls),
  });
  const s = await checker.get();
  await checker.get({ force: true });
  assert.equal(calls.length, 0);
  assert.equal(s.enabled, false);
  assert.equal(s.available, false);
  assert.equal(s.latest, null);
  assert.equal(s.current, '5.2.0');
});

test('a failing check never throws, warns once, and waits before the next try', async () => {
  let clock = 5_000_000;
  let calls = 0;
  const logged = { warn: [], debug: [] };
  const checker = createUpdateChecker({
    version: '5.2.0',
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    },
    log: { warn: (...a) => logged.warn.push(a.join(' ')), debug: (...a) => logged.debug.push(a.join(' ')) },
  });
  const s = await checker.get();
  assert.equal(s.checkFailed, true);
  assert.equal(s.available, false);
  assert.equal(s.latest, null);
  await checker.get();
  assert.equal(calls, 1, 'not asked again straight away');
  clock += RETRY_AFTER_FAILURE_MS + 1;
  await checker.get();
  assert.equal(calls, 2);
  assert.equal(logged.warn.length, 1, 'one warning');
  assert.equal(logged.debug.length, 1, 'later failures are debug lines');
});

test('a failed re-check keeps the last good answer', async () => {
  let clock = 9_000_000;
  let fail = false;
  const checker = createUpdateChecker({
    version: '5.2.0',
    now: () => clock,
    fetchImpl: async () =>
      fail ? new Response('nope', { status: 503 }) : new Response(JSON.stringify(release()), { status: 200 }),
  });
  assert.equal((await checker.get()).available, true);
  fail = true;
  clock += CHECK_TTL_MS + 1;
  const s = await checker.get();
  assert.equal(s.checkFailed, true);
  assert.equal(s.available, true, 'the earlier answer still shows');
  assert.equal(s.latest, '5.3.0');
});

test('bad answers count as a failed check: HTTP errors, not JSON, no usable release, too large', async () => {
  const answers = [
    () => new Response('rate limited', { status: 403 }),
    () => new Response('<html>', { status: 200 }),
    () => new Response(JSON.stringify({ tag_name: 'nightly' }), { status: 200 }),
    () => new Response('x', { status: 200, headers: { 'content-length': '5000000' } }),
    () => new Response(JSON.stringify(release({ body: 'x'.repeat(1_100_000) })), { status: 200 }),
  ];
  for (const answer of answers) {
    const s = await createUpdateChecker({ version: '5.2.0', fetchImpl: async () => answer() }).get();
    assert.equal(s.checkFailed, true);
    assert.equal(s.available, false);
  }
});

test('a request that never answers is cut off by the timeout', async () => {
  const checker = createUpdateChecker({
    version: '5.2.0',
    timeoutMs: 50,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  });
  // AbortSignal.timeout does not keep the process alive by itself; in the app the server does.
  const keepAlive = setTimeout(() => {}, 5000);
  const started = Date.now();
  const s = await checker.get();
  clearTimeout(keepAlive);
  assert.ok(Date.now() - started < 2000);
  assert.equal(s.checkFailed, true);
});

test('"Check again" cannot be used to hammer GitHub: a minimum interval for the whole instance, and no force during a failure backoff', async () => {
  let clock = 20_000_000;
  let calls = 0;
  let fail = false;
  const checker = createUpdateChecker({
    version: '5.2.0',
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      return fail
        ? new Response('nope', { status: 503 })
        : new Response(JSON.stringify(release()), { status: 200 });
    },
  });
  await checker.get();
  for (let i = 0; i < 10; i++) await checker.get({ force: true });
  assert.equal(calls, 1, 'ten forced checks in the same moment are one request');
  clock += FORCE_MIN_INTERVAL_MS - 1;
  await checker.get({ force: true });
  assert.equal(calls, 1);
  clock += 1;
  fail = true;
  await checker.get({ force: true });
  assert.equal(calls, 2, 'allowed after the minimum interval');
  // It failed: the failure backoff is respected, force or not.
  clock += FORCE_MIN_INTERVAL_MS * 2;
  for (let i = 0; i < 5; i++) assert.equal((await checker.get({ force: true })).checkFailed, true);
  assert.equal(calls, 2, 'no forced request while a failure is waited out');
  clock += RETRY_AFTER_FAILURE_MS;
  fail = false;
  assert.equal((await checker.get({ force: true })).checkFailed, false);
  assert.equal(calls, 3);
});

test('the body is capped while it streams: a huge answer is cut off, not read to the end', async () => {
  let pulled = 0;
  const chunk = new TextEncoder().encode('x'.repeat(300_000));
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  const body = new ReadableStream({
    pull(controller) {
      pulled++;
      if (pulled > 50) return controller.close();
      controller.enqueue(chunk);
    },
  });
  const s = await createUpdateChecker({
    version: '5.2.0',
    fetchImpl: async () => new Response(body, { status: 200 }),
  }).get();
  assert.equal(s.checkFailed, true);
  assert.ok(pulled < 10, `read ${pulled} chunks of 50`);
});
