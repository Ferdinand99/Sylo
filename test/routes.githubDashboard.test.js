import { startWebApp, post } from './helpers/webApp.js';
import { GID, CH, ROLE } from './helpers/fakeGuild.js';
import { listGithubWatches } from '../src/db/githubWatches.js';
import test from 'node:test';
import assert from 'node:assert/strict';

let app;
test.before(async () => {
  app = await startWebApp();
});
test.after(() => app.close());

test('saving a watch with no events checked and no changelog path is rejected', async () => {
  const res = await post(app.base, `/guilds/${GID}/m/github/w/new`, {
    repo: 'o/r1',
    channelId: CH.general,
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /msg=gh-events/);
  assert.equal(
    (await listGithubWatches(GID)).some((w) => w.repo === 'o/r1'),
    false
  );
});

test('saving a watch with only a changelog path (no events checked) succeeds', async () => {
  const res = await post(app.base, `/guilds/${GID}/m/github/w/new`, {
    repo: 'o/r2',
    channelId: CH.general,
    changelogPath: 'CHANGELOG.md',
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /msg=saved/);

  const watch = (await listGithubWatches(GID)).find((w) => w.repo === 'o/r2');
  assert.ok(watch);
  assert.deepEqual(watch.events, []);
  assert.equal(watch.changelog_path, 'CHANGELOG.md');
});

test('saving a watch with only an event checked (no changelog path) still succeeds', async () => {
  const res = await post(app.base, `/guilds/${GID}/m/github/w/new`, {
    repo: 'o/r3',
    channelId: CH.general,
    events: 'release',
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /msg=saved/);

  const watch = (await listGithubWatches(GID)).find((w) => w.repo === 'o/r3');
  assert.ok(watch);
  assert.deepEqual(watch.events, ['release']);
  assert.equal(watch.changelog_path, null);
});

test('editing an existing watch down to zero events but keeping a changelog path still succeeds', async () => {
  const created = await post(app.base, `/guilds/${GID}/m/github/w/new`, {
    repo: 'o/r4',
    channelId: CH.general,
    roleId: ROLE.member,
    changelogPath: 'CHANGELOG.md',
    events: 'push',
  });
  const id = /\/w\/(\d+)\?/.exec(created.headers.get('location'))[1];

  const res = await post(app.base, `/guilds/${GID}/m/github/w/${id}`, {
    repo: 'o/r4',
    channelId: CH.general,
    roleId: ROLE.member,
    changelogPath: 'CHANGELOG.md',
    // no `events` field at all this time
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /msg=saved/);

  const watch = (await listGithubWatches(GID)).find((w) => String(w.id) === id);
  assert.deepEqual(watch.events, []);
  assert.equal(watch.changelog_path, 'CHANGELOG.md');
});
