import express, { Router } from 'express';
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { getGuild, baseContext } from '../lib/guildContext.js';
import { requireGuildAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { getBotMasterRoles } from '../../db/guildSettings.js';
import { config } from '../../config.js';
import {
  listSounds,
  uploadSound,
  deleteSound,
  playSound,
  joinSoundboard,
  stopSound,
  soundboardStatus,
  SoundboardError,
  MAX_UPLOAD_BYTES,
} from '../../modules/soundboard.js';

const router = Router({ mergeParams: true });
router.use((req, res, next) => {
  req.guild = getGuild(req);
  if (!req.guild) return res.status(404).json({ error: 'Nie znaleziono serwera.' });
  next();
});
router.use(requireGuildAdmin);
// Voice playback and file operations require current permissions, not an old OAuth snapshot.
router.use(
  asyncHandler(async (req, res, next) => {
    if (!config.authEnabled) return next();
    const member = await req.guild.members
      .fetch({ user: req.session.user.id, force: true })
      .catch(() => null);
    const roles = await getBotMasterRoles(req.guild.id);
    if (
      !member ||
      !(member.permissions.has(PermissionFlagsBits.ManageGuild) || member.roles.cache.hasAny(...roles))
    )
      return res.status(403).json({ error: 'Nie masz aktualnych uprawnień do zarządzania tym serwerem.' });
    next();
  })
);
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.render('guild-soundboard', {
      ...(await baseContext(req.guild, 'soundboard')),
      voiceChannels: [...req.guild.channels.cache.values()]
        .filter((channel) => channel.type === ChannelType.GuildVoice)
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .map((channel) => ({ id: channel.id, name: channel.name })),
      clips: await listSounds(req.guild.id),
    });
  })
);
router.get('/status', (req, res) => res.json(soundboardStatus(req.guild.id)));
let uploading = false;
router.post(
  '/upload',
  rateLimit({ windowMs: 60000, max: 6 }),
  (req, res, next) => {
    if (uploading)
      return res.status(409).json({ error: 'Trwa przesyłanie innego klipu. Spróbuj za chwilę.' });
    uploading = true;
    const release = () => {
      uploading = false;
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  },
  express.raw({ type: 'application/octet-stream', limit: MAX_UPLOAD_BYTES }),
  asyncHandler(async (req, res) => {
    const clip = await uploadSound(req.guild.id, req.query.name, req.query.filename, req.body);
    res.status(201).json({ clip });
  })
);
router.post(
  '/:id/play',
  asyncHandler(async (req, res) => {
    if (!/^\d{17,20}$/.test(req.body.channelId || '')) throw new SoundboardError('Wybierz kanał głosowy.');
    await playSound(req.guild, req.params.id, req.body.channelId, undefined, req.body.keepConnected === true);
    res.json({ ok: true, connected: soundboardStatus(req.guild.id).connected === true });
  })
);
router.post(
  '/join',
  asyncHandler(async (req, res) => {
    if (!/^\d{17,20}$/.test(req.body.channelId || '')) throw new SoundboardError('Wybierz kanał głosowy.');
    await joinSoundboard(req.guild, req.body.channelId);
    res.json({ ok: true });
  })
);
router.post('/stop', (req, res) => {
  stopSound(req.guild.id);
  res.json({ ok: true });
});
router.post(
  '/:id/delete',
  asyncHandler(async (req, res) => {
    await deleteSound(req.guild.id, req.params.id);
    res.json({ ok: true });
  })
);
router.use((error, req, res, next) => {
  if (error instanceof SoundboardError) return res.status(error.status).json({ error: error.message });
  if (error.type === 'entity.too.large')
    return res.status(413).json({ error: 'Plik jest za duży. Limit wynosi 8 MB.' });
  next(error);
});
export default router;
