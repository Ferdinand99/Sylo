// Owner-only modules (registry `ownerOnly`, e.g. App Store Connect): a request that targets one
// is refused unless the signed-in account is a Sylo operator (OWNER_IDS / FLUXER_OWNER_IDS). It
// matches any /m/<id>[/...] or /modules/<id>[/...] path, so a settings page, a config save, a
// toggle or a test message are all covered. A bulk toggle
// is filtered inside its handler. Hiding the module in menus is cosmetic; this is the check.
//
// Express matches routes case-insensitively and decodes %xx in route params, but `req.path` is
// raw. The path is therefore decoded and lower-cased before it is matched, so /M/apple-connect
// and /m/apple%2Dconnect are refused like /m/apple-connect.
import { getModule } from '../../modules/registry.js';
import { forbidOwner, isOwner } from './auth.js';

const MODULE_PATH = /^\/(?:m|modules)\/([^/]+)/;

/** @param {string} path */
function targetedModuleId(path) {
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null; // malformed escapes never reach a module route
  }
  return MODULE_PATH.exec(decoded.toLowerCase())?.[1] ?? null;
}

/** @type {import('express').RequestHandler} */
export function ownerOnlyModules(req, res, next) {
  const id = targetedModuleId(req.path);
  const def = id ? getModule(id) : null;
  if (!def?.ownerOnly || isOwner(req)) return next();
  if (req.baseUrl.startsWith('/api/')) {
    return res.status(403).json({ error: 'This module is restricted to the Sylo owner.' });
  }
  return forbidOwner(res);
}
