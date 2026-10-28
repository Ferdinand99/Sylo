// Rate limits for roadmap votes and suggestions: one shared set of limiter instances, imported by
// the dashboard's API (routes/v2Api.js).
import { rateLimit } from '../middleware/rateLimit.js';
import { sessionUserId } from '../middleware/auth.js';

// One vote toggle per user is cheap and legitimate to click a lot; this only
// stops a stuck script. Suggestions are capped hard — a public submission
// form is the one part of this feature open to abuse.
export const voteLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  keyFn: (req) => `rmvote:${sessionUserId(req)}`,
  message: 'Too many votes — slow down.',
});
export const suggestLimit = rateLimit({
  windowMs: 86_400_000,
  max: 5,
  keyFn: (req) => `rmsuggest:${sessionUserId(req)}`,
  message: "You've hit today's suggestion limit — try again tomorrow.",
});
