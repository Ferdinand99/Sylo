// The picture of a collectible, at /c/<id>.png. Mounted before requireAuth in server.js with its own rate limit.
//
// It needs no login: Discord and Fluxer fetch the picture themselves when a message or an embed shows it.
// What keeps it private is the id, 128 random bits that are only ever shown to the people who see the item.
// A picture is only served while an item or an owned inventory row still refers to it (db/economyShop.js
// guildOfImage), so a file that was left behind is not served.
//
// The address must have the exact shape /c/<32 lower-case hex characters>.png. Anything else, an unknown id,
// and a picture whose file is gone all get the same plain 404 with no detail. Nothing a request sends is ever
// part of a file path except an id that has passed that shape check (lib/collectibleFiles.js builds the path
// from the server's folder and the id, and nothing else).
//
// What is sent is a PNG made by Sylo (lib/collectibleImage.js), with headers that keep a browser from treating
// it as anything else and from running anything: nosniff, a CSP that allows nothing, and a sandbox. It may be
// kept for a year (the id changes when the picture does) and by any cache (it is public).
import { Router } from 'express';
import { guildOfImage } from '../../db/economyShop.js';
import { readImage } from '../../lib/collectibleFiles.js';

const FILE_RE = /^([0-9a-f]{32})\.png$/;

const notFound = (res) =>
  res
    .status(404)
    .set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    .type('text/plain')
    .send('Not found');

const router = Router();

router.get('/:file', async (req, res, next) => {
  try {
    const match = FILE_RE.exec(String(req.params.file));
    if (!match) return notFound(res);
    const id = match[1];
    const guildId = await guildOfImage(id);
    if (!guildId) return notFound(res);
    const bytes = await readImage(guildId, id);
    if (!bytes) return notFound(res);
    res.set({
      'Content-Type': 'image/png',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    return res.end(bytes);
  } catch (err) {
    return next(err);
  }
});

// Everything else under /c answers the same plain 404, not the dashboard's login redirect.
router.use((_req, res) => notFound(res));

export default router;
