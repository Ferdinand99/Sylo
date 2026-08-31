// Embed messages: MEE6-style list of named, saved embed compositions you build
// with a WYSIWYG editor, then Save as a draft or Publish (post / re-post) to a
// channel. Everything serialises into a single `spec` JSON that buildPayload()
// sanitises server-side.
import { Router } from 'express';
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

const isId = (v) => /^\d{17,20}$/.test(v ?? '');
const specTitle = (spec) => spec?.embeds?.[0]?.title || spec?.content?.slice(0, 60) || '(no text)';

function parseSpec(body) {
  try {
    const s = JSON.parse(body.spec ?? '{}');
    if (!s || typeof s !== 'object') return null;
    return { content: String(s.content ?? ''), embeds: Array.isArray(s.embeds) ? s.embeds : [], rows: Array.isArray(s.rows) ? s.rows : [] };
  } catch {
    return null;
  }
}

// --- list ----------------------------------------------------------------

router.get('/', (req, res) => {
  const chName = (id) => guildTextChannels(req.guild).find((c) => c.id === id)?.name ?? id;
  res.render('guild-messages', {
    ...baseContext(req.guild, 'messages'),
    items: listComposed(req.guild.id, 200).map((c) => ({
      id: c.id,
      name: c.name || specTitle(c.spec),
      channel: chName(c.channel_id),
      published: Boolean(c.message_id),
      when: timeAgo(c.updated_at),
    })),
    msg: typeof req.query.msg === 'string' ? req.query.msg : null,
  });
});

// --- builder -----------------------------------------------------------

function renderBuilder(req, res, rec) {
  res.render('msg-builder', {
    ...baseContext(req.guild, 'messages'),
    channels: guildTextChannels(req.guild),
    roles: assignableRoles(req.guild),
    guildId: req.guild.id,
    isNew: !rec,
    rec: rec || { id: '', name: '', channel_id: '', message_id: null, spec: { content: '', embeds: [], rows: [] } },
  });
}

router.get('/new', (req, res) => renderBuilder(req, res, null));

router.get('/:id(\\d+)', (req, res) => {
  const rec = getComposed(req.guild.id, Number(req.params.id));
  if (!rec) return res.redirect(`/guilds/${req.guild.id}/messages`);
  renderBuilder(req, res, rec);
});

// --- save / publish --------------------------------------------------

router.post(
  '/:id(new|\\d+)',
  asyncHandler(async (req, res) => {
    const base = `/guilds/${req.guild.id}/messages`;
    const existing = req.params.id === 'new' ? null : getComposed(req.guild.id, Number(req.params.id));
    if (req.params.id !== 'new' && !existing) return res.redirect(base);

    const spec = parseSpec(req.body);
    const name = String(req.body.name ?? '').trim().slice(0, 100) || 'Untitled embed';
    const channelId = isId(req.body.channelId) ? req.body.channelId : '';
    const publish = req.body.action === 'publish';
    if (!spec) return res.redirect(`${base}${existing ? `/${existing.id}` : '/new'}?msg=bad`);

    let rec = existing;
    if (!rec) {
      rec = createComposed(req.guild.id, { name, channelId, messageId: null, spec });
    } else {
      rec = updateComposed(req.guild.id, rec.id, {
        name,
        channelId: channelId || rec.channel_id,
        messageId: rec.message_id,
        spec,
      });
    }
    const dest = `${base}/${rec.id}`;

    if (!publish) return res.redirect(`${dest}?msg=saved`);

    if (!isId(rec.channel_id)) return res.redirect(`${dest}?msg=nochannel`);
    try {
      if (rec.message_id) {
        await editComposed(req.guild, rec.channel_id, rec.message_id, spec);
        res.redirect(`${dest}?msg=updated`);
      } else {
        const message = await sendComposed(req.guild, rec.channel_id, spec);
        updateComposed(req.guild.id, rec.id, { name, channelId: rec.channel_id, messageId: message.id, spec });
        res.redirect(`${dest}?msg=sent`);
      }
    } catch (err) {
      res.redirect(`${dest}?msg=${encodeURIComponent(err.message).slice(0, 120)}`);
    }
  })
);

// --- unpublish (delete the posted message, keep the draft) ------------

router.post(
  '/:id(\\d+)/unpublish',
  asyncHandler(async (req, res) => {
    const rec = getComposed(req.guild.id, Number(req.params.id));
    const base = `/guilds/${req.guild.id}/messages`;
    if (!rec) return res.redirect(base);
    if (rec.message_id) {
      try {
        const ch = req.guild.channels.cache.get(rec.channel_id) ?? (await req.guild.channels.fetch(rec.channel_id));
        await ch.messages.delete(rec.message_id);
      } catch {
        /* already gone */
      }
      updateComposed(req.guild.id, rec.id, { name: rec.name, channelId: rec.channel_id, messageId: null, spec: rec.spec });
    }
    res.redirect(`${base}/${rec.id}?msg=unpublished`);
  })
);

// --- delete ----------------------------------------------------------

router.post(
  '/:id(\\d+)/delete',
  asyncHandler(async (req, res) => {
    const rec = getComposed(req.guild.id, Number(req.params.id));
    let msg = 'removed';
    if (rec) {
      if (rec.message_id) {
        try {
          const ch = req.guild.channels.cache.get(rec.channel_id) ?? (await req.guild.channels.fetch(rec.channel_id));
          await ch.messages.delete(rec.message_id);
          msg = 'deleted';
        } catch {
          msg = 'removed';
        }
      }
      deleteComposed(req.guild.id, rec.id);
    }
    res.redirect(`/guilds/${req.guild.id}/messages?msg=${msg}`);
  })
);

export default router;
