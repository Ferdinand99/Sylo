// Per-guild moderation view: set the mod-log channel, browse warnings and bans.
//
// NOTE: like the rest of the dashboard this has no authentication yet. The
// requireAdmin stub is applied so a real check (Discord OAuth2) only needs to be
// implemented in one place. Do not expose this beyond localhost / a trusted LAN
// until that is done.
import { Router } from 'express';
import { PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { runtime } from '../../runtime.js';
import { requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { guildTextChannels, resolveUserTags } from '../lib/discord.js';
import { getGuildSettings, setModlogChannel } from '../../db/guildSettings.js';
import { listGuildWarnings, addWarning } from '../../db/warnings.js';
import { notifyTarget, MOD_COLOR } from '../../bot/lib/moderation.js';
import { postModLog } from '../../bot/lib/modlog.js';
import { timeAgo } from '../lib/format.js';

const router = Router();
router.use(requireAdmin);

const BAN_DISPLAY_LIMIT = 200;

// Marker stored as moderator_id for warnings issued from the dashboard (which
// has no authenticated user yet). Rendered as "Dashboard" everywhere.
const WEB_MODERATOR = 'web';

/** Extract a user id from a raw "<@123>" mention or a bare id. */
function parseUserId(raw) {
  const m = String(raw ?? '').trim().match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/);
  return m ? m[1] || m[2] : null;
}

/** Resolve the guild from the URL, or null. */
function getGuild(req) {
  return runtime.client?.guilds.cache.get(req.params.guildId) ?? null;
}

router.get('/', (req, res) => res.redirect('/'));

router.get(
  '/:guildId',
  asyncHandler(async (req, res) => {
    const guild = getGuild(req);
    if (!guild) {
      res.status(404).render('guild-missing', { guildId: req.params.guildId });
      return;
    }

    const settings = getGuildSettings(guild.id);
    const { rows: warningRows, total: warningTotal } = listGuildWarnings(guild.id, 200);

    // Resolve the user + moderator ids that appear in the warnings (skip the
    // non-id dashboard marker).
    const tags = await resolveUserTags(
      runtime.client,
      warningRows.flatMap((w) => [w.user_id, w.moderator_id]).filter((id) => /^\d+$/.test(id))
    );
    const warnings = warningRows.map((w) => ({
      id: w.id,
      user: tags.get(w.user_id) ?? w.user_id,
      userId: w.user_id,
      moderator: w.moderator_id === WEB_MODERATOR ? 'Dashboard' : tags.get(w.moderator_id) ?? w.moderator_id,
      reason: w.reason,
      ago: timeAgo(w.created_at),
    }));

    // Bans (REST). Requires the Ban Members permission.
    let bans = [];
    let bansError = null;
    let bansTotal = 0;
    if (guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
      try {
        const fetched = await guild.bans.fetch();
        bansTotal = fetched.size;
        bans = [...fetched.values()].slice(0, BAN_DISPLAY_LIMIT).map((b) => ({
          id: b.user.id,
          tag: b.user.tag,
          reason: b.reason ?? '—',
        }));
      } catch (err) {
        bansError = err.message;
      }
    } else {
      bansError = 'The bot is missing the "Ban Members" permission in this server.';
    }

    res.render('guild', {
      guild: { id: guild.id, name: guild.name, memberCount: guild.memberCount ?? 0 },
      channels: guildTextChannels(guild),
      modlogChannelId: settings?.modlog_channel_id ?? '',
      warnings,
      warningTotal,
      warningShown: warnings.length,
      bans,
      bansTotal,
      bansShown: bans.length,
      bansError,
      banLimit: BAN_DISPLAY_LIMIT,
      msg: typeof req.query.msg === 'string' ? req.query.msg : null,
    });
  })
);

router.post('/:guildId/modlog', (req, res) => {
  const guild = getGuild(req);
  if (!guild) {
    res.redirect('/');
    return;
  }

  const channelId = String(req.body.channelId ?? '').trim();

  if (channelId === '') {
    setModlogChannel(guild.id, null);
    res.redirect(`/guilds/${guild.id}?msg=cleared`);
    return;
  }

  const channel = guild.channels.cache.get(channelId);
  if (!channel || !guildTextChannels(guild).some((c) => c.id === channelId)) {
    res.redirect(`/guilds/${guild.id}?msg=badchannel`);
    return;
  }

  const me = guild.members.me;
  if (!channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
    res.redirect(`/guilds/${guild.id}?msg=perms`);
    return;
  }

  setModlogChannel(guild.id, channelId);
  res.redirect(`/guilds/${guild.id}?msg=saved`);
});

router.post(
  '/:guildId/warnings',
  asyncHandler(async (req, res) => {
    const guild = getGuild(req);
    if (!guild) {
      res.redirect('/');
      return;
    }
    const back = `/guilds/${guild.id}`;

    const userId = parseUserId(req.body.userId);
    const reason = String(req.body.reason ?? '').trim().slice(0, 400);
    if (!userId || reason === '') {
      res.redirect(`${back}?msg=baduser`);
      return;
    }

    const user = await runtime.client.users.fetch(userId).catch(() => null);
    if (!user) {
      res.redirect(`${back}?msg=baduser`);
      return;
    }
    if (user.bot) {
      res.redirect(`${back}?msg=botuser`);
      return;
    }

    const { id, count } = addWarning({
      guildId: guild.id,
      userId: user.id,
      moderatorId: WEB_MODERATOR,
      reason,
    });

    const dmed = await notifyTarget(user, {
      guildName: guild.name,
      action: 'warned',
      reason,
      extra: `This is warning #${count}.`,
    });

    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('Member warned')
      .setThumbnail(user.displayAvatarURL())
      .addFields(
        { name: 'User', value: `${user.tag} (\`${user.id}\`)` },
        { name: 'Moderator', value: 'Dashboard' },
        { name: 'Reason', value: reason },
        { name: 'Warning ID', value: `#${id}` },
        { name: 'Total warnings', value: String(count) },
        { name: 'Notified', value: dmed ? 'Yes (DM sent)' : 'No (DMs closed)' }
      )
      .setTimestamp(Date.now());
    await postModLog(guild, embed);

    res.redirect(`${back}?msg=warned`);
  })
);

export default router;
