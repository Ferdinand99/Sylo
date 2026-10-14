// Owner-only modules (registry `ownerOnly`, e.g. App Store Connect): a request that targets one
// is refused unless the signed-in account is a Sylo operator (OWNER_IDS / FLUXER_OWNER_IDS). It
// matches any /m/<id>[/...] or /modules/<id>[/...] path, so a settings page, a config save, a
// toggle or a test message are all covered, in the classic and the V2 dashboard. A bulk toggle
// is filtered inside its handler. Hiding the module in menus is cosmetic; this is the check.
import { getModule } from '../../modules/registry.js';
import { forbidOwner, isOwner } from './auth.js';

const MODULE_PATH = /^\/(?:m|modules)\/([a-z0-9-]+)(?:\/|$)/;

/** @type {import('express').RequestHandler} */
export function ownerOnlyModules(req, res, next) {
  const id = MODULE_PATH.exec(req.path)?.[1];
  const def = id ? getModule(id) : null;
  if (!def?.ownerOnly || isOwner(req)) return next();
  if (req.baseUrl.startsWith('/api/')) {
    return res.status(403).json({ error: 'This module is restricted to the Sylo owner.' });
  }
  return forbidOwner(res);
}
