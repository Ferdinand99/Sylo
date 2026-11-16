// JSON API for Server settings → Public pages: the server's own look on the pages its members open without the
// dashboard (the application form, the ban appeal, the event and quote pages, the web shop). An accent colour and
// a background, nothing else: the layout, the type, the components and the "Powered by Sylo" link stay Sylo's.
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set. Every route here needs the
// Edit level (src/web/lib/routeAccess.js), the reads too; writes have passed the CSRF check.
//
// The background picture goes through the collectible pictures' pipeline (lib/collectibleImage.js): at most 2 MB,
// the kind decided by the first bytes, the size read from the header before anything is decoded, at most two
// decodes at a time, and a new WebP is stored, so what was uploaded (and its metadata) is never kept. The
// choice 'discord-splash' uses a copy of the server's invite splash that Sylo downloads itself.
import { accessRouter } from '../middleware/access.js';
import { currentUser } from '../middleware/auth.js';
import { clientKey, rateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { recordAudit } from '../../db/audit.js';
import {
  BACKGROUND_MAX_SIDE,
  BACKGROUND_QUALITY,
  deleteLookImage,
  getLookImageMeta,
  getPublicLook,
  putLookImage,
  setPublicLook,
} from '../../db/publicLook.js';
import { ImageError, processImage, readUpload } from '../../lib/collectibleImage.js';
import { BACKGROUNDS, imageHashOf, normaliseAccent } from '../../lib/publicLook.js';
import { hasSplash, lookView, refreshSplash } from '../lib/publicLook.js';

const router = accessRouter('/guilds/:guildId', { mergeParams: true });

const actor = (req) => (currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`);
const fail = (res, message, status = 400) => res.status(status).json({ error: message });

const uploadLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: 'Too many uploads: wait a minute and try again.',
  keyFn: (req) => `look-image|${req.params?.guildId ?? ''}|${clientKey(req)}`,
});
const splashLimit = rateLimit({
  windowMs: 60_000,
  max: 6,
  message: 'Too many checks: wait a minute and try again.',
  keyFn: (req) => `look-splash|${req.params?.guildId ?? ''}|${clientKey(req)}`,
});

const send = async (res, req) => res.json(await lookView(req.guild, req.guild.id));

router.get(
  '/public-page-look',
  asyncHandler(async (req, res) => send(res, req))
);

router.post(
  '/public-page-look',
  asyncHandler(async (req, res) => {
    const guildId = req.guild.id;
    const accent = normaliseAccent(req.body?.accent);
    if (accent === null) return fail(res, 'The accent colour must look like #5865f2.');
    const background = String(req.body?.background ?? 'none');
    if (!BACKGROUNDS.includes(background))
      return fail(res, 'Choose no background, an upload or the invite background.');

    if (background === 'upload' && !(await getLookImageMeta(guildId, 'upload'))) {
      return fail(res, 'Upload a picture first, or choose another background.');
    }
    if (background === 'discord-splash') {
      if (!hasSplash(req.guild)) {
        return fail(
          res,
          'This server has no invite background. Set one in the server settings, or choose another.'
        );
      }
      const out = await refreshSplash(req.guild, { force: true });
      if (out.status === 'failed' || out.status === 'none') {
        return fail(
          res,
          out.message ?? 'The invite background could not be downloaded. Try again in a moment.',
          502
        );
      }
    }

    const before = await getPublicLook(guildId);
    await setPublicLook(guildId, { accent, background });
    await recordAudit(guildId, {
      actor: actor(req),
      action: 'settings:public-look',
      detail:
        before.accent === accent && before.background === background
          ? 'public page look saved'
          : `public page look: accent ${accent || 'Sylo default'}, background ${background}`,
    });
    return send(res, req);
  })
);

router.post(
  '/public-page-look/image',
  uploadLimit,
  asyncHandler(async (req, res) => {
    const guildId = req.guild.id;
    let picture;
    try {
      picture = await processImage(await readUpload(req), {
        owner: guildId,
        maxSide: BACKGROUND_MAX_SIDE,
        quality: BACKGROUND_QUALITY,
      });
    } catch (err) {
      if (err instanceof ImageError) return fail(res, err.message, err.status);
      throw err;
    }
    await putLookImage(guildId, 'upload', {
      hash: imageHashOf(picture.data),
      mime: picture.mime,
      data: picture.data,
    });
    await recordAudit(guildId, {
      actor: actor(req),
      action: 'settings:public-look',
      detail: 'uploaded a background picture for the public pages',
    });
    return send(res, req);
  })
);

router.post(
  '/public-page-look/image/delete',
  asyncHandler(async (req, res) => {
    const guildId = req.guild.id;
    const had = await deleteLookImage(guildId, 'upload');
    if (had) {
      const look = await getPublicLook(guildId);
      // A background that points at a picture that is gone is none.
      if (look.background === 'upload')
        await setPublicLook(guildId, { accent: look.accent, background: 'none' });
      await recordAudit(guildId, {
        actor: actor(req),
        action: 'settings:public-look',
        detail: 'removed the uploaded background picture',
      });
    }
    return send(res, req);
  })
);

// Check the invite background against the platform now (otherwise it is checked once a day, when a page that
// uses it is opened). A changed splash is downloaded again; one the server no longer has is dropped.
router.post(
  '/public-page-look/splash/refresh',
  splashLimit,
  asyncHandler(async (req, res) => {
    const out = await refreshSplash(req.guild, { force: true });
    if (out.status === 'none') {
      const look = await getPublicLook(req.guild.id);
      if (look.background === 'discord-splash') {
        await setPublicLook(req.guild.id, { accent: look.accent, background: 'none' });
      }
    }
    if (out.status === 'failed')
      return fail(res, out.message ?? 'The invite background could not be downloaded.', 502);
    return send(res, req);
  })
);

export default router;
