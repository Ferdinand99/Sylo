// Authentication middleware.
//
// v1 has no auth — the dashboard is read-only and exposes no secrets. This
// module exists so admin-only routes can adopt real auth later without
// restructuring the routers: wrap a route with `requireAdmin` and implement
// the Discord OAuth2 flow here.
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
