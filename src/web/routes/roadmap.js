// Self-hosted roadmap + voting board — replaces the external Fider embed.
// GET /roadmap and GET /roadmap/posts.json are public (no login needed to
// browse); voting and suggesting need any signed-in Discord account;
// /roadmap/admin/* is restricted to OWNER_IDS, same as /health.
import { Router } from 'express';
import { requireAuth, requireOwner, isOwner } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { timeAgo } from '../lib/format.js';
import { mdToHtml } from '../lib/markdown.js';
import {
  ROADMAP_STATUSES,
  listPublicPosts,
  listPendingPosts,
  listUserPending,
  createPost,
  setPostStatus,
  updatePost,
  deletePost,
  toggleVote,
  getPost,
} from '../../db/roadmap.js';

const router = Router();

const COMPLETED_CAP = 6;
const TITLE_MAX = 100;
const DESC_MAX = 2000;

// One vote toggle per user is cheap and legitimate to click a lot; this only
// stops a stuck script. Suggestions are capped hard — a public submission
// form is the one part of this feature open to abuse.
const voteLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  keyFn: (req) => `rmvote:${req.session.user.id}`,
  message: 'Too many votes — slow down.',
});
const suggestLimit = rateLimit({
  windowMs: 86_400_000,
  max: 5,
  keyFn: (req) => `rmsuggest:${req.session.user.id}`,
  message: "You've hit today's suggestion limit — try again tomorrow.",
});

function groupPublicPosts(posts) {
  const byStatus = { planned: [], started: [], completed: [] };
  for (const p of posts) byStatus[p.status]?.push(p);
  byStatus.completed.sort((a, b) => b.createdAt - a.createdAt);
  byStatus.completed = byStatus.completed.slice(0, COMPLETED_CAP);
  byStatus.planned.sort((a, b) => a.createdAt - b.createdAt);
  byStatus.started.sort((a, b) => a.createdAt - b.createdAt);
  for (const list of Object.values(byStatus)) {
    for (const p of list) p.descriptionHtml = mdToHtml(p.description);
  }
  return byStatus;
}

// description stays the raw markdown source (e.g. for the admin edit form's
// textarea) — descriptionHtml is the rendered, safe-to-inject-unescaped copy.
const withHtml = (p) => ({ ...p, descriptionHtml: mdToHtml(p.description) });

function cleanTitle(raw) {
  const s = String(raw ?? '').trim();
  return s.length >= 3 && s.length <= TITLE_MAX ? s : null;
}
function cleanDescription(raw) {
  const s = String(raw ?? '').trim();
  return s.length >= 1 && s.length <= DESC_MAX ? s : null;
}

// requireAuth/requireOwner are no-ops in open mode (no DISCORD_CLIENT_SECRET,
// self-hosted default) — there's no real per-user Discord id to attribute a
// vote or suggestion to there, unlike every other guarded action in this
// router. Checked ahead of the rate limiters below too, since their keyFn
// also reads req.session.user.id.
function requireRealUser(req, res, next) {
  if (req.session?.user?.id) return next();
  res
    .status(400)
    .type('text/plain')
    .send('Voting and suggestions need a real Discord login — not available in open/self-hosted mode.');
}

// Public, unauthenticated — this is what the marketing site's nginx proxy
// forwards to for the sylobot.com roadmap embed.
router.get(
  '/posts.json',
  asyncHandler(async (req, res) => {
    const posts = await listPublicPosts();
    res.json(
      posts.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        status: p.status,
        votes: p.votes,
        createdAt: p.createdAt,
      }))
    );
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.session?.user?.id ?? null;
    const posts = await listPublicPosts(userId);
    const mine = userId ? await listUserPending(userId) : [];
    res.render('roadmap', {
      groups: groupPublicPosts(posts),
      mine: mine.map((p) => ({ ...withHtml(p), ago: timeAgo(p.createdAt) })),
      loggedIn: Boolean(userId),
      isOwner: userId ? isOwner(userId) : false,
      suggestErr: typeof req.query.suggesterr === 'string' ? req.query.suggesterr : null,
      suggestOk: req.query.suggested === '1',
    });
  })
);

router.post(
  '/:id/vote',
  requireAuth,
  requireRealUser,
  voteLimit,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const post = Number.isInteger(id) ? await getPost(id) : null;
    if (!post || post.status === 'pending') return res.status(404).end();
    const result = await toggleVote(id, req.session.user.id);
    res.json(result);
  })
);

router.post(
  '/suggest',
  requireAuth,
  requireRealUser,
  suggestLimit,
  asyncHandler(async (req, res) => {
    const title = cleanTitle(req.body.title);
    const description = cleanDescription(req.body.description);
    if (!title || !description) {
      return res.redirect(
        `/roadmap?suggesterr=${encodeURIComponent('Title (3-100 chars) and description are required.')}`
      );
    }
    await createPost({ title, description, userId: req.session.user.id, status: 'pending' });
    res.redirect('/roadmap?suggested=1');
  })
);

const admin = Router();
admin.use(requireOwner);

// Only the create route attributes authorship (created_by) — the rest
// (approve/reject/status/edit/delete) act on an existing post and need no
// user id, so they're unaffected by open mode.
admin.post('/', requireRealUser);

admin.get(
  '/',
  asyncHandler(async (req, res) => {
    const [pending, publicPosts] = await Promise.all([listPendingPosts(), listPublicPosts()]);
    res.render('roadmapAdmin', {
      statuses: ROADMAP_STATUSES.filter((s) => s !== 'pending'),
      pending: pending.map((p) => ({ ...withHtml(p), ago: timeAgo(p.createdAt) })),
      posts: publicPosts
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((p) => ({ ...withHtml(p), ago: timeAgo(p.createdAt) })),
      createErr: typeof req.query.createerr === 'string' ? req.query.createerr : null,
    });
  })
);

admin.post(
  '/',
  asyncHandler(async (req, res) => {
    const title = cleanTitle(req.body.title);
    const description = cleanDescription(req.body.description);
    if (!title || !description) {
      return res.redirect(
        `/roadmap/admin?createerr=${encodeURIComponent('Title (3-100 chars) and description are required.')}`
      );
    }
    await createPost({ title, description, userId: req.session.user.id, status: 'planned' });
    res.redirect('/roadmap/admin');
  })
);

admin.post(
  '/:id/approve',
  asyncHandler(async (req, res) => {
    await setPostStatus(Number(req.params.id), 'planned');
    res.redirect('/roadmap/admin');
  })
);

admin.post(
  '/:id/reject',
  asyncHandler(async (req, res) => {
    await deletePost(Number(req.params.id));
    res.redirect('/roadmap/admin');
  })
);

admin.post(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const status = String(req.body.status ?? '');
    if (ROADMAP_STATUSES.includes(status) && status !== 'pending') {
      await setPostStatus(Number(req.params.id), status);
    }
    res.redirect('/roadmap/admin');
  })
);

admin.post(
  '/:id/edit',
  asyncHandler(async (req, res) => {
    const title = cleanTitle(req.body.title);
    const description = cleanDescription(req.body.description);
    if (title && description) await updatePost(Number(req.params.id), { title, description });
    res.redirect('/roadmap/admin');
  })
);

admin.post(
  '/:id/delete',
  asyncHandler(async (req, res) => {
    await deletePost(Number(req.params.id));
    res.redirect('/roadmap/admin');
  })
);

router.use('/admin', admin);

export default router;
