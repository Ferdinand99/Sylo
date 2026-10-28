// The roadmap board lives in the new dashboard (/v2/roadmap, data from /api/v2/roadmap). What stays
// here: GET /roadmap/posts.json, public and unauthenticated, which the marketing site's nginx proxy
// forwards to for the sylobot.com roadmap embed, and a permanent redirect from the old page.
import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { publicPostJson } from '../lib/roadmapView.js';
import { listPublicPosts } from '../../db/roadmap.js';

const router = Router();

router.get(
  '/posts.json',
  asyncHandler(async (req, res) => {
    const posts = await listPublicPosts();
    res.json(posts.map(publicPostJson));
  })
);

router.get('/', (req, res) => {
  res.redirect(301, '/v2/roadmap');
});

export default router;
