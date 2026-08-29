// Message Creator: compose and send messages/embeds as the bot, or edit one it
// already sent. The editor UI serialises everything into a single `spec` JSON
// field which buildPayload() sanitises server-side.
import { Router } from 'express';
import { runtime } from '../../runtime.js';
import { getGuild, baseContext, assignableRoles } from '../lib/guildContext.js';
import { requireGuildAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { guildTextChannels } from '../lib/discord.js';
import { timeAgo } from '../lib/format.js';
import { listComposed, getComposed, createComposed, updateComposed, deleteComposed } from '../../db/composedMessages.js';
import { sendComposed, editComposed } from '../../modules/messageCreator.js';

const router = Router({ mergeParams: true });

router.use((req, res, next) => {
  req.guild = getGuild(req);
  if (!req.guild) return res.status(404).render('guild-missing', { guildId: req.params.guildId });
  next();
});
router.use(requireGuildAdmin);

function editorContext(req, extra = {}) {
  return {
    ...baseContext(req.guild, 'messages'),
    channels: guildTextChannels(req.guild),
    roles: assignableRoles(req.guild),
    recent: listComposed(req.guild.id, 40).map((c) => ({
      id: c.id,
      channel: guildTextChannels(req.guild).find((ch) => ch.id === c.channel_id)?.name ?? c.channel_id,
      messageId: c.message_id,
      when: timeAgo(c.updated_at),
      title: c.spec?.embeds?.[0]?.title || c.spec?.content?.slice(0, 60) || '(no text)',
    })),
    msg: typeof req.query.msg === 'string' ? req.query.msg : null,
    ...extra,
  };
}

// New message composer.
router.get('/', (req, res) => {
  res.render('guild-messages', editorContext(req, { editing: null, spec: {} }));
});

// Edit an existing composed message.
router.get('/:id', (req, res) => {
  const rec = getComposed(req.guild.id, Number(req.params.id));
  if (!rec) return res.redirect(`/guilds/${req.guild.id}/messages`);
  res.render('guild-messages', editorContext(req, { editing: rec, spec: rec.spec }));
});

function parseSpec(body) {
  try {
    const s = JSON.parse(body.spec ?? '{}');
    return s && typeof s === 'object' ? s : {};
  } catch {
    return null;
  }
}

// Send a new message.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const spec = parseSpec(req.body);
    const channelId = String(req.body.channelId ?? '');
    if (!spec || !/^\d{17,20}$/.test(channelId)) {
      return res.redirect(`/guilds/${req.guild.id}/messages?msg=bad`);
    }
    try {
      const message = await sendComposed(req.guild, channelId, spec);
      createComposed(req.guild.id, { channelId, messageId: message.id, spec });
      res.redirect(`/guilds/${req.guild.id}/messages?msg=sent`);
    } catch (err) {
      res.redirect(`/guilds/${req.guild.id}/messages?msg=${encodeURIComponent(err.message).slice(0, 120)}`);
    }
  })
);

// Re-send / update an existing message.
router.post(
  '/:id',
  asyncHandler(async (req, res) => {
    const rec = getComposed(req.guild.id, Number(req.params.id));
    if (!rec) return res.redirect(`/guilds/${req.guild.id}/messages`);
    const spec = parseSpec(req.body);
    const channelId = String(req.body.channelId ?? rec.channel_id);
    if (!spec) return res.redirect(`/guilds/${req.guild.id}/messages/${rec.id}?msg=bad`);

    try {
      if (rec.message_id && channelId === rec.channel_id) {
        await editComposed(req.guild, channelId, rec.message_id, spec);
        updateComposed(req.guild.id, rec.id, { channelId, messageId: rec.message_id, spec });
        res.redirect(`/guilds/${req.guild.id}/messages/${rec.id}?msg=updated`);
      } else {
        // Different channel or no stored message → send a fresh one.
        const message = await sendComposed(req.guild, channelId, spec);
        updateComposed(req.guild.id, rec.id, { channelId, messageId: message.id, spec });
        res.redirect(`/guilds/${req.guild.id}/messages/${rec.id}?msg=sent`);
      }
    } catch (err) {
      res.redirect(`/guilds/${req.guild.id}/messages/${rec.id}?msg=${encodeURIComponent(err.message).slice(0, 120)}`);
    }
  })
);

router.post(
  '/:id/delete',
  asyncHandler(async (req, res) => {
    const rec = getComposed(req.guild.id, Number(req.params.id));
    let msg = 'removed';
    if (rec) {
      if (rec.message_id) {
        try {
          const ch =
            req.guild.channels.cache.get(rec.channel_id) ??
            (await req.guild.channels.fetch(rec.channel_id));
          await ch.messages.delete(rec.message_id);
          msg = 'deleted';
        } catch {
          msg = 'removed'; // message already gone / no permission — still drop the record
        }
      }
      deleteComposed(req.guild.id, rec.id);
    }
    res.redirect(`/guilds/${req.guild.id}/messages?msg=${msg}`);
  })
);

export default router;
