// Proves the driver shim's Postgres branch for roadmap_posts/roadmap_votes
// (surrogate `id` PK via RETURNING id, plus a GROUP BY vote-count join) —
// same assertions as roadmap.test.js, real Postgres connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'roadmap against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { createPost, listPublicPosts, listPendingPosts, setPostStatus, toggleVote, deletePost, getPost } =
      await import('../src/db/roadmap.js');

    t.after(async () => {
      await closePostgres();
    });

    // A real Postgres instance here may be persistent (not CI's per-run
    // ephemeral container), so scope every assertion to ids this run itself
    // created — never assume the table starts empty or ends with an exact count.
    const stamp = Date.now();
    const USER_A = `pgtest-roadmap-a-${stamp}`;
    const USER_B = `pgtest-roadmap-b-${stamp}`;

    await t.test('createPost defaults to pending, hidden from the public list', async () => {
      const post = await createPost({ title: `PG dark mode ${stamp}`, description: 'desc', userId: USER_A });
      assert.equal(post.status, 'pending');
      assert.equal(
        (await listPublicPosts()).some((p) => p.id === post.id),
        false
      );
      assert.equal(
        (await listPendingPosts()).some((p) => p.id === post.id),
        true
      );
    });

    await t.test('setPostStatus approves into the public list; toggleVote adds/removes', async () => {
      const post = await createPost({ title: `PG vote me ${stamp}`, description: 'desc', userId: USER_A });
      await setPostStatus(post.id, 'planned');

      const first = await toggleVote(post.id, USER_A);
      assert.deepEqual(first, { voted: true, votes: 1 });
      const second = await toggleVote(post.id, USER_B);
      assert.deepEqual(second, { voted: true, votes: 2 });

      const mine = (await listPublicPosts(USER_A)).find((p) => p.id === post.id);
      assert.equal(mine.voted, true);
      assert.equal(mine.votes, 2);
      assert.equal(typeof mine.votes, 'number'); // COUNT(*) coercion, not the raw bigint string

      const third = await toggleVote(post.id, USER_A);
      assert.deepEqual(third, { voted: false, votes: 1 });

      await deletePost(post.id);
      assert.equal(await getPost(post.id), null);
    });
  }
);
