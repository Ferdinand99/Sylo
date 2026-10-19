// GET /api/v2/changelog: Sylo's CHANGELOG.md as JSON for the Sylo app, parsed the same way as
// the V2 "What's new" page (src/lib/changelog.js). Not tied to a server: anyone signed in, on
// the web or with an app token, may read it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import express from 'express';
import { browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';
import { changelogHandler } from '../src/web/lib/changelogFeed.js';

await startOAuthApp();

const { findIdentity } = await import('../src/db/accounts.js');
const { createApiToken } = await import('../src/db/apiTokens.js');
const { version } = createRequire(import.meta.url)('../package.json');

/** A fresh person signed in on the web; returns their browser and an app token. */
async function person() {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const { accountId } = await findIdentity('discord', profiles.discord.id);
  const { token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 });
  return { b, token };
}

const withToken = (token, path = '/api/v2/changelog') =>
  browser().get(path, { headers: { authorization: `Bearer ${token}` } });

test('GET /api/v2/changelog serves the real CHANGELOG.md in the API shape', async () => {
  const { b } = await person();
  const res = await b.get('/api/v2/changelog');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, max-age=300');
  const body = await res.json();
  assert.equal(body.version, version);
  assert.ok(body.releases.length > 50);
  const [latest] = body.releases;
  assert.match(latest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(latest).sort(), ['date', 'sections', 'url', 'version']);
  assert.ok(latest.date === null || /^\d{4}-\d{2}-\d{2}$/.test(latest.date));
  assert.ok(latest.url === null || latest.url.startsWith('https://'));
  for (const release of body.releases) {
    for (const section of release.sections) {
      assert.equal(typeof section.title, 'string');
      assert.ok(['features', 'fixes', 'performance', 'breaking', 'other'].includes(section.kind));
      for (const item of section.items) {
        assert.deepEqual(Object.keys(item).sort(), ['refs', 'scope', 'text']);
        assert.ok(item.text.length > 0);
        assert.ok(item.scope === null || typeof item.scope === 'string');
        assert.ok(item.refs.every((r) => /^#\d+$/.test(r.label) && r.url.startsWith('https://')));
      }
    }
  }
  const features = body.releases.flatMap((r) => r.sections).find((s) => s.kind === 'features');
  assert.equal(features.title, 'New', 'the words the V2 page uses');
});

test('GET /api/v2/changelog works with an app token', async () => {
  const { token } = await person();
  const res = await withToken(token);
  assert.equal(res.status, 200);
  assert.ok((await res.json()).releases.length > 0);
});

test('GET /api/v2/changelog is refused without a sign-in', async () => {
  const res = await browser().get('/api/v2/changelog', { headers: { accept: 'application/json' } });
  assert.equal(res.status, 401);
  assert.equal((await withToken('sylo_not-a-real-token')).status, 401, 'nor with a bad token');
});

test('GET /api/v2/changelog?limit=N keeps the newest N releases', async () => {
  const { token } = await person();
  const all = (await (await withToken(token)).json()).releases;
  const two = (await (await withToken(token, '/api/v2/changelog?limit=2')).json()).releases;
  assert.deepEqual(
    two.map((r) => r.version),
    all.slice(0, 2).map((r) => r.version)
  );
  const junk = (await (await withToken(token, '/api/v2/changelog?limit=abc')).json()).releases;
  assert.equal(junk.length, all.length, 'a limit that is not a number means all');
});

// --- the handler on its own, with a changelog it is handed --------------------------------

/** Serve the handler from a tiny app and GET it; `readFile` stands in for the disk. */
async function serve(options, query = '') {
  const app = express();
  app.get('/changelog', changelogHandler(options));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/changelog${query}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

const manyReleases = (n) =>
  Array.from({ length: n }, (_, i) => `## ${n - i}.0.0 (2026-01-01)\n\n### Features\n\n* thing ${i}\n`).join(
    '\n'
  );

test('limit is capped at 200 releases', async () => {
  const readFile = async () => manyReleases(250);
  assert.equal((await serve({ readFile }, '?limit=1000')).body.releases.length, 200);
  assert.equal((await serve({ readFile })).body.releases.length, 250, 'no limit: every release');
  assert.equal((await serve({ readFile }, '?limit=3')).body.releases.length, 3);
});

test('a missing CHANGELOG.md gives an empty list, never a 500', async () => {
  const { status, body } = await serve({ path: new URL('./no-such-changelog.md', import.meta.url) });
  assert.equal(status, 200);
  assert.deepEqual(body, { version, releases: [] });
});

test('CHANGELOG.md is read once and kept in memory', async () => {
  let reads = 0;
  const handler = changelogHandler({
    readFile: async () => {
      reads += 1;
      return manyReleases(2);
    },
  });
  const app = express();
  app.get('/changelog', handler);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/changelog`;
    assert.equal(reads, 0, 'not read until someone asks');
    await Promise.all([fetch(url), fetch(url)]);
    await fetch(url);
    assert.equal(reads, 1);
  } finally {
    server.close();
  }
});
