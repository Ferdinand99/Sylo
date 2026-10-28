// The pages that work without signing in (the command list and the roadmap). The server serves
// the app for exactly these (src/web/routes/v2Client.js, PUBLIC_PAGES) and answers their data on
// /api/v2/public/*; every other page needs a session. Paths are as the router sees them, without
// the /v2 base.
export const PUBLIC_PATHS = ['/commands', '/roadmap'];

export function isPublicPath(pathname) {
  return PUBLIC_PATHS.includes(String(pathname).toLowerCase().replace(/\/+$/, ''));
}
