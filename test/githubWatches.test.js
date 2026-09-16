import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listGithubWatches,
  getGithubWatch,
  getGithubWatchByToken,
  createGithubWatch,
  updateGithubWatch,
  deleteGithubWatch,
  setGithubWatchEnabled,
  regenerateGithubWatchSecret,
  clearGuildGithubWatches,
} from '../src/db/githubWatches.js';

const G = '900000000000000050';
const G2 = '900000000000000051';
const CH = '100000000000000001';
const ROLE = '700000000000000099';

test('createGithubWatch generates a unique token + secret, round-trips via getGithubWatch', async () => {
  const id = await createGithubWatch(G, { repo: 'o/r', channelId: CH, events: ['push', 'release'] });
  const row = await getGithubWatch(G, id);
  assert.equal(row.repo, 'o/r');
  assert.equal(row.channel_id, CH);
  assert.equal(row.role_id, null); // no role given
  assert.deepEqual(row.events, ['push', 'release']);
  assert.equal(row.enabled, 1);
  assert.match(row.token, /^[\w-]{20,}$/);
  assert.match(row.secret, /^[0-9a-f]{64}$/);
});

test('a role can be set on create and changed (or cleared) on update', async () => {
  const id = await createGithubWatch(G, { repo: 'o/r', channelId: CH, roleId: ROLE, events: ['push'] });
  assert.equal((await getGithubWatch(G, id)).role_id, ROLE);

  await updateGithubWatch(G, id, { channelId: CH, roleId: '', events: ['push'] });
  assert.equal((await getGithubWatch(G, id)).role_id, null); // cleared
});

test('a changelog path can be set on create and changed (or cleared) on update', async () => {
  const id = await createGithubWatch(G, {
    repo: 'o/r',
    channelId: CH,
    changelogPath: 'newt-beta/CHANGELOG.md',
    events: ['push'],
  });
  assert.equal((await getGithubWatch(G, id)).changelog_path, 'newt-beta/CHANGELOG.md');

  await updateGithubWatch(G, id, { channelId: CH, changelogPath: '', events: ['push'] });
  assert.equal((await getGithubWatch(G, id)).changelog_path, null); // cleared
});

test('two watches never share a token', async () => {
  const id1 = await createGithubWatch(G, { repo: 'o/r1', channelId: CH, events: ['push'] });
  const id2 = await createGithubWatch(G, { repo: 'o/r2', channelId: CH, events: ['push'] });
  const w1 = await getGithubWatch(G, id1);
  const w2 = await getGithubWatch(G, id2);
  assert.notEqual(w1.token, w2.token);
});

test('getGithubWatchByToken finds the row a webhook POST would need to look up', async () => {
  const id = await createGithubWatch(G, { repo: 'o/lookup', channelId: CH, events: ['push'] });
  const { token } = await getGithubWatch(G, id);
  const row = await getGithubWatchByToken(token);
  assert.equal(row.repo, 'o/lookup');
  assert.equal(await getGithubWatchByToken('not-a-real-token'), null);
});

test('updateGithubWatch changes channel + events without touching token/secret', async () => {
  const id = await createGithubWatch(G, { repo: 'o/r', channelId: CH, events: ['push'] });
  const before = await getGithubWatch(G, id);
  await updateGithubWatch(G, id, { channelId: '100000000000000002', events: ['release', 'star'] });
  const after = await getGithubWatch(G, id);
  assert.equal(after.channel_id, '100000000000000002');
  assert.deepEqual(after.events, ['release', 'star']);
  assert.equal(after.token, before.token);
  assert.equal(after.secret, before.secret);
});

test('setGithubWatchEnabled toggles without affecting other rows', async () => {
  const id1 = await createGithubWatch(G, { repo: 'o/a', channelId: CH, events: ['push'] });
  const id2 = await createGithubWatch(G, { repo: 'o/b', channelId: CH, events: ['push'] });
  await setGithubWatchEnabled(G, id1, false);
  assert.equal((await getGithubWatch(G, id1)).enabled, 0);
  assert.equal((await getGithubWatch(G, id2)).enabled, 1);
});

test('regenerateGithubWatchSecret issues a new secret; the old one stops matching', async () => {
  const id = await createGithubWatch(G, { repo: 'o/r', channelId: CH, events: ['push'] });
  const before = await getGithubWatch(G, id);
  const newSecret = await regenerateGithubWatchSecret(G, id);
  const after = await getGithubWatch(G, id);
  assert.equal(after.secret, newSecret);
  assert.notEqual(after.secret, before.secret);
  assert.equal(after.token, before.token); // URL stays the same, only the secret rotates
});

test('deleteGithubWatch removes one row; a webhook POST for it then 404s (no row for its token)', async () => {
  const id = await createGithubWatch(G, { repo: 'o/r', channelId: CH, events: ['push'] });
  const { token } = await getGithubWatch(G, id);
  await deleteGithubWatch(G, id);
  assert.equal(await getGithubWatch(G, id), null);
  assert.equal(await getGithubWatchByToken(token), null);
});

test('listGithubWatches and clearGuildGithubWatches are guild-scoped', async () => {
  await clearGuildGithubWatches(G);
  await clearGuildGithubWatches(G2);
  await createGithubWatch(G, { repo: 'o/a', channelId: CH, events: ['push'] });
  await createGithubWatch(G, { repo: 'o/b', channelId: CH, events: ['push'] });
  await createGithubWatch(G2, { repo: 'o/c', channelId: CH, events: ['push'] });

  assert.equal((await listGithubWatches(G)).length, 2);
  assert.equal((await listGithubWatches(G2)).length, 1);

  await clearGuildGithubWatches(G);
  assert.equal((await listGithubWatches(G)).length, 0);
  assert.equal((await listGithubWatches(G2)).length, 1); // untouched
});

test('a row with corrupted events JSON hydrates to an empty list instead of throwing', async () => {
  const id = await createGithubWatch(G, { repo: 'o/r', channelId: CH, events: ['push'] });
  // Reach past the public API to simulate a corrupted column value.
  const { db } = await import('../src/db/index.js');
  db.prepare('UPDATE github_watches SET events = ? WHERE id = ?').run('not json', id);
  const row = await getGithubWatch(G, id);
  assert.deepEqual(row.events, []);
});
