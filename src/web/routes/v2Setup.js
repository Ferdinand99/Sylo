// JSON API for the setup wizard: the proposal for this server and applying the admin's choices.
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set, the caller manages
// this server and the state-changing call has passed the CSRF check (and the role-grant guard that
// remembers who is saving, for the module write path).
import { Router } from 'express';
import { currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { platformActionKey, rateLimit } from '../middleware/rateLimit.js';
import { applySetup, setupItemIds, suggestSetup } from '../lib/setupWizard.js';

const router = Router({ mergeParams: true });

const actor = (req) => (currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`);

// Applying can create channels and roles on the platform, so it has its own small budget: one count per
// server and person, a few runs in ten minutes (a second run after a fix is normal, a script is not).
const applyLimit = rateLimit({
  windowMs: 10 * 60_000,
  max: 6,
  message: 'The setup wizard ran several times just now. Wait a few minutes and try again.',
  keyFn: (req) => `setup|${platformActionKey(req)}`,
});

// One apply at a time per server, so a double click cannot create a channel twice.
const running = new Set();

/** The same read the page shows: channels and roles found by name, and what "Create" would make. */
router.get(
  '/setup/suggest',
  asyncHandler(async (req, res) => {
    res.json(await suggestSetup(req.guild));
  })
);

const ID = /^\d{17,20}$/;

/** The choices as the page sends them, cut down to what apply understands. Null when the body is not usable. */
function readSelections(body) {
  if (!Array.isArray(body?.items) || body.items.length === 0 || body.items.length > 20) return null;
  const known = new Set(setupItemIds());
  const seen = new Set();
  const out = [];
  for (const raw of body.items) {
    const id = String(raw?.id ?? '');
    if (!known.has(id) || seen.has(id)) return null;
    seen.add(id);
    const fields = {};
    for (const [key, pick] of Object.entries(raw?.fields ?? {})) {
      if (key.length > 40) return null;
      fields[key] = {
        ...(typeof pick?.id === 'string' && ID.test(pick.id) ? { id: pick.id } : {}),
        // Only an explicit true creates anything.
        ...(pick?.create === true ? { create: true } : {}),
      };
    }
    out.push({ id, replace: raw?.replace === true, fields });
  }
  return out;
}

/**
 * Apply the ticked items, one at a time, and answer with the result per item. A failed item does not stop
 * the others. Each item that is saved writes its own audit entry.
 */
router.post(
  '/setup/apply',
  applyLimit,
  asyncHandler(async (req, res) => {
    const selections = readSelections(req.body);
    if (!selections) return res.status(400).json({ error: 'Choose what to set up first.' });
    if (running.has(req.guild.id)) {
      return res.status(409).json({ error: 'The setup is already running for this server.' });
    }
    running.add(req.guild.id);
    try {
      const results = await applySetup({ guild: req.guild, selections, actor: actor(req) });
      res.json({ results });
    } finally {
      running.delete(req.guild.id);
    }
  })
);

export default router;
