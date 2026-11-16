// The look of a server's public pages as files: its style sheet (/look/<server>.<hash>.css) and the picture of
// its background (/look/<server>.<hash>.webp). Mounted in server.js BEFORE the session and CSRF middleware, with
// its own rate limit, like the collectible pictures: a request here never starts a session and the answer
// carries no cookie, so any cache may keep it.
//
// Both addresses are guild-scoped and named by a content hash. The style sheet is only served while the hash is
// the one of the server's current look (so an old address is a plain 404, never a stale look), and the picture
// is looked up in THIS server's own pictures by its hash, never by a path. Anything else gets the same plain 404
// with no detail. The files are immutable: a change is a new address.
//
// The style sheet holds custom properties only (lib/publicLook.js) and the picture is a WebP Sylo made, so the
// page's strict CSP stays as it is: styles and images from this site only.
import { Router } from 'express';
import { keyOfSlug } from '../../lib/publicLook.js';
import { readLookImage } from '../../db/publicLook.js';
import { cssFor } from '../lib/publicLook.js';

const URL_RE = /^\/look\/([a-z0-9-]{1,32})\.([0-9a-f]{16})\.(css|webp)$/;

const notFound = (res) =>
  res
    .status(404)
    .set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    .type('text/plain')
    .send('Not found');

const FILE_HEADERS = {
  'Cache-Control': 'public, max-age=31536000, immutable',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

const router = Router();

router.get('/:file', async (req, res, next) => {
  try {
    const match = URL_RE.exec(String(req.originalUrl).split('?')[0]);
    const key = match && keyOfSlug(match[1]);
    if (!key) return notFound(res);
    const [hash, kind] = [match[2], match[3]];
    if (kind === 'css') {
      const css = await cssFor(key, hash);
      if (css == null) return notFound(res);
      res.set({ ...FILE_HEADERS, 'Content-Type': 'text/css; charset=utf-8' });
      return res.send(css);
    }
    const image = await readLookImage(key, hash);
    if (!image) return notFound(res);
    res.set({
      ...FILE_HEADERS,
      'Content-Type': image.mime,
      'Content-Length': String(image.data.length),
    });
    return res.end(image.data);
  } catch (err) {
    return next(err);
  }
});

// Everything else under /look answers the same plain 404, not the dashboard's login redirect.
router.use((_req, res) => notFound(res));

export default router;
