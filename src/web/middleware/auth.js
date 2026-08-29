// Authentication middleware.
//
// There is no auth yet. The dashboard can now change guild settings (mod-log
// channel) and view ban/warning lists, so it MUST NOT be exposed beyond
// localhost or a trusted LAN until this is implemented. `requireAdmin` is
// already applied to the mutating routes so a real check only needs filling in
// here.
//
// Planned flow:
//   1. GET /auth/login  -> redirect to Discord OAuth2 (scope: identify, guilds)
//   2. GET /auth/callback -> exchange code, verify the user is a guild admin,
//      set a signed session cookie
//   3. requireAdmin -> 302 to /auth/login when the session is missing/invalid

/** @type {import('express').RequestHandler} */
export function requireAdmin(req, res, next) {
  // No-op until OAuth2 is implemented.
  next();
}
