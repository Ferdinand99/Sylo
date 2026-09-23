// Self-hosted roadmap + voting board — replaces the external Fider embed.
// Not guild-scoped: one shared board for the whole hosted instance. A post
// starts 'pending' (member-submitted, awaiting an owner's review) and either
// becomes publicly visible/votable (planned/started/completed) or is deleted.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS roadmap_posts (
    id          SERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_by  TEXT NOT NULL,
    created_at  BIGINT NOT NULL,
    updated_at  BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_roadmap_posts_status ON roadmap_posts (status, created_at);

  CREATE TABLE IF NOT EXISTS roadmap_votes (
    post_id    INTEGER NOT NULL,
    user_id    TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (post_id, user_id)
  );
`);

export const ROADMAP_STATUSES = ['pending', 'planned', 'started', 'completed'];
export const PUBLIC_STATUSES = ['planned', 'started', 'completed'];

const stmts = {
  insertPost: prepare(
    'INSERT INTO roadmap_posts (title, description, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    { returningId: true }
  ),
  getPost: prepare('SELECT * FROM roadmap_posts WHERE id = ?'),
  publicPosts: prepare(`
    SELECT p.*, COUNT(v.user_id) AS votes
    FROM roadmap_posts p
    LEFT JOIN roadmap_votes v ON v.post_id = p.id
    WHERE p.status != 'pending'
    GROUP BY p.id, p.title, p.description, p.status, p.created_by, p.created_at, p.updated_at
    ORDER BY p.created_at ASC
  `),
  pendingPosts: prepare("SELECT * FROM roadmap_posts WHERE status = 'pending' ORDER BY created_at ASC"),
  userPendingPosts: prepare(
    "SELECT * FROM roadmap_posts WHERE status = 'pending' AND created_by = ? ORDER BY created_at ASC"
  ),
  setStatus: prepare('UPDATE roadmap_posts SET status = ?, updated_at = ? WHERE id = ?'),
  updateText: prepare('UPDATE roadmap_posts SET title = ?, description = ?, updated_at = ? WHERE id = ?'),
  deletePost: prepare('DELETE FROM roadmap_posts WHERE id = ?'),
  deleteVotesForPost: prepare('DELETE FROM roadmap_votes WHERE post_id = ?'),
  votedPostIds: prepare('SELECT post_id FROM roadmap_votes WHERE user_id = ?'),
  hasVoted: prepare('SELECT 1 FROM roadmap_votes WHERE post_id = ? AND user_id = ?'),
  addVote: prepare('INSERT INTO roadmap_votes (post_id, user_id, created_at) VALUES (?, ?, ?)'),
  removeVote: prepare('DELETE FROM roadmap_votes WHERE post_id = ? AND user_id = ?'),
};

function toPost(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function getPost(id) {
  const row = await stmts.getPost.get(id);
  return row ? toPost(row) : null;
}

/**
 * Every publicly-visible (non-pending) post, with its vote count and,
 * when `userId` is given, whether that user has voted on it.
 */
export async function listPublicPosts(userId) {
  const rows = await stmts.publicPosts.all();
  const voted = userId ? new Set((await stmts.votedPostIds.all(userId)).map((r) => r.post_id)) : null;
  // COUNT(*) comes back as a string from postgres.js, a number from better-sqlite3.
  return rows.map((r) => ({ ...toPost(r), votes: Number(r.votes), voted: voted ? voted.has(r.id) : false }));
}

export async function listPendingPosts() {
  return (await stmts.pendingPosts.all()).map(toPost);
}

export async function listUserPending(userId) {
  return (await stmts.userPendingPosts.all(userId)).map(toPost);
}

/**
 * @param {{title: string, description: string, userId: string, status?: string}} data
 * `status` defaults to 'pending' (a member suggestion); pass 'planned' for an
 * admin-authored post that skips the review queue.
 */
export async function createPost({ title, description, userId, status = 'pending' }) {
  const now = Date.now();
  const { lastInsertRowid } = await stmts.insertPost.run(title, description, status, userId, now, now);
  return getPost(lastInsertRowid);
}

export async function setPostStatus(id, status) {
  if (!ROADMAP_STATUSES.includes(status)) return null;
  await stmts.setStatus.run(status, Date.now(), id);
  return getPost(id);
}

export async function updatePost(id, { title, description }) {
  await stmts.updateText.run(title, description, Date.now(), id);
  return getPost(id);
}

export async function deletePost(id) {
  await stmts.deleteVotesForPost.run(id);
  await stmts.deletePost.run(id);
}

/** Toggle the caller's vote. Returns `{ voted, votes }` for the post after the change. */
export async function toggleVote(postId, userId) {
  const pid = Number(postId);
  const already = await stmts.hasVoted.get(pid, userId);
  if (already) {
    await stmts.removeVote.run(pid, userId);
  } else {
    await stmts.addVote.run(pid, userId, Date.now());
  }
  const rows = await stmts.publicPosts.all();
  const row = rows.find((r) => r.id === pid);
  return { voted: !already, votes: row ? Number(row.votes) : 0 };
}
