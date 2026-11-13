// The picture of a collectible, at /c/<id>.webp. Mounted in server.js BEFORE the session and CSRF middleware,
// with its own rate limit, so a request here never starts a session and its answer carries no cookie (it is
// marked as cacheable by anyone).
//
// It needs no login: Discord and Fluxer fetch the picture themselves when a message or an embed shows it.
// What keeps it private is the id, 128 random bits that are only ever shown to the people who see the item.
// A picture exists only while an item or an owned inventory row refers to it (db/collectibleImages.js deletes
// it in the transaction that drops the last reference).
//
// The address must be exactly /c/<32 lower-case hex characters>.webp, checked against the URL as it was sent
// (so a different case in "/c", a trailing slash, an upper-case id or another extension are not matched). Any
// other address, an unknown id and a picture that is gone all get the same plain 404 with no detail. The id is
// a key into the database, never part of a path.
//
// What is sent is a WebP made by Sylo (lib/collectibleImage.js), with headers that keep a browser from treating
// it as anything else and from running anything: nosniff, a CSP that allows nothing, and a sandbox. It may be
// kept for a year (the id changes when the picture does) and by any cache (it is public).
import { Router } from 'express';
import { readImage } from '../../db/collectibleImages.js';

const URL_RE = /^\/c\/([0-9a-f]{32})\.webp$/;

const notFound = (res) =>
  res
    .status(404)
    .set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    .type('text/plain')
    .send('Not found');

const router = Router();

router.get('/:file', async (req, res, next) => {
  try {
    const match = URL_RE.exec(String(req.originalUrl).split('?')[0]);
    if (!match) return notFound(res);
    const image = await readImage(match[1]);
    if (!image) return notFound(res);
    res.set({
      'Content-Type': image.mime,
      'Content-Length': String(image.data.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    return res.end(image.data);
  } catch (err) {
    return next(err);
  }
});

// Everything else under /c answers the same plain 404, not the dashboard's login redirect.
router.use((_req, res) => notFound(res));

export default router;
