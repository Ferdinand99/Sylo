import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { log } from '../src/lib/log.js';
import {
  GITHUB_EVENT_TYPES,
  sanitiseGithubEvents,
  verifyGithubSignature,
  formatGithubEvent,
  applyRolePing,
  pushTouchedPath,
  isDefaultBranchPush,
  extractLatestChangelogBlock,
  fetchChangelogBlock,
  formatChangelogPost,
} from '../src/modules/githubAlerts.js';

test('sanitiseGithubEvents keeps only known keys, dedupes', () => {
  assert.deepEqual(sanitiseGithubEvents(['push', 'push', 'release', 'not-a-real-event']), [
    'push',
    'release',
  ]);
  assert.deepEqual(sanitiseGithubEvents(undefined), []);
  // Express turns one checked box into a bare string, not a 1-item array — same
  // as every other multi-checkbox field in guilds.js, callers normalise with
  // `[].concat(...)` before calling this, so a bare string here is out of contract.
  assert.deepEqual(sanitiseGithubEvents('push'), []);
});

test('GITHUB_EVENT_TYPES keys are all accepted by sanitiseGithubEvents', () => {
  const keys = GITHUB_EVENT_TYPES.map((e) => e.key);
  assert.deepEqual(sanitiseGithubEvents(keys), keys);
});

test('verifyGithubSignature: accepts a correctly signed body', () => {
  const secret = 'topsecret';
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyGithubSignature(secret, body, sig), true);
});

test('verifyGithubSignature: rejects a wrong secret, wrong body, or missing/malformed header', () => {
  const secret = 'topsecret';
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  assert.equal(verifyGithubSignature('wrong-secret', body, sig), false);
  assert.equal(verifyGithubSignature(secret, Buffer.from('{"tampered":true}'), sig), false);
  assert.equal(verifyGithubSignature(secret, body, undefined), false);
  assert.equal(verifyGithubSignature(secret, body, 'not-sha256-prefixed'), false);
  assert.equal(verifyGithubSignature(secret, body, 'sha256=deadbeef'), false); // wrong length, must not throw
  assert.equal(verifyGithubSignature(secret, 'not-a-buffer', sig), false);
});

test('formatGithubEvent: push renders commits newest-first, skips a branch delete', () => {
  const payload = {
    ref: 'refs/heads/main',
    compare: 'https://github.com/o/r/compare/a...b',
    repository: { full_name: 'o/r' },
    commits: [
      { id: 'a'.repeat(40), message: 'first\nbody', url: 'https://x/a', author: { name: 'Ann' } },
      { id: 'b'.repeat(40), message: 'second', url: 'https://x/b', author: { name: 'Bob' } },
    ],
  };
  const msg = formatGithubEvent('push', payload);
  assert.equal(msg.embeds[0].title, '2 new commits to o/r (main)');
  assert.equal(msg.embeds[0].url, payload.compare);
  assert.match(msg.embeds[0].description, /^\[`bbbbbbb`\].*second.*\n\[`aaaaaaa`\].*first/s);

  assert.equal(formatGithubEvent('push', { ...payload, deleted: true }), null);
  assert.equal(formatGithubEvent('push', { ...payload, commits: [] }), null);
});

test('formatGithubEvent: release only posts on "published", not draft edits', () => {
  const payload = {
    repository: { full_name: 'o/r' },
    action: 'published',
    release: { tag_name: 'v1.2.3', name: 'v1.2.3', html_url: 'https://x/rel', body: 'notes' },
  };
  const msg = formatGithubEvent('release', payload);
  assert.match(msg.embeds[0].title, /New release: o\/r v1\.2\.3/);
  assert.equal(msg.embeds[0].url, 'https://x/rel');

  assert.equal(formatGithubEvent('release', { ...payload, action: 'edited' }), null);
});

test('formatGithubEvent: issues opened/closed/reopened, ignores other actions', () => {
  const payload = {
    repository: { full_name: 'o/r' },
    action: 'opened',
    issue: { number: 42, title: 'Bug', html_url: 'https://x/i/42', user: { login: 'ann' } },
  };
  const msg = formatGithubEvent('issues', payload);
  assert.match(msg.embeds[0].title, /Issue opened: o\/r#42 Bug/);

  assert.equal(formatGithubEvent('issues', { ...payload, action: 'labeled' }), null);
});

test('formatGithubEvent: pull_request distinguishes merged from closed', () => {
  const base = {
    repository: { full_name: 'o/r' },
    number: 7,
    pull_request: { title: 'Fix', html_url: 'https://x/pr/7', user: { login: 'ann' } },
  };
  const merged = formatGithubEvent('pull_request', {
    ...base,
    action: 'closed',
    pull_request: { ...base.pull_request, merged: true },
  });
  assert.match(merged.embeds[0].title, /PR merged: o\/r#7 Fix/);

  const closed = formatGithubEvent('pull_request', {
    ...base,
    action: 'closed',
    pull_request: { ...base.pull_request, merged: false },
  });
  assert.match(closed.embeds[0].title, /PR closed: o\/r#7 Fix/);

  const opened = formatGithubEvent('pull_request', { ...base, action: 'opened' });
  assert.match(opened.embeds[0].title, /PR opened: o\/r#7 Fix/);
});

test('formatGithubEvent: star only on created (not unstar), fork always', () => {
  const starPayload = {
    repository: { full_name: 'o/r', stargazers_count: 10 },
    sender: { login: 'ann' },
  };
  const starred = formatGithubEvent('star', { ...starPayload, action: 'created' });
  assert.match(starred.embeds[0].description, /ann.*starred.*o\/r.*10 total/s);
  assert.equal(formatGithubEvent('star', { ...starPayload, action: 'deleted' }), null);

  const forked = formatGithubEvent('fork', {
    repository: { full_name: 'o/r' },
    sender: { login: 'ann' },
    forkee: { full_name: 'ann/r', html_url: 'https://x/ann/r' },
  });
  assert.match(forked.embeds[0].description, /ann.*forked.*o\/r.*ann\/r/s);
});

test('formatGithubEvent: an event/action this module does not handle returns null', () => {
  assert.equal(formatGithubEvent('deployment', { repository: { full_name: 'o/r' } }), null);
  assert.equal(formatGithubEvent('ping', {}), null); // ping is handled by the route, not this formatter
});

test('applyRolePing: adds a mention + allowedMentions when a role is set, otherwise a no-op', () => {
  const message = { embeds: [{ title: 'x' }] };

  const pinged = applyRolePing(message, '123456789012345678');
  assert.equal(pinged.content, '<@&123456789012345678>');
  assert.deepEqual(pinged.allowedMentions, { roles: ['123456789012345678'] });
  assert.deepEqual(pinged.embeds, message.embeds); // original fields preserved

  assert.deepEqual(applyRolePing(message, ''), message);
  assert.deepEqual(applyRolePing(message, null), message);
  assert.deepEqual(applyRolePing(message, undefined), message);
});

test('pushTouchedPath: true only when a commit added/modified/removed the exact path', () => {
  const payload = {
    commits: [
      { added: ['a.txt'], modified: [], removed: [] },
      { added: [], modified: ['CHANGELOG.md'], removed: [] },
    ],
  };
  assert.equal(pushTouchedPath(payload, 'CHANGELOG.md'), true);
  assert.equal(pushTouchedPath(payload, 'newt-beta/CHANGELOG.md'), false);
  assert.equal(pushTouchedPath({ commits: [] }, 'CHANGELOG.md'), false);
  assert.equal(pushTouchedPath(payload, ''), false);
  assert.equal(pushTouchedPath({}, 'CHANGELOG.md'), false); // no commits array at all
});

test("isDefaultBranchPush: true only for a push to the repo's own default branch", () => {
  const repo = { default_branch: 'main' };
  assert.equal(isDefaultBranchPush({ ref: 'refs/heads/main', repository: repo }), true);
  assert.equal(
    isDefaultBranchPush({ ref: 'refs/heads/release-please--branches--main', repository: repo }),
    false
  );
  assert.equal(isDefaultBranchPush({ ref: 'refs/tags/v1.0.0', repository: repo }), false);

  // A repo whose default branch isn't "main" (e.g. "master", or a custom name).
  const masterRepo = { default_branch: 'master' };
  assert.equal(isDefaultBranchPush({ ref: 'refs/heads/master', repository: masterRepo }), true);
  assert.equal(isDefaultBranchPush({ ref: 'refs/heads/main', repository: masterRepo }), false);

  // Missing repository info falls back to assuming "main" rather than matching nothing.
  assert.equal(isDefaultBranchPush({ ref: 'refs/heads/main' }), true);
  assert.equal(isDefaultBranchPush({}), false);
});

test('extractLatestChangelogBlock: the real newt changelog format — only the newest heading block', () => {
  const changelog = [
    '# Changelog',
    '',
    '## 🔹 Version 1.16.0-stable2 - (16.09.2026)',
    '- Fixed health reporting',
    '- Fixed armhf builds',
    '',
    '## 🔹 Version 1.15.0-stable - (28.08.2026)',
    '- Older entry that must not be included',
  ].join('\n');

  const block = extractLatestChangelogBlock(changelog);
  assert.match(block, /^## 🔹 Version 1\.16\.0-stable2/);
  assert.match(block, /Fixed armhf builds/);
  assert.doesNotMatch(block, /1\.15\.0-stable/);
});

test('extractLatestChangelogBlock: a single entry runs to end of file; no "## " heading is null', () => {
  assert.match(extractLatestChangelogBlock('## Only entry\nline one\nline two'), /line two$/);
  assert.equal(extractLatestChangelogBlock('# Changelog\nno subheadings here'), null);
  assert.equal(extractLatestChangelogBlock(''), null);
});

test('formatChangelogPost: wraps the block in a titled, linked embed', () => {
  const msg = formatChangelogPost('o/r', '## v1\n- fixed things', 'https://x/compare');
  assert.match(msg.embeds[0].title, /Changelog update: o\/r/);
  assert.equal(msg.embeds[0].url, 'https://x/compare');
  assert.match(msg.embeds[0].description, /fixed things/);
});

/** Mirrors youtubeAlerts.test.js's withMockedFetch helper. */
function withMockedFetch(response, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => response;
  const realWarn = log.warn;
  const warnings = [];
  log.warn = (...args) => warnings.push(args);
  return fn(warnings).finally(() => {
    globalThis.fetch = realFetch;
    log.warn = realWarn;
  });
}

test('fetchChangelogBlock: fetches raw.githubusercontent.com at the given ref and extracts the block', async () => {
  let requestedUrl;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, text: async () => '## v2\nnew stuff' };
  };
  try {
    const block = await fetchChangelogBlock('o/r', 'CHANGELOG.md', 'abc123');
    assert.equal(requestedUrl, 'https://raw.githubusercontent.com/o/r/abc123/CHANGELOG.md');
    assert.match(block, /new stuff/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchChangelogBlock: a 404 (private repo or wrong path) logs a warning and returns null', async () => {
  await withMockedFetch({ ok: false, status: 404 }, async (warnings) => {
    assert.equal(await fetchChangelogBlock('o/r', 'CHANGELOG.md', 'abc123'), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].join(' '), /HTTP 404/);
  });
});

test('fetchChangelogBlock: no "## " heading in the file logs a warning and returns null', async () => {
  await withMockedFetch({ ok: true, text: async () => 'no headings in here' }, async (warnings) => {
    assert.equal(await fetchChangelogBlock('o/r', 'CHANGELOG.md', 'abc123'), null);
    assert.match(warnings[0].join(' '), /no "## " heading found/);
  });
});

test('fetchChangelogBlock: a network error is caught, logged, and never thrown', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('DNS failure');
  };
  const realWarn = log.warn;
  const warnings = [];
  log.warn = (...args) => warnings.push(args);
  try {
    assert.equal(await fetchChangelogBlock('o/r', 'CHANGELOG.md', 'abc123'), null);
    assert.match(warnings[0].join(' '), /DNS failure/);
  } finally {
    globalThis.fetch = realFetch;
    log.warn = realWarn;
  }
});
