// What the roadmap shows a visitor, shared by the classic board (routes/roadmap.js) and the new
// dashboard's API (routes/v2Api.js, routes/v2Public.js) so the two cannot drift. Posts are
// whitelisted field by field: the database row also holds who created a post, and that must
// never reach a page or a JSON answer.
import { config } from '../../config.js';
import { groupPublicPosts, listPublicPosts, listUserPending } from '../../db/roadmap.js';
import { timeAgo } from './format.js';
import { mdToHtml } from './markdown.js';

/** A public post as /roadmap/posts.json (the marketing site's embed) lists it. */
export function publicPostJson(p) {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    status: p.status,
    votes: p.votes,
    createdAt: p.createdAt,
  };
}

// description stays the raw markdown source; descriptionHtml is the rendered, safe-to-inject copy.
const viewPost = (p) => ({
  ...publicPostJson(p),
  descriptionHtml: mdToHtml(p.description),
  voted: Boolean(p.voted),
});

/**
 * The public board for one visitor. `userId` is null for someone who is not signed in (then
 * `voted` is false everywhere and `mine` is empty); `owner` only shows the "Manage board" link.
 * @param {{ userId: string|null, owner?: boolean }} viewer
 */
export async function roadmapView({ userId, owner = false }) {
  const posts = await listPublicPosts(userId);
  const groups = groupPublicPosts(posts);
  for (const [status, list] of Object.entries(groups)) groups[status] = list.map(viewPost);
  const pending = userId ? await listUserPending(userId) : [];
  return {
    groups,
    mine: pending.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      descriptionHtml: mdToHtml(p.description),
      ago: timeAgo(p.createdAt),
    })),
    isOwner: Boolean(userId) && owner,
    // Voting and suggesting need a real login; without one the page offers to log in (or, in
    // open mode, where no login exists, says so).
    signedIn: Boolean(userId),
    open: !config.authEnabled,
  };
}
