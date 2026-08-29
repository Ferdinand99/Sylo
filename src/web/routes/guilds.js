// Per-guild control panel: module toggles, general settings, command
// management, and the moderation panel (warnings + bans). Every route requires
// the signed-in user to be an admin of that guild (pass-through in open mode).
import { Router } from 'express';
import { PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { runtime } from '../../runtime.js';
import { requireGuildAdmin, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getGuild, baseContext } from '../lib/guildContext.js';
import { guildTextChannels, resolveUserTags } from '../lib/discord.js';
import { getModule } from '../../modules/registry.js';
import { getGuildModule, setGuildModule } from '../../db/modules.js';
import { getCommandOverrides, setCommandOverride } from '../../db/commandOverrides.js';
import { getGuildSettings, setModlogChannel, setDefaultTitle } from '../../db/guildSettings.js';
import { listGuildWarnings, addWarning } from '../../db/warnings.js';
import { notifyTarget, MOD_COLOR } from '../../bot/lib/moderation.js';
import { postModLog } from '../../bot/lib/modlog.js';
import { timeAgo } from '../lib/format.js';
import { BF_TITLE_CHOICES } from '../../bot/commands/stats.js';
import { LOG_EVENTS } from '../../modules/logging.js';
import { WELCOME_PLACEHOLDERS } from '../../modules/welcome.js';

const router = Router();

// Module ids that have a real settings partial (views/guild/modules/<id>.ejs).
const CONFIG_VIEWS = new Set(['logging', 'welcome']);
const BAN_DISPLAY_LIMIT = 200;
const WEB_MODERATOR = 'web';

function webModeratorId(req) {
  return currentUser(req)?.id ?? WEB_MODERATOR;
}
function moderatorDisplayName(req) {
  return currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`;
}
function parseUserId(raw) {
  const m = String(raw ?? '').trim().match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/);
  return m ? m[1] || m[2] : null;
}

// Resolve the guild (404 if unknown) then require admin — for every /:guildId route.
function loadGuild(req, res, next) {
  req.guild = getGuild(req);
  if (!req.guild) {
    res.status(404).render('guild-missing', { guildId: req.params.guildId });
    return;
  }
  next();
}
router.use('/:guildId', loadGuild, requireGuildAdmin);

router.get('/', (req, res) => res.redirect('/'));
router.get('/:guildId', (req, res) => res.redirect(`/guilds/${req.params.guildId}/overview`));

// --- Panels ----------------------------------------------------------------

router.get('/:guildId/overview', (req, res) => {
  res.render('guild', { ...baseContext(req.guild, 'overview') });
});

router.get('/:guildId/general', (req, res) => {
  const settings = getGuildSettings(req.guild.id);
  res.render('guild', {
    ...baseContext(req.guild, 'general'),
    defaultTitle: settings?.default_title ?? '',
    modlogChannelId: settings?.modlog_channel_id ?? '',
    titleChoices: BF_TITLE_CHOICES,
    msg: typeof req.query.msg === 'string' ? req.query.msg : null,
  });
});

router.get('/:guildId/commands', (req, res) => {
  const overrides = getCommandOverrides(req.guild.id);
  const roles = [...req.guild.roles.cache.values()]
    .filter((r) => r.id !== req.guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name }));

  const commands = [...(runtime.client?.commands?.values() ?? [])]
    .map(({ data }) => {
      const ov = overrides.get(data.name);
      return {
        name: data.name,
        description: data.description,
        enabled: ov ? ov.enabled : true,
        allowedChannels: ov?.allowedChannels ?? [],
        allowedRoles: ov?.allowedRoles ?? [],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  res.render('guild', {
    ...baseContext(req.guild, 'commands'),
    commands,
    roles,
    msg: typeof req.query.msg === 'string' ? req.query.msg : null,
  });
});

router.get(
  '/:guildId/moderation',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const { rows: warningRows, total: warningTotal } = listGuildWarnings(guild.id, 200);
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
      ...baseContext(guild, 'moderation'),
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

// Per-module settings panel.
router.get('/:guildId/m/:moduleId', (req, res) => {
  const mod = getModule(req.params.moduleId);
  if (!mod) return res.redirect(`/guilds/${req.guild.id}/overview`);
  const { enabled, config } = getGuildModule(req.guild.id, mod.id);
  res.render('guild', {
    ...baseContext(req.guild, `m/${mod.id}`),
    activeModule: mod,
    moduleEnabled: enabled,
    moduleConfig: config,
    configView: CONFIG_VIEWS.has(mod.id) ? `guild/modules/${mod.id}` : 'guild/modules/stub',
    logEvents: LOG_EVENTS,
    welcomePlaceholders: WELCOME_PLACEHOLDERS,
    msg: typeof req.query.msg === 'string' ? req.query.msg : null,
  });
});

// Save a module's settings.
router.post('/:guildId/m/:moduleId/config', (req, res) => {
  const mod = getModule(req.params.moduleId);
  if (!mod) return res.redirect(`/guilds/${req.guild.id}/overview`);
  const back = `/guilds/${req.guild.id}/m/${mod.id}`;

  let config;
  if (mod.id === 'logging') {
    config = {
      channel: /^\d{17,20}$/.test(req.body.channel ?? '') ? req.body.channel : '',
      events: Object.fromEntries(LOG_EVENTS.map(([key]) => [key, req.body[`ev_${key}`] === 'on'])),
    };
  } else if (mod.id === 'welcome') {
    const chan = (v) => (/^\d{17,20}$/.test(v ?? '') ? v : '');
    config = {
      joinChannel: chan(req.body.joinChannel),
      joinMessage: String(req.body.joinMessage ?? '').slice(0, 1500),
      leaveChannel: chan(req.body.leaveChannel),
      leaveMessage: String(req.body.leaveMessage ?? '').slice(0, 1500),
      dmMessage: String(req.body.dmMessage ?? '').slice(0, 1500),
      useEmbed: req.body.useEmbed === 'on',
    };
  } else {
    return res.redirect(back);
  }

  setGuildModule(req.guild.id, mod.id, { config });
  res.redirect(`${back}?msg=saved`);
});

// --- Actions -------------------------------------------------------------

// Toggle a module on/off (JSON, called from app.js).
router.post('/:guildId/modules/:moduleId', (req, res) => {
  const mod = getModule(req.params.moduleId);
  if (!mod) return res.status(404).json({ error: 'Unknown module' });
  const enabled = Boolean(req.body?.enabled);
  setGuildModule(req.guild.id, mod.id, { enabled });
  res.json({ enabled });
});

router.post('/:guildId/general', (req, res) => {
  const guild = req.guild;
  const back = `/guilds/${guild.id}/general`;

  // Default Battlefield title (empty = none).
  const rawTitle = String(req.body.defaultTitle ?? '').trim();
  const title = rawTitle === '' ? null : rawTitle;
  if (title && !BF_TITLE_CHOICES.some((c) => c.value === title)) {
    return res.redirect(`${back}?msg=badtitle`);
  }
  setDefaultTitle(guild.id, title);

  // Mod-log channel (empty = disabled).
  const channelId = String(req.body.modlogChannelId ?? '').trim();
  if (channelId === '') {
    setModlogChannel(guild.id, null);
    return res.redirect(`${back}?msg=saved`);
  }
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !guildTextChannels(guild).some((c) => c.id === channelId)) {
    return res.redirect(`${back}?msg=badchannel`);
  }
  if (!channel.permissionsFor(guild.members.me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
    return res.redirect(`${back}?msg=perms`);
  }
  setModlogChannel(guild.id, channelId);
  res.redirect(`${back}?msg=saved`);
});

router.post('/:guildId/commands/:command', (req, res) => {
  const guild = req.guild;
  const command = req.params.command;
  if (!runtime.client?.commands?.has(command)) {
    return res.redirect(`/guilds/${guild.id}/commands?msg=badcommand`);
  }
  // Accepts an array (multi-select) or a comma/space-separated string of ids.
  const toIds = (v) =>
    (Array.isArray(v) ? v : v == null ? [] : String(v).split(/[\s,]+/))
      .map((s) => String(s).trim())
      .filter((s) => /^\d{17,20}$/.test(s));

  setCommandOverride(guild.id, command, {
    enabled: req.body.enabled === 'on' || req.body.enabled === 'true',
    allowedChannels: toIds(req.body.channels),
    allowedRoles: toIds(req.body.roles),
  });
  res.redirect(`/guilds/${guild.id}/commands?msg=saved`);
});

router.post(
  '/:guildId/warnings',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const back = `/guilds/${guild.id}/moderation`;

    const userId = parseUserId(req.body.userId);
    const reason = String(req.body.reason ?? '').trim().slice(0, 400);
    if (!userId || reason === '') return res.redirect(`${back}?msg=baduser`);

    const user = await runtime.client.users.fetch(userId).catch(() => null);
    if (!user) return res.redirect(`${back}?msg=baduser`);
    if (user.bot) return res.redirect(`${back}?msg=botuser`);

    const { id, count } = addWarning({
      guildId: guild.id,
      userId: user.id,
      moderatorId: webModeratorId(req),
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
        { name: 'Moderator', value: moderatorDisplayName(req) },
        { name: 'Reason', value: reason },
        { name: 'Warning ID', value: `#${id}` },
        { name: 'Total warnings', value: String(count) },
        { name: 'Notified', value: dmed ? 'Yes (DM sent)' : 'No (DMs closed)' }
      )
      .setTimestamp(Date.now());
    const logged = await postModLog(guild, embed);
    res.redirect(`${back}?msg=${logged ? 'warned' : 'warned-nolog'}`);
  })
);

export default router;
