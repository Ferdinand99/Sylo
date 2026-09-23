import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPost,
  listPublicPosts,
  listPendingPosts,
  listUserPending,
  setPostStatus,
  updatePost,
  deletePost,
  toggleVote,
  getPost,
} from '../src/db/roadmap.js';

const USER_A = '900000000000000010';
const USER_B = '900000000000000011';

test('createPost defaults to pending, hidden from the public list', async () => {
  const post = await createPost({ title: 'Dark mode', description: 'Please add it', userId: USER_A });
  assert.equal(post.status, 'pending');
  assert.deepEqual((await listPublicPosts()).map((p) => p.id).includes(post.id), false);
  assert.equal((await listPendingPosts()).some((p) => p.id === post.id), true);
  assert.equal((await listUserPending(USER_A)).some((p) => p.id === post.id), true);
  assert.equal((await listUserPending(USER_B)).some((p) => p.id === post.id), false);
});

test('setPostStatus approves a post into the public list, rejects a bogus status', async () => {
  const post = await createPost({ title: 'Slash command X', description: 'desc', userId: USER_A });
  await setPostStatus(post.id, 'planned');
  const [pub] = (await listPublicPosts()).filter((p) => p.id === post.id);
  assert.equal(pub.status, 'planned');
  assert.equal(pub.votes, 0);
  assert.equal((await listPendingPosts()).some((p) => p.id === post.id), false);

  const unchanged = await setPostStatus(post.id, 'bogus');
  assert.equal(unchanged, null);
  assert.equal((await getPost(post.id)).status, 'planned');
});

test('toggleVote adds/removes a vote and reports voted-by-user state', async () => {
  const post = await createPost({ title: 'Vote me', description: 'desc', userId: USER_A, status: 'planned' });

  const first = await toggleVote(post.id, USER_A);
  assert.deepEqual(first, { voted: true, votes: 1 });

  const second = await toggleVote(post.id, USER_B);
  assert.deepEqual(second, { voted: true, votes: 2 });

  const mine = (await listPublicPosts(USER_A)).find((p) => p.id === post.id);
  assert.equal(mine.voted, true);
  assert.equal(mine.votes, 2);

  const third = await toggleVote(post.id, USER_A);
  assert.deepEqual(third, { voted: false, votes: 1 });
});

test('updatePost edits text; deletePost removes the post and its votes', async () => {
  const post = await createPost({ title: 'Old title', description: 'old', userId: USER_A, status: 'started' });
  await toggleVote(post.id, USER_A);

  const edited = await updatePost(post.id, { title: 'New title', description: 'new' });
  assert.equal(edited.title, 'New title');
  assert.equal(edited.description, 'new');

  await deletePost(post.id);
  assert.equal(await getPost(post.id), null);
  assert.equal((await listPublicPosts()).some((p) => p.id === post.id), false);

  // Voting again after delete should not resurrect stale vote rows / throw.
  const revived = await createPost({ title: 'Old title', description: 'old', userId: USER_A, status: 'started' });
  const vote = await toggleVote(revived.id, USER_A);
  assert.deepEqual(vote, { voted: true, votes: 1 });
});
