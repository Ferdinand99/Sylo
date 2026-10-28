// The pages that work without signing in (the command list and the roadmap). The server serves
// the app for exactly these (src/web/routes/v2Client.js, PUBLIC_PAGES) and answers their data on
// /api/v2/public/*; every other page needs a session. Paths are as the router sees them, without
// the /v2 base.
export const PUBLIC_PATHS = ['/commands', '/roadmap'];

export function isPublicPath(pathname) {
  return PUBLIC_PATHS.includes(String(pathname).toLowerCase().replace(/\/+$/, ''));
}

/** The login link for a signed-out visitor: after signing in they come back to the page they are
 * on (`next` is an address on this site, /v2/roadmap). */
export function loginHref() {
  return `/auth/login?next=${encodeURIComponent(window.location.pathname)}`;
}
