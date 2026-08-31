// Per-guild control panel: module toggles, general settings, command
// management, and the moderation panel (warnings + bans). Every route requires
// the signed-in user to be an admin of that guild (pass-through in open mode).
import { Router } from 'express';
import { PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { runtime } from '../../runtime.js';
import { requireGuildAdmin, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getGuild, baseContext, assignableRoles } from '../lib/guildContext.js';
import { guildTextChannels, guildVoiceChannels, guildCategories, resolveUserTags } from '../lib/discord.js';
import { getModule } from '../../modules/registry.js';
import { getGuildModule, setGuildModule } from '../../db/modules.js';
import { getCommandOverrides, setCommandOverride } from '../../db/commandOverrides.js';
import {
  getGuildSettings,
  setModlogChannel,
  getBotMasterRoles,
  setBotMasterRoles,
  setEmbedColor,
  guildEmbedColor,
} from '../../db/guildSettings.js';
import { listGuildWarnings, addWarning } from '../../db/warnings.js';
import { notifyTarget, MOD_COLOR } from '../../bot/lib/moderation.js';
import { postModLog } from '../../bot/lib/modlog.js';
import { timeAgo } from '../lib/format.js';
import { LOG_EVENTS } from '../../modules/logging.js';
import { WELCOME_PLACEHOLDERS } from '../../modules/welcome.js';
import { applyWarnThresholds, normaliseThresholds, THRESHOLD_ACTIONS } from '../../modules/moderation.js';
import { normaliseAutomodConfig, AUTOMOD_RULES, AUTOMOD_ACTIONS } from '../../modules/automod.js';
import { parseEmoji, publishReactionMessage } from '../../modules/roles.js';
import { normaliseEmbedSpec } from '../../modules/welcomeChannel.js';
import { getCounting, setCount, resetCount } from '../../db/counting.js';
import { normaliseCustomCommands, CC_PLACEHOLDERS } from '../../modules/customCommands.js';
import { normaliseAutoresponder, AR_MATCH_MODES, AR_PLACEHOLDERS } from '../../modules/autoresponder.js';
import { normaliseVerificationConfig, VERIFY_MODES, ensureVerifyMessage } from '../../modules/verification.js';
import { normaliseServerStats, STAT_TYPES } from '../../modules/serverStats.js';
import { normaliseAppealsConfig, decideAndNotify } from '../../modules/appeals.js';
import { normaliseTempVoiceConfig } from '../../modules/tempVoice.js';
import { normaliseStarboard, rescanBoard } from '../../modules/starboard.js';
import { deleteBoardEntries } from '../../db/starboard.js';
import { normaliseInviteTrackerConfig, primeGuild as primeInviteCache } from '../../modules/inviteTracker.js';
import { topInviters, inviterCount, setBonus } from '../../db/inviteTracker.js';
import { normalisePollsConfig } from '../../modules/polls.js';
import {
  WC_PRESETS,
  normaliseWelcomeChannelConfig,
  publishWelcome,
  unpublishWelcome,
  createWelcomeChannel,
} from '../../modules/welcomeChannel.js';
import { listAppeals, getAppeal } from '../../db/appeals.js';
import { config as appConfig } from '../../config.js';
import {
  listScheduled,
  createReminder,
  updateReminder,
  deleteScheduled,
  setScheduledEnabled,
  getScheduled,
} from '../../db/scheduledMessages.js';
import {
  SCHEDULE_PRESETS,
  WEEKDAYS,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
} from '../../modules/scheduledMessages.js';
import { sendComposed } from '../../modules/messageCreator.js';
import { syncGuildCustomCommands } from '../../bot/lib/customCommandSync.js';
import { normaliseLevelingConfig, ANNOUNCE_MODES, XP_RATES, syncRewards } from '../../modules/leveling.js';
import { levelFromXp } from '../../modules/lib/levels.js';
import { topMembers, memberCount, setXp, resetGuildLeveling } from '../../db/leveling.js';
import { recordAudit, listAudit } from '../../db/audit.js';
import { exportGuildConfig } from '../../db/exportConfig.js';
import { buildOverview } from '../lib/overviewSummary.js';

const router = Router();

// Module ids that have a real settings partial (views/guild/modules/<id>.ejs).
const CONFIG_VIEWS = new Set([
  'moderation', 'logging', 'welcome', 'roles', 'sticky', 'tickets', 'automod', 'counting',
  'custom-commands', 'scheduled-messages', 'leveling', 'autoresponder', 'verification',
  'afk', 'server-stats', 'free-games', 'appeals', 'temp-voice', 'welcome-channel', 'starboard',
  'invite-tracker', 'polls',
]);
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
  // Remember this server so "/" and the sidebar land back here next visit.
  if (req.session) req.session.lastGuild = req.guild.id;
  next();
}
router.use('/:guildId', loadGuild, requireGuildAdmin);

router.get('/', (req, res) => res.redirect('/'));
router.get('/:guildId', (req, res) => res.redirect(`/guilds/${req.params.guildId}/overview`));

// Custom emojis for the reaction-role emoji picker.
router.get('/:guildId/emojis', (req, res) => {
  const custom = [...req.guild.emojis.cache.values()].map((e) => ({
    name: e.name,
    display: e.toString(),
    url: e.imageURL({ size: 32 }),
  }));
  res.json({ custom });
});

// --- Panels ----------------------------------------------------------------

router.get('/:guildId/overview', (req, res) => {
  res.render('guild', { ...baseContext(req.guild, 'overview'), overview: buildOverview(req.guild) });
});

// Old bookmark → the renamed Settings panel.
router.get('/:guildId/general', (req, res) => res.redirect(`/guilds/${req.guild.id}/settings`));

router.get('/:guildId/settings', (req, res) => {
  const guild = req.guild;
  const settings = getGuildSettings(guild.id);
  const color = guildEmbedColor(guild.id);

  const roleView = (r) => ({ id: r.id, name: r.name, color: r.hexColor === '#000000' ? null : r.hexColor });
  const usable = [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position);
  const adminRoles = usable.filter((r) => r.permissions.has(PermissionFlagsBits.Administrator));
  const adminIds = new Set(adminRoles.map((r) => r.id));
  const stored = getBotMasterRoles(guild.id).filter((id) => !adminIds.has(id));
  const storedSet = new Set(stored);

  res.render('guild', {
    ...baseContext(guild, 'settings'),
    modlogChannelId: settings?.modlog_channel_id ?? '',
    embedColorHex: '#' + color.toString(16).padStart(6, '0'),
    adminRoles: adminRoles.map(roleView),
    botMasters: stored.map((id) => {
      const r = guild.roles.cache.get(id);
      return r ? roleView(r) : { id, name: id, color: null };
    }),
    rolePool: usable.filter((r) => !adminIds.has(r.id) && !storedSet.has(r.id)).map(roleView),
    msg: typeof req.query.msg === 'string' ? req.query.msg : null,
  });
});

router.post('/:guildId/settings', (req, res) => {
  const guild = req.guild;
  const back = `/guilds/${guild.id}/settings`;

  // Mod-log channel (empty = off).
  const channelId = String(req.body.modlogChannelId ?? '').trim();
  if (channelId === '') {
    setModlogChannel(guild.id, null);
  } else if (guildTextChannels(guild).some((c) => c.id === channelId)) {
    setModlogChannel(guild.id, channelId);
  } else {
    return res.redirect(`${back}?msg=badchannel`);
  }

  // Bot masters.
  setBotMasterRoles(guild.id, [].concat(req.body.botMasterRoles ?? []));

  // Default embed colour.
  const hex = String(req.body.embedColor ?? '').replace('#', '');
  if (req.body.embedColorReset === 'on' || hex === '') setEmbedColor(guild.id, null);
  else if (/^[0-9a-fA-F]{6}$/.test(hex)) setEmbedColor(guild.id, parseInt(hex, 16));

  recordAudit(guild.id, { actor: moderatorDisplayName(req), action: 'settings:server', detail: 'saved' });
  res.redirect(`${back}?msg=saved`);
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

    const overrides = getCommandOverrides(guild.id);
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
      ...baseContext(guild, 'moderation'),
      warnings,
      warningTotal,
      warningShown: warnings.length,
      bans,
      bansTotal,
      bansShown: bans.length,
      bansError,
      banLimit: BAN_DISPLAY_LIMIT,
      automodConfig: getGuildModule(guild.id, 'automod').config,
      moderationCfg: getGuildModule(guild.id, 'moderation').config,
      loggingCfg: getGuildModule(guild.id, 'logging').config,
      commands,
      roles: assignableRoles(guild),
      automodRules: AUTOMOD_RULES,
      thresholdActions: THRESHOLD_ACTIONS,
      logEvents: LOG_EVENTS,
      msg: typeof req.query.msg === 'string' ? req.query.msg : null,
    });
  })
);

// Ban appeals review panel: open submissions + recent decisions.
router.get(
  '/:guildId/appeals',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const rows = listAppeals(guild.id, 100);
    const cfg = normaliseAppealsConfig(getGuildModule(guild.id, 'appeals').config);
    const appeals = rows.map((a) => ({
      id: a.id,
      user: a.user_tag || a.user_id,
      userId: a.user_id,
      banReason: a.ban_reason || '—',
      answers: a.answers,
      status: a.status,
      decidedBy: a.decided_by,
      decisionReason: a.decision_reason,
      ago: timeAgo(a.created_at),
      decidedAgo: a.decided_at ? timeAgo(a.decided_at) : null,
    }));
    res.render('guild', {
      ...baseContext(guild, 'appeals'),
      appeals,
      appealsOpen: appeals.filter((a) => a.status === 'open').length,
      appealsModuleEnabled: getGuildModule(guild.id, 'appeals').enabled,
      appealsConfigured: cfg.questions.length > 0,
      msg: typeof req.query.msg === 'string' ? req.query.msg : null,
    });
  })
);

// Accept or deny one appeal.
router.post(
  '/:guildId/appeals/:id/decide',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const back = `/guilds/${guild.id}/appeals`;
    const appeal = getAppeal(guild.id, req.params.id);
    if (!appeal || appeal.status !== 'open') return res.redirect(`${back}?msg=appeal-gone`);

    const decision = req.body.decision === 'accept' ? 'accepted' : req.body.decision === 'deny' ? 'denied' : null;
    if (!decision) return res.redirect(`${back}?msg=appeal-bad`);
    const reason = String(req.body.reason ?? '').trim().slice(0, 1000) || 'No reason given';

    const result = await decideAndNotify(guild, appeal, {
      status: decision,
      decidedBy: moderatorDisplayName(req),
      reason,
    });
    if (!result.recorded) return res.redirect(`${back}?msg=appeal-gone`);

    recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: `appeal:${decision}`,
      detail: `#${appeal.id} ${appeal.user_tag || appeal.user_id}${decision === 'accepted' && !result.unbanned ? ' (unban manually)' : ''}`,
    });
    res.redirect(`${back}?msg=appeal-${decision}${result.dmDelivered ? '' : '-nodm'}`);
  })
);

// Leaderboard settings: the public-leaderboard switch + a top-members preview.
router.get(
  '/:guildId/leaderboard',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const { enabled, config } = getGuildModule(guild.id, 'leveling');
    const cfg = normaliseLevelingConfig(config);
    const rows = topMembers(guild.id, 10);
    const tags = await resolveUserTags(runtime.client, rows.map((r) => r.user_id));
    res.render('guild', {
      ...baseContext(guild, 'leaderboard'),
      levelingEnabled: enabled,
      publicLeaderboard: cfg.publicLeaderboard,
      board: {
        total: memberCount(guild.id),
        rows: rows.map((r, i) => ({
          rank: i + 1,
          name: tags.get(r.user_id) ?? r.user_id,
          level: r.level,
          xp: r.xp,
          messages: r.messages,
        })),
      },
      msg: typeof req.query.msg === 'string' ? req.query.msg : null,
    });
  })
);

// Flip only the public-leaderboard flag on the leveling module.
router.post('/:guildId/leaderboard/public', (req, res) => {
  const prev = getGuildModule(req.guild.id, 'leveling').config;
  const publicLeaderboard = req.body.publicLeaderboard === 'on';
  setGuildModule(req.guild.id, 'leveling', { config: { ...prev, publicLeaderboard } });
  recordAudit(req.guild.id, {
    actor: moderatorDisplayName(req),
    action: 'leveling:leaderboard',
    detail: publicLeaderboard ? 'made public' : 'made private',
  });
  res.redirect(`/guilds/${req.guild.id}/leaderboard?msg=saved`);
});

// Moderator → Admin tab: immunity roles (patch just automod's exemptRoles).
router.post('/:guildId/m/automod/immunity', (req, res) => {
  const prev = getGuildModule(req.guild.id, 'automod').config;
  const roles = [].concat(req.body.immunityRoles ?? []).filter((r) => /^\d{17,20}$/.test(r));
  setGuildModule(req.guild.id, 'automod', {
    config: normaliseAutomodConfig({ ...prev, exemptRoles: roles }),
  });
  recordAudit(req.guild.id, {
    actor: moderatorDisplayName(req),
    action: 'module:automod',
    detail: `immunity roles (${roles.length})`,
  });
  res.redirect(`/guilds/${req.guild.id}/moderation?msg=saved`);
});

// Welcome Channel: create a read-only #welcome channel.
router.post(
  '/:guildId/m/welcome-channel/create-channel',
  asyncHandler(async (req, res) => {
    const back = `/guilds/${req.guild.id}/m/welcome-channel`;
    const r = await createWelcomeChannel(req.guild);
    if (!r.ok) return res.redirect(`${back}?msg=wc-fail`);
    const cfg = normaliseWelcomeChannelConfig(getGuildModule(req.guild.id, 'welcome-channel').config);
    setGuildModule(req.guild.id, 'welcome-channel', { config: { ...cfg, channelId: r.channelId } });
    recordAudit(req.guild.id, { actor: moderatorDisplayName(req), action: 'module:welcome-channel', detail: 'created #welcome' });
    res.redirect(`${back}?msg=wc-channel`);
  })
);

// Welcome Channel: remove the published message.
router.post(
  '/:guildId/m/welcome-channel/unpublish',
  asyncHandler(async (req, res) => {
    const back = `/guilds/${req.guild.id}/m/welcome-channel`;
    const cfg = normaliseWelcomeChannelConfig(getGuildModule(req.guild.id, 'welcome-channel').config);
    await unpublishWelcome(req.guild, cfg);
    setGuildModule(req.guild.id, 'welcome-channel', { config: { ...cfg, messageId: '' } });
    res.redirect(`${back}?msg=wc-unpub`);
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
    thresholdActions: THRESHOLD_ACTIONS,
    modlogChannelId: getGuildSettings(req.guild.id)?.modlog_channel_id ?? '',
    roles: ['roles', 'tickets', 'automod', 'leveling', 'autoresponder', 'verification', 'free-games', 'welcome', 'starboard', 'polls'].includes(mod.id)
      ? assignableRoles(req.guild)
      : [],
    welcomeAutoroles: mod.id === 'welcome' ? getGuildModule(req.guild.id, 'roles').config.autoroles ?? [] : [],
    verificationEnabled: mod.id === 'welcome' ? getGuildModule(req.guild.id, 'verification').enabled : false,
    wcPresets: mod.id === 'welcome-channel'
      ? WC_PRESETS.map((p) => ({ id: p.id, label: p.label, kind: p.kind, defaults: p.make() }))
      : [],
    automodRules: AUTOMOD_RULES,
    automodActions: AUTOMOD_ACTIONS,
    verifyModes: VERIFY_MODES,
    turnstileEnabled: appConfig.turnstileEnabled,
    dashboardUrlSet: Boolean(appConfig.dashboardUrl),
    voiceChannels: ['server-stats', 'temp-voice'].includes(mod.id) ? guildVoiceChannels(req.guild) : [],
    categories: mod.id === 'temp-voice' ? guildCategories(req.guild) : [],
    statTypes: STAT_TYPES,
    countingState: mod.id === 'counting' ? getCounting(req.guild.id) : null,
    ccPlaceholders: CC_PLACEHOLDERS,
    arPlaceholders: AR_PLACEHOLDERS,
    arMatchModes: AR_MATCH_MODES,
    reminders: mod.id === 'scheduled-messages'
      ? listScheduled(req.guild.id).map((j) => ({
          id: j.id,
          name: j.name || (j.spec?.embeds?.[0]?.title || j.content || 'Untitled reminder').slice(0, 60),
          channel: guildTextChannels(req.guild).find((c) => c.id === j.channel_id)?.name ?? j.channel_id,
          mode: j.mode,
          intervalMinutes: j.interval_minutes,
          runAt: j.run_at,
          enabled: j.enabled === 1,
          lastRun: j.last_run_at ? timeAgo(j.last_run_at) : null,
        }))
      : [],
    schedulePresets: SCHEDULE_PRESETS,
    announceModes: ANNOUNCE_MODES,
    xpRates: XP_RATES,
    levelingCommands: mod.id === 'leveling'
      ? ['rank', 'leaderboard']
          .map((name) => {
            const cmd = runtime.client?.commands?.get(name);
            if (!cmd) return null;
            const ov = getCommandOverrides(req.guild.id).get(name);
            return {
              name,
              description: cmd.data.description,
              enabled: ov ? ov.enabled : true,
              allowedChannels: ov?.allowedChannels ?? [],
              allowedRoles: ov?.allowedRoles ?? [],
            };
          })
          .filter(Boolean)
      : [],
    levelingBoard: mod.id === 'leveling'
      ? {
          total: memberCount(req.guild.id),
          rows: topMembers(req.guild.id, 15).map((r, i) => ({
            rank: i + 1,
            userId: r.user_id,
            level: r.level,
            xp: r.xp,
            messages: r.messages,
          })),
        }
      : null,
    inviteBoard: mod.id === 'invite-tracker'
      ? {
          total: inviterCount(req.guild.id),
          canReadInvites: Boolean(req.guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)),
          rows: topInviters(req.guild.id, 15).map((r, i) => ({
            rank: i + 1,
            userId: r.user_id,
            net: r.net,
            regular: r.regular,
            leaves: r.leaves,
            bonus: r.bonus,
          })),
        }
      : null,
    msg: typeof req.query.msg === 'string' ? req.query.msg : null,
  });
});

// Save a module's settings.
router.post('/:guildId/m/:moduleId/config', asyncHandler(async (req, res) => {
  const mod = getModule(req.params.moduleId);
  if (!mod) return res.redirect(`/guilds/${req.guild.id}/overview`);
  const back = `/guilds/${req.guild.id}/m/${mod.id}`;

  let config;
  if (mod.id === 'moderation') {
    // Threshold rows come as parallel arrays: t_count[], t_action[], t_duration[].
    const counts = [].concat(req.body.t_count ?? []);
    const actions = [].concat(req.body.t_action ?? []);
    const durations = [].concat(req.body.t_duration ?? []);
    const rows = counts.map((c, i) => ({
      count: c,
      action: actions[i],
      durationMinutes: durations[i],
    }));
    config = {
      dmOnPunish: req.body.dmOnPunish === 'on',
      warnThresholds: normaliseThresholds(rows),
    };
  } else if (mod.id === 'logging') {
    config = {
      channel: /^\d{17,20}$/.test(req.body.channel ?? '') ? req.body.channel : '',
      events: Object.fromEntries(LOG_EVENTS.map(([key]) => [key, req.body[`ev_${key}`] === 'on'])),
    };
  } else if (mod.id === 'welcome') {
    const chan = (v) => (/^\d{17,20}$/.test(v ?? '') ? v : '');
    const joinOn = req.body.enable_join === 'on';
    const dmOn = req.body.enable_dm === 'on';
    const leaveOn = req.body.enable_leave === 'on';
    config = {
      joinChannel: joinOn ? chan(req.body.joinChannel) : '',
      joinMessage: joinOn ? String(req.body.joinMessage ?? '').slice(0, 1500) : '',
      leaveChannel: leaveOn ? chan(req.body.leaveChannel) : '',
      leaveMessage: leaveOn ? String(req.body.leaveMessage ?? '').slice(0, 1500) : '',
      dmMessage: dmOn ? String(req.body.dmMessage ?? '').slice(0, 1500) : '',
      useEmbed: req.body.useEmbed === 'on',
    };
    // "Give roles to new members" here writes the Reaction roles & autoroles module.
    const autoOn = req.body.enable_autorole === 'on';
    const newRoles = autoOn
      ? [].concat(req.body.newRoles ?? []).filter((r) => /^\d{17,20}$/.test(r))
      : [];
    const rolesMod = getGuildModule(req.guild.id, 'roles');
    setGuildModule(req.guild.id, 'roles', {
      enabled: rolesMod.enabled || newRoles.length > 0,
      config: { ...rolesMod.config, autoroles: newRoles },
    });
  } else if (mod.id === 'roles') {
    const existing = getGuildModule(req.guild.id, 'roles').config;
    const autoroles = [].concat(req.body.autoroles ?? []).filter((r) => /^\d{17,20}$/.test(r));
    config = { autoroles, reactionMessages: existing.reactionMessages ?? [] };
  } else if (mod.id === 'sticky') {
    const prev = getGuildModule(req.guild.id, 'sticky').config;
    const prevById = new Map((prev.stickies ?? []).map((s) => [s.channelId, s]));
    const chans = [].concat(req.body.s_channel ?? []);
    const contents = [].concat(req.body.s_content ?? []);
    const stickies = chans
      .map((channelId, i) => ({
        channelId,
        content: String(contents[i] ?? '').slice(0, 2000),
        lastMessageId: prevById.get(channelId)?.lastMessageId ?? null,
      }))
      .filter((s) => /^\d{17,20}$/.test(s.channelId) && s.content.trim() !== '');
    config = { stickies };
  } else if (mod.id === 'tickets') {
    config = {
      greeting: String(req.body.greeting ?? '').slice(0, 1500),
      closeMessage: String(req.body.closeMessage ?? '').slice(0, 1500),
      notifyChannel: /^\d{17,20}$/.test(req.body.notifyChannel ?? '') ? req.body.notifyChannel : '',
      staffRoles: [].concat(req.body.staffRoles ?? []).filter((r) => /^\d{17,20}$/.test(r)),
    };
  } else if (mod.id === 'automod') {
    const b = req.body;
    const prevAutomod = getGuildModule(req.guild.id, 'automod').config;
    // MEE6-style: one dropdown per rule — off | delete | warn | timeout.
    const rule = (key) => {
      const m = b[`r_${key}_mode`];
      return { enabled: Boolean(m) && m !== 'off', action: m === 'off' || !m ? 'delete' : m };
    };
    config = normaliseAutomodConfig({
      deleteMessage: true,
      timeoutMinutes: b.timeoutMinutes,
      exemptChannels: [].concat(b.exemptChannels ?? []),
      // Immunity roles are managed on the Admin tab — keep whatever is stored.
      exemptRoles: prevAutomod.exemptRoles ?? [],
      rules: {
        invites: rule('invites'),
        links: { ...rule('links'), allowed: b.r_links_allowed },
        spam: { ...rule('spam'), max: b.r_spam_max, seconds: b.r_spam_seconds },
        mentions: { ...rule('mentions'), max: b.r_mentions_max },
        caps: { ...rule('caps'), minLength: b.r_caps_minLength, percent: b.r_caps_percent },
        words: { ...rule('words'), list: b.r_words_list },
        emojis: { ...rule('emojis'), max: b.r_emojis_max },
        spoilers: { ...rule('spoilers'), max: b.r_spoilers_max },
        zalgo: rule('zalgo'),
        repeat: rule('repeat'),
      },
    });
  } else if (mod.id === 'counting') {
    config = {
      channelId: /^\d{17,20}$/.test(req.body.channelId ?? '') ? req.body.channelId : '',
      allowSameUser: req.body.allowSameUser === 'on',
      resetOnFail: req.body.resetOnFail === 'on',
      react: req.body.react === 'on',
    };
  } else if (mod.id === 'leveling') {
    const levels = [].concat(req.body.rw_level ?? []);
    const roleIds = [].concat(req.body.rw_role ?? []);
    const prevLvl = getGuildModule(req.guild.id, 'leveling').config;
    config = normaliseLevelingConfig({
      cooldownSeconds: req.body.cooldownSeconds,
      xpRate: req.body.xpRate,
      announce: req.body.announce,
      announceChannel: req.body.announceChannel,
      announceMessage: req.body.announceMessage,
      noXpChannels: [].concat(req.body.noXpChannels ?? []),
      noXpChannelsMode: req.body.noXpChannelsMode,
      noXpRoles: [].concat(req.body.noXpRoles ?? []),
      noXpRolesMode: req.body.noXpRolesMode,
      stackRewards: req.body.stackRewards === 'on',
      removeRewardsOnXpLoss: req.body.removeRewardsOnXpLoss === 'on',
      // The public-leaderboard toggle lives on the Leaderboard page — keep it.
      publicLeaderboard: prevLvl.publicLeaderboard !== false,
      rewards: levels.map((level, i) => ({ level, roleId: roleIds[i] ?? '' })),
    });
  } else if (mod.id === 'autoresponder') {
    const triggers = [].concat(req.body.ar_trigger ?? []);
    const matches = [].concat(req.body.ar_match ?? []);
    const responses = [].concat(req.body.ar_response ?? []);
    const asEmbed = [].concat(req.body.ar_embed ?? []);
    const del = [].concat(req.body.ar_delete ?? []);
    config = normaliseAutoresponder({
      cooldownSeconds: req.body.cooldownSeconds,
      ignoreChannels: [].concat(req.body.ignoreChannels ?? []),
      ignoreRoles: [].concat(req.body.ignoreRoles ?? []),
      responders: triggers.map((trigger, i) => ({
        trigger,
        match: matches[i],
        response: responses[i] ?? '',
        embed: asEmbed[i] === 'embed',
        deleteTrigger: del[i] === 'delete',
      })),
    });
  } else if (mod.id === 'afk') {
    config = {
      setNickname: req.body.setNickname === 'on',
      mentionReply: req.body.mentionReply === 'on',
      ignoreChannels: [].concat(req.body.ignoreChannels ?? []).filter((c) => /^\d{17,20}$/.test(c)),
    };
  } else if (mod.id === 'free-games') {
    config = {
      channelId: /^\d{17,20}$/.test(req.body.channelId ?? '') ? req.body.channelId : '',
      roleId: /^\d{17,20}$/.test(req.body.roleId ?? '') ? req.body.roleId : '',
    };
  } else if (mod.id === 'server-stats') {
    const chans = [].concat(req.body.ss_channel ?? []);
    const types = [].concat(req.body.ss_type ?? []);
    const templates = [].concat(req.body.ss_template ?? []);
    config = normaliseServerStats({
      refreshMinutes: req.body.refreshMinutes,
      channels: chans.map((channelId, i) => ({
        channelId,
        type: types[i],
        template: templates[i] ?? '',
      })),
    });
  } else if (mod.id === 'temp-voice') {
    const hubs = [].concat(req.body.tv_hub ?? []);
    const cats = [].concat(req.body.tv_category ?? []);
    const names = [].concat(req.body.tv_name ?? []);
    const limits = [].concat(req.body.tv_limit ?? []);
    config = normaliseTempVoiceConfig({
      hubs: hubs.map((hubChannelId, i) => ({
        hubChannelId,
        categoryId: cats[i] ?? '',
        nameTemplate: names[i] ?? '',
        userLimit: limits[i] ?? 0,
      })),
    });
  } else if (mod.id === 'appeals') {
    config = normaliseAppealsConfig({
      questions: [].concat(req.body.q ?? []),
      autoUnbanOnAccept: req.body.autoUnbanOnAccept === 'on',
      reviewChannelId: req.body.reviewChannelId,
      cooldownDays: req.body.cooldownDays,
      appealMessage: req.body.appealMessage,
      appealServerInvite: req.body.appealServerInvite,
    });
  } else if (mod.id === 'verification') {
    const prev = getGuildModule(req.guild.id, 'verification').config;
    config = normaliseVerificationConfig({
      mode: req.body.mode,
      verifiedRoleId: req.body.verifiedRoleId,
      channelId: req.body.channelId,
      messageId: prev.messageId, // bot-managed
      title: req.body.title,
      message: req.body.message,
      successMessage: req.body.successMessage,
      logChannelId: req.body.logChannelId,
      kickAfterMinutes: req.body.kickAfterMinutes,
    });
  } else if (mod.id === 'invite-tracker') {
    config = normaliseInviteTrackerConfig({
      joinLogChannelId: req.body.joinLogChannelId,
      graceHours: req.body.graceHours,
    });
  } else if (mod.id === 'polls') {
    const msg = (raw) => {
      try {
        const o = JSON.parse(raw || '{}');
        return o && typeof o === 'object' ? o : {};
      } catch {
        return {};
      }
    };
    config = normalisePollsConfig({
      voteRoleMode: req.body.voteRoleMode,
      voteRoles: [].concat(req.body.voteRoles ?? []),
      pollMessage: msg(req.body.pm_json),
      resultsMessage: msg(req.body.rm_json),
    });
  } else if (mod.id === 'welcome-channel') {
    const prev = getGuildModule(req.guild.id, 'welcome-channel').config;
    let spec = {};
    try {
      spec = JSON.parse(req.body.spec || '{}');
    } catch {
      spec = {};
    }
    config = normaliseWelcomeChannelConfig({ channelId: req.body.channelId, messageId: prev.messageId, spec });
  } else {
    return res.redirect(back);
  }

  setGuildModule(req.guild.id, mod.id, { config });
  recordAudit(req.guild.id, { actor: moderatorDisplayName(req), action: `module:${mod.id}`, detail: 'settings saved' });
  if (mod.id === 'invite-tracker') {
    primeInviteCache(req.guild).catch((err) =>
      console.error('[invite-tracker] cache prime after save failed:', err.message)
    );
  }
  if (mod.id === 'verification') {
    ensureVerifyMessage(req.guild, config).catch((err) =>
      console.error('[verification] ensure message after save failed:', err.message)
    );
  }
  if (mod.id === 'welcome-channel' && req.body.action === 'publish') {
    const cfg = normaliseWelcomeChannelConfig(getGuildModule(req.guild.id, 'welcome-channel').config);
    const r = await publishWelcome(req.guild, cfg);
    if (r.ok) {
      setGuildModule(req.guild.id, 'welcome-channel', { enabled: true, config: { ...cfg, messageId: r.messageId } });
      return res.redirect(`${back}?msg=wc-published`);
    }
    return res.redirect(`${back}?msg=wc-fail`);
  }
  res.redirect(`${back}?msg=saved`);
}));

// Counting: correct the running number (or reset it) from the dashboard.
router.post('/:guildId/m/counting/count', (req, res) => {
  const back = `/guilds/${req.guild.id}/m/counting`;
  if (req.body.reset === 'true') {
    resetCount(req.guild.id);
    recordAudit(req.guild.id, { actor: moderatorDisplayName(req), action: 'counting:reset', detail: 'count set to 0' });
    return res.redirect(`${back}?msg=count-reset`);
  }
  const n = Number(req.body.current);
  if (!Number.isInteger(n) || n < 0 || n > 1e12) {
    return res.redirect(`${back}?msg=count-bad`);
  }
  setCount(req.guild.id, n);
  recordAudit(req.guild.id, { actor: moderatorDisplayName(req), action: 'counting:set', detail: `count = ${n}` });
  res.redirect(`${back}?msg=count-set`);
});

// Leveling: set a member's XP, or wipe the whole guild leaderboard.
router.post(
  '/:guildId/m/leveling/xp',
  asyncHandler(async (req, res) => {
    const back = `/guilds/${req.guild.id}/m/leveling`;
    if (req.body.reset === 'true') {
      resetGuildLeveling(req.guild.id);
      recordAudit(req.guild.id, { actor: moderatorDisplayName(req), action: 'leveling:reset', detail: 'all XP wiped' });
      return res.redirect(`${back}?msg=lvl-reset`);
    }
    const userId = parseUserId(req.body.userId);
    const xp = Number(req.body.xp);
    if (!userId || !Number.isInteger(xp) || xp < 0 || xp > 1e12) {
      return res.redirect(`${back}?msg=lvl-bad`);
    }
    setXp(req.guild.id, userId, xp);
    recordAudit(req.guild.id, { actor: moderatorDisplayName(req), action: 'leveling:setxp', detail: `${userId} → ${xp} XP` });

    // Reconcile reward roles for the new level (adds/strips per config).
    const cfg = normaliseLevelingConfig(getGuildModule(req.guild.id, 'leveling').config);
    const member = await req.guild.members.fetch(userId).catch(() => null);
    if (member) await syncRewards(member, levelFromXp(xp), cfg).catch(() => {});

    res.redirect(`${back}?msg=lvl-set`);
  })
);

// --- Reminders builder (MEE6-style) ----------------------------------

const REM_BASE = 'm/scheduled-messages';

function toMs(v) {
  const t = new Date(String(v ?? '')).getTime();
  return Number.isFinite(t) ? t : null;
}

function renderReminderBuilder(req, res, rec) {
  res.render('reminder-builder', {
    ...baseContext(req.guild, REM_BASE),
    channels: guildTextChannels(req.guild),
    roles: assignableRoles(req.guild),
    guildId: req.guild.id,
    schedulePresets: SCHEDULE_PRESETS,
    weekdays: WEEKDAYS,
    isNew: !rec,
    rec: rec || {
      id: '',
      name: '',
      channel_id: '',
      spec: { content: '', embeds: [] },
      mode: 'multiple',
      interval_minutes: 60,
      dayList: [0, 1, 2, 3, 4, 5, 6],
      start_at: null,
      end_at: null,
      run_at: null,
      enabled: 1,
    },
    msg: typeof req.query.msg === 'string' ? req.query.msg : null,
  });
}

router.get('/:guildId/m/scheduled-messages/r/new', (req, res) => renderReminderBuilder(req, res, null));

router.get('/:guildId/m/scheduled-messages/r/:id(\\d+)', (req, res) => {
  const rec = getScheduled(req.guild.id, Number(req.params.id));
  if (!rec) return res.redirect(`/guilds/${req.guild.id}/${REM_BASE}`);
  renderReminderBuilder(req, res, rec);
});

router.post(
  '/:guildId/m/scheduled-messages/r/:id(new|\\d+)',
  asyncHandler(async (req, res) => {
    const b = req.body;
    const existing = req.params.id === 'new' ? null : getScheduled(req.guild.id, Number(req.params.id));
    if (req.params.id !== 'new' && !existing) return res.redirect(`/guilds/${req.guild.id}/${REM_BASE}`);
    const back = `/guilds/${req.guild.id}/${REM_BASE}/r/${existing ? existing.id : 'new'}`;

    const channelId = /^\d{17,20}$/.test(b.channelId ?? '') ? b.channelId : '';
    if (!channelId) return res.redirect(`${back}?msg=badchannel`);

    let embed = null;
    if (b.msgType === 'embed') {
      try {
        embed = normaliseEmbedSpec(JSON.parse(b.embed || '{}'));
      } catch {
        embed = null;
      }
    }
    const spec = { content: String(b.content ?? '').slice(0, 2000), embeds: embed ? [embed] : [] };
    if (!spec.content.trim() && !spec.embeds.length) return res.redirect(`${back}?msg=rem-empty`);

    const mode = b.mode === 'single' ? 'single' : 'multiple';
    const intervalMinutes = Math.min(
      MAX_INTERVAL_MINUTES,
      Math.max(MIN_INTERVAL_MINUTES, Math.floor(Number(b.intervalMinutes) || 60))
    );
    const days = WEEKDAYS.map(([n]) => n).filter((n) => b[`day_${n}`] === 'on');
    const runAt = mode === 'single' ? toMs(b.runAt) : null;
    if (mode === 'single' && !runAt) return res.redirect(`${back}?msg=rem-when`);

    const data = {
      name: String(b.name ?? '').trim().slice(0, 100) || 'Untitled reminder',
      channelId,
      spec,
      mode,
      intervalMinutes,
      days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
      startAt: b.enableStart === 'on' ? toMs(b.startAt) : null,
      endAt: b.enableEnd === 'on' ? toMs(b.endAt) : null,
      runAt,
    };

    // "Send test message" — post the message now, don't save schedule changes.
    if (b.action === 'test') {
      try {
        await sendComposed(req.guild, channelId, spec);
        return res.redirect(`${back}${existing ? '' : ''}?msg=rem-test`);
      } catch (err) {
        return res.redirect(`${back}?msg=${encodeURIComponent(err.message).slice(0, 100)}`);
      }
    }

    let id;
    if (existing) {
      updateReminder(req.guild.id, existing.id, data);
      id = existing.id;
    } else {
      id = createReminder(req.guild.id, data);
    }
    recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:reminders',
      detail: `${existing ? 'updated' : 'created'} "${data.name}"`,
    });
    res.redirect(`/guilds/${req.guild.id}/${REM_BASE}/r/${id}?msg=saved`);
  })
);

router.post('/:guildId/m/scheduled-messages/r/:id(\\d+)/delete', (req, res) => {
  deleteScheduled(req.guild.id, Number(req.params.id));
  res.redirect(`/guilds/${req.guild.id}/${REM_BASE}?msg=saved`);
});

router.post('/:guildId/m/scheduled-messages/r/:id(\\d+)/toggle', (req, res) => {
  const rec = getScheduled(req.guild.id, Number(req.params.id));
  if (rec) setScheduledEnabled(req.guild.id, rec.id, rec.enabled !== 1);
  res.redirect(`/guilds/${req.guild.id}/${REM_BASE}?msg=saved`);
});

// --- Reaction-role builder (MEE6-style) ---------------------------------

function renderRrBuilder(req, res, rm) {
  res.render('rr-builder', {
    ...baseContext(req.guild, 'm/roles'),
    channels: guildTextChannels(req.guild),
    roles: assignableRoles(req.guild),
    guildId: req.guild.id,
    isNew: !rm,
    rm: rm || {
      id: '',
      channelId: '',
      messageId: '',
      message: 'React to this message to get your roles!',
      embed: { kind: 'embed', color: '#5865f2', description: 'React to this message to get your roles!' },
      exclusive: false,
      mode: 'default',
      pairs: [],
    },
  });
}

router.get('/:guildId/m/roles/rr/new', (req, res) => renderRrBuilder(req, res, null));

router.get('/:guildId/m/roles/rr/:id', (req, res) => {
  const list = getGuildModule(req.guild.id, 'roles').config.reactionMessages ?? [];
  renderRrBuilder(req, res, list.find((x) => String(x.id) === req.params.id) || null);
});

router.post(
  '/:guildId/m/roles/rr',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const back = `/guilds/${guild.id}/m/roles`;
    const cfg = getGuildModule(guild.id, 'roles').config;
    const list = Array.isArray(cfg.reactionMessages) ? cfg.reactionMessages : [];

    const channelId = /^\d{17,20}$/.test(req.body.channelId ?? '') ? req.body.channelId : '';
    if (!channelId) return res.redirect(`${back}?msg=badchannel`);

    let embed = {};
    try {
      embed = JSON.parse(req.body.embed || '{}');
    } catch {
      embed = {};
    }

    const emojis = [].concat(req.body.rr_emoji ?? []);
    const roleIds = [].concat(req.body.rr_role ?? []);
    const pairs = [];
    emojis.forEach((raw, i) => {
      const parsed = parseEmoji(raw, guild);
      if (parsed && /^\d{17,20}$/.test(roleIds[i] ?? '')) pairs.push({ ...parsed, roleId: roleIds[i] });
    });
    if (pairs.length === 0) return res.redirect(`${back}?msg=needpair`);

    const id = /^\d+$/.test(req.body.id ?? '') ? req.body.id : String(Date.now());
    const existing = list.find((x) => String(x.id) === id);
    const rm = {
      id,
      channelId,
      messageId: existing?.messageId || '',
      message: String(req.body.message ?? '').slice(0, 2000),
      embed: normaliseEmbedSpec(embed),
      exclusive: req.body.exclusive === 'on',
      mode: req.body.mode === 'reverse' ? 'reverse' : 'default',
      pairs,
    };

    let ok = false;
    try {
      rm.messageId = await publishReactionMessage(guild, rm);
      ok = true;
    } catch (err) {
      console.error('[roles] publish reaction message failed:', err.message);
    }

    const next = existing ? list.map((x) => (String(x.id) === id ? rm : x)) : [...list, rm];
    setGuildModule(guild.id, 'roles', { enabled: true, config: { ...cfg, reactionMessages: next } });
    recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:roles',
      detail: `${existing ? 'updated' : 'created'} reaction-role set`,
    });
    res.redirect(`${back}?msg=${ok ? 'saved' : 'rrfail'}`);
  })
);

router.post(
  '/:guildId/m/roles/rr/:id/delete',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const cfg = getGuildModule(guild.id, 'roles').config;
    const list = Array.isArray(cfg.reactionMessages) ? cfg.reactionMessages : [];
    const rm = list.find((x) => String(x.id) === req.params.id);
    if (rm?.messageId && rm.channelId) {
      const ch = guild.channels.cache.get(rm.channelId);
      const m = ch && (await ch.messages.fetch(rm.messageId).catch(() => null));
      if (m) await m.delete().catch(() => {});
    }
    setGuildModule(guild.id, 'roles', {
      config: { ...cfg, reactionMessages: list.filter((x) => String(x.id) !== req.params.id) },
    });
    res.redirect(`/guilds/${guild.id}/m/roles?msg=saved`);
  })
);

// --- Starboard builder (MEE6-style) -----------------------------------

function starboardBoards(guildId) {
  return normaliseStarboard(getGuildModule(guildId, 'starboard').config).boards;
}

function renderSbBuilder(req, res, board) {
  const emojiText = board
    ? board.emojis
        .map((e) => {
          if (!/^\d+$/.test(e)) return e;
          const ge = req.guild.emojis.cache.get(e);
          return ge ? ge.toString() : `<:emoji:${e}>`;
        })
        .join(' ')
    : '⭐';
  res.render('sb-builder', {
    ...baseContext(req.guild, 'm/starboard'),
    channels: guildTextChannels(req.guild),
    roles: assignableRoles(req.guild),
    guildId: req.guild.id,
    isNew: !board,
    emojiText,
    board: board || {
      id: '',
      name: 'Starboard',
      channelId: '',
      emojis: ['⭐'],
      threshold: 3,
      multiPerUser: false,
      autoReact: true,
      autoReactFirstOnly: false,
      removeOnUnstar: true,
      repostCooldown: false,
      removeOnDelete: true,
      ignoreSelfStars: true,
      removeSelfStarReactions: false,
      ignoreBotMessages: true,
      removeBotReactions: false,
      minAgeMinutes: 0,
      maxAgeMinutes: 0,
      roleMode: 'allow',
      roleList: [],
      channelMode: 'allow',
      channelList: [],
    },
  });
}

router.get('/:guildId/m/starboard/sb/new', (req, res) => renderSbBuilder(req, res, null));

router.get('/:guildId/m/starboard/sb/:id', (req, res) => {
  const board = starboardBoards(req.guild.id).find((b) => b.id === req.params.id);
  if (!board) return res.redirect(`/guilds/${req.guild.id}/m/starboard`);
  renderSbBuilder(req, res, board);
});

router.post('/:guildId/m/starboard/sb', (req, res) => {
  const back = `/guilds/${req.guild.id}/m/starboard`;
  const b = req.body;
  const channelId = /^\d{17,20}$/.test(b.channelId ?? '') ? b.channelId : '';
  if (!channelId) return res.redirect(`${back}?msg=badchannel`);

  const prev = normaliseStarboard(getGuildModule(req.guild.id, 'starboard').config);
  const list = prev.boards;
  const id = /^\d+$/.test(b.id ?? '') ? b.id : String(Date.now());
  const existing = list.find((x) => x.id === id);

  const board = {
    id,
    name: String(b.name ?? 'Starboard').slice(0, 60),
    channelId,
    emojis: String(b.emojis ?? '⭐'),
    threshold: b.threshold,
    multiPerUser: b.multiPerUser === 'on',
    autoReact: b.autoReact === 'on',
    autoReactFirstOnly: b.autoReactFirstOnly === 'on',
    removeOnUnstar: b.removeOnUnstar === 'on',
    repostCooldown: b.repostCooldown === 'on',
    removeOnDelete: b.removeOnDelete === 'on',
    ignoreSelfStars: b.ignoreSelfStars === 'on',
    removeSelfStarReactions: b.removeSelfStarReactions === 'on',
    ignoreBotMessages: b.ignoreBotMessages === 'on',
    removeBotReactions: b.removeBotReactions === 'on',
    minAgeMinutes: b.minAgeMinutes,
    maxAgeMinutes: b.maxAgeMinutes,
    roleMode: b.roleMode === 'deny' ? 'deny' : 'allow',
    roleList: [].concat(b.roleList ?? []).filter((r) => /^\d{17,20}$/.test(r)),
    channelMode: b.channelMode === 'deny' ? 'deny' : 'allow',
    channelList: [].concat(b.channelList ?? []).filter((c) => /^\d{17,20}$/.test(c)),
  };

  const nextBoards = existing ? list.map((x) => (x.id === id ? board : x)) : [...list, board];
  const config = normaliseStarboard({ boards: nextBoards });
  setGuildModule(req.guild.id, 'starboard', { enabled: true, config });
  recordAudit(req.guild.id, {
    actor: moderatorDisplayName(req),
    action: 'module:starboard',
    detail: `${existing ? 'updated' : 'created'} board "${board.name}"`,
  });

  // Catch up on messages that already clear the (possibly just-lowered) bar.
  const saved = config.boards.find((x) => x.id === id);
  if (saved) {
    rescanBoard(req.guild, saved)
      .then((r) => console.log(`[starboard] rescan ${req.guild.id}/${id}: scanned ${r.scanned}, posted ${r.posted}`))
      .catch((err) => console.error('[starboard] rescan failed:', err.message));
  }
  res.redirect(`${back}?msg=sb-saved`);
});

router.post('/:guildId/m/starboard/sb/:id/delete', (req, res) => {
  const prev = normaliseStarboard(getGuildModule(req.guild.id, 'starboard').config);
  const config = normaliseStarboard({ boards: prev.boards.filter((b) => b.id !== req.params.id) });
  setGuildModule(req.guild.id, 'starboard', { config });
  deleteBoardEntries(req.guild.id, req.params.id);
  recordAudit(req.guild.id, { actor: moderatorDisplayName(req), action: 'module:starboard', detail: 'deleted a board' });
  res.redirect(`/guilds/${req.guild.id}/m/starboard?msg=saved`);
});

// --- Custom-command builder (MEE6-style actions) ----------------------

function ccCommands(guildId) {
  return normaliseCustomCommands(getGuildModule(guildId, 'custom-commands').config).commands;
}

function renderCcBuilder(req, res, cmd) {
  res.render('cc-builder', {
    ...baseContext(req.guild, 'm/custom-commands'),
    channels: guildTextChannels(req.guild),
    roles: assignableRoles(req.guild),
    guildId: req.guild.id,
    ccPlaceholders: CC_PLACEHOLDERS,
    isNew: !cmd,
    cmd: cmd || {
      id: '',
      name: '',
      description: '',
      actions: [{ type: 'reply', private: false, messages: [{ content: '', embed: null }] }],
      allowedRoles: [],
      allowedChannels: [],
      cooldownSeconds: 0,
    },
  });
}

router.get('/:guildId/m/custom-commands/cmd/new', (req, res) => renderCcBuilder(req, res, null));

router.get('/:guildId/m/custom-commands/cmd/:id', (req, res) => {
  const cmd = ccCommands(req.guild.id).find((c) => c.id === req.params.id);
  if (!cmd) return res.redirect(`/guilds/${req.guild.id}/m/custom-commands`);
  renderCcBuilder(req, res, cmd);
});

router.post(
  '/:guildId/m/custom-commands/cmd',
  asyncHandler(async (req, res) => {
    const back = `/guilds/${req.guild.id}/m/custom-commands`;

    let actions = [];
    try {
      actions = JSON.parse(req.body.actions || '[]');
    } catch {
      return res.redirect(`${back}?msg=cc-bad`);
    }
    if (!Array.isArray(actions)) actions = [];

    const name = String(req.body.name ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) return res.redirect(`${back}?msg=cc-name`);
    if (runtime.client?.commands?.has(name)) return res.redirect(`${back}?msg=cc-reserved`);

    const prev = normaliseCustomCommands(getGuildModule(req.guild.id, 'custom-commands').config);
    const id = /^\d+$/.test(req.body.id ?? '') ? String(req.body.id) : String(Date.now());
    const existing = prev.commands.find((c) => c.id === id);
    if (prev.commands.some((c) => c.name === name && c.id !== id)) {
      return res.redirect(`${back}?msg=cc-dupe`);
    }

    const merged = {
      id,
      name,
      description: req.body.description ?? '',
      actions,
      allowedRoles: [].concat(req.body.allowedRoles ?? []),
      allowedChannels: [].concat(req.body.allowedChannels ?? []),
      cooldownSeconds: req.body.cooldownSeconds ?? 0,
    };
    const nextList = existing
      ? prev.commands.map((c) => (c.id === id ? merged : c))
      : [...prev.commands, merged];
    const config = normaliseCustomCommands({ commands: nextList });

    if (!config.commands.some((c) => c.id === id)) {
      // The command was dropped by normalisation — every action was empty.
      return res.redirect(`${back}?msg=cc-empty`);
    }

    setGuildModule(req.guild.id, 'custom-commands', { enabled: true, config });
    recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:custom-commands',
      detail: `${existing ? 'updated' : 'created'} /${name}`,
    });
    await syncGuildCustomCommands(req.guild).catch((err) =>
      console.error('[custom-commands] sync after save failed:', err.message)
    );
    res.redirect(`${back}?msg=saved`);
  })
);

router.post(
  '/:guildId/m/custom-commands/cmd/:id/delete',
  asyncHandler(async (req, res) => {
    const prev = normaliseCustomCommands(getGuildModule(req.guild.id, 'custom-commands').config);
    const config = normaliseCustomCommands({
      commands: prev.commands.filter((c) => c.id !== req.params.id),
    });
    setGuildModule(req.guild.id, 'custom-commands', { config });
    recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:custom-commands',
      detail: 'deleted a command',
    });
    await syncGuildCustomCommands(req.guild).catch((err) =>
      console.error('[custom-commands] sync after delete failed:', err.message)
    );
    res.redirect(`/guilds/${req.guild.id}/m/custom-commands?msg=saved`);
  })
);

// --- Actions -------------------------------------------------------------

// Lift a ban from the moderation panel.
router.post(
  '/:guildId/unban',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const back = `/guilds/${guild.id}/moderation`;
    const userId = parseUserId(req.body.userId);
    if (!userId) return res.redirect(`${back}?msg=baduser`);

    if (!guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
      return res.redirect(`${back}?msg=perms`);
    }
    const existing = await guild.bans.fetch(userId).catch(() => null);
    if (!existing) return res.redirect(`${back}?msg=notbanned`);

    await guild.bans.remove(userId, `${moderatorDisplayName(req)}: unbanned via dashboard`);

    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('Ban removed')
      .setDescription(`${existing.user.tag} (\`${existing.user.id}\`)`)
      .addFields({ name: 'Moderator', value: moderatorDisplayName(req) })
      .setTimestamp(Date.now());
    await postModLog(guild, embed);

    res.redirect(`${back}?msg=unbanned`);
  })
);

// Toggle a module on/off (JSON, called from app.js).
router.post('/:guildId/modules/:moduleId', (req, res) => {
  const mod = getModule(req.params.moduleId);
  if (!mod) return res.status(404).json({ error: 'Unknown module' });
  const enabled = Boolean(req.body?.enabled);
  setGuildModule(req.guild.id, mod.id, { enabled });
  recordAudit(req.guild.id, {
    actor: moderatorDisplayName(req),
    action: `module:${mod.id}`,
    detail: enabled ? 'enabled' : 'disabled',
  });
  if (mod.id === 'custom-commands') {
    syncGuildCustomCommands(req.guild).catch((err) =>
      console.error('[custom-commands] sync after toggle failed:', err.message)
    );
  }
  if (mod.id === 'invite-tracker' && enabled) {
    primeInviteCache(req.guild).catch((err) =>
      console.error('[invite-tracker] cache prime after enable failed:', err.message)
    );
  }
  res.json({ enabled });
});

// Invite tracker: nudge a member's bonus invites from the dashboard.
router.post('/:guildId/m/invite-tracker/bonus', (req, res) => {
  const back = `/guilds/${req.guild.id}/m/invite-tracker`;
  const userId = parseUserId(req.body.userId);
  const bonus = Number(req.body.bonus);
  if (!userId || !Number.isInteger(bonus) || bonus < -100000 || bonus > 100000) {
    return res.redirect(`${back}?msg=inv-bad`);
  }
  setBonus(req.guild.id, userId, bonus);
  recordAudit(req.guild.id, {
    actor: moderatorDisplayName(req),
    action: 'module:invite-tracker',
    detail: `${userId} bonus → ${bonus}`,
  });
  res.redirect(`${back}?msg=saved`);
});

// Download the guild's configuration as JSON (backup / "export my setup").
router.get('/:guildId/export', (req, res) => {
  const data = exportGuildConfig(req.guild.id);
  res.setHeader('Content-Disposition', `attachment; filename="sylo-${req.guild.id}-config.json"`);
  res.type('application/json').send(JSON.stringify(data, null, 2));
});

// Config change history.
router.get('/:guildId/audit', (req, res) => {
  res.render('guild', {
    ...baseContext(req.guild, 'audit'),
    audit: listAudit(req.guild.id, 150).map((a) => ({
      actor: a.actor,
      action: a.action,
      detail: a.detail,
      ago: timeAgo(a.created_at),
    })),
  });
});

router.post('/:guildId/general', (req, res) => {
  const guild = req.guild;
  const back = `/guilds/${guild.id}/general`;

  // Mod-log channel (empty = disabled).
  const channelId = String(req.body.modlogChannelId ?? '').trim();
  if (channelId === '') {
    setModlogChannel(guild.id, null);
    recordAudit(guild.id, { actor: moderatorDisplayName(req), action: 'settings:modlog', detail: 'disabled' });
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
  recordAudit(guild.id, { actor: moderatorDisplayName(req), action: 'settings:modlog', detail: `#${channel.name}` });
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

  const on = req.body.enabled === 'on' || req.body.enabled === 'true';
  setCommandOverride(guild.id, command, {
    enabled: on,
    allowedChannels: toIds(req.body.channels),
    allowedRoles: toIds(req.body.roles),
  });
  recordAudit(guild.id, {
    actor: moderatorDisplayName(req),
    action: `command:/${command}`,
    detail: on ? 'updated limits' : 'disabled',
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
    await applyWarnThresholds(guild, user, count, moderatorDisplayName(req));
    res.redirect(`${back}?msg=${logged ? 'warned' : 'warned-nolog'}`);
  })
);

export default router;
