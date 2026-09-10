// Per-guild control panel: module toggles, general settings, command
// management, and the moderation panel (warnings + bans). Every route requires
// the signed-in user to be an admin of that guild (pass-through in open mode).
import { Router } from 'express';
import { PermissionFlagsBits, EmbedBuilder, ChannelType } from 'discord.js';
import { runtime } from '../../runtime.js';
import { requireGuildAdmin, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getGuild, baseContext, assignableRoles } from '../lib/guildContext.js';
import { guildTextChannels, guildVoiceChannels, guildCategories, resolveUserTags } from '../lib/discord.js';
import { getModule, missingIntents } from '../../modules/registry.js';
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
import {
  listGuildCases,
  getCase,
  editCaseReason,
  setCaseActive,
  addWarning,
  clearWarnings,
} from '../../db/modCases.js';
import { notifyTarget, MOD_COLOR } from '../../bot/lib/moderation.js';
import { postModLog } from '../../bot/lib/modlog.js';
import { timeAgo } from '../lib/format.js';
import { LOG_EVENTS } from '../../modules/logging.js';
import { WELCOME_PLACEHOLDERS } from '../../modules/welcome.js';
import { applyWarnThresholds, normaliseThresholds, THRESHOLD_ACTIONS } from '../../modules/moderation.js';
import {
  normaliseAutomodConfig,
  AUTOMOD_RULES,
  AUTOMOD_ACTIONS,
  NATIVE_MAPPABLE,
  PRESET_KEYS,
} from '../../modules/automod.js';
import { syncGuildAutomod } from '../../bot/lib/automodSync.js';
import { parseEmoji, publishReactionMessage } from '../../modules/roles.js';
import {
  activeGiveaways,
  endedGiveaways,
  giveawayEntryCount,
  getGiveawayInGuild,
} from '../../db/giveaways.js';
import { normaliseGiveawaysConfig, endGiveaway } from '../../modules/giveaways.js';
import { normaliseBirthdaysConfig } from '../../modules/birthdays.js';
import { recentLookups } from '../../db/cache.js';
import { getVanitySlug, setVanitySlug, clearVanitySlug } from '../../db/leaderboardVanity.js';
import { normaliseEmbedSpec } from '../../modules/welcomeChannel.js';
import { getCounting, setCount, resetCount } from '../../db/counting.js';
import { listCountingPenalties, clearCountingPenalty } from '../../db/countingPenalties.js';
import { normaliseCustomCommands, CC_PLACEHOLDERS } from '../../modules/customCommands.js';
import { normaliseAutoresponder, AR_MATCH_MODES, AR_PLACEHOLDERS } from '../../modules/autoresponder.js';
import {
  normaliseVerificationConfig,
  VERIFY_MODES,
  ensureVerifyMessage,
} from '../../modules/verification.js';
import { normaliseServerStats, STAT_TYPES } from '../../modules/serverStats.js';
import { normaliseAppealsConfig, decideAndNotify } from '../../modules/appeals.js';
import { normaliseTempVoiceConfig } from '../../modules/tempVoice.js';
import { normaliseStarboard, rescanBoard } from '../../modules/starboard.js';
import { deleteBoardEntries } from '../../db/starboard.js';
import { normaliseInviteTrackerConfig, primeGuild as primeInviteCache } from '../../modules/inviteTracker.js';
import { topInviters, inviterCount, setBonus } from '../../db/inviteTracker.js';
import { normalisePollsConfig } from '../../modules/polls.js';
import {
  normaliseTwitchConfig,
  DEFAULT_MESSAGE as TWITCH_DEFAULT_MESSAGE,
} from '../../modules/twitchAlerts.js';
import { normaliseKickConfig, DEFAULT_MESSAGE as KICK_DEFAULT_MESSAGE } from '../../modules/kickAlerts.js';
import { normaliseRssConfig, DEFAULT_TEMPLATE as RSS_DEFAULT_TEMPLATE } from '../../modules/rss.js';
import { clearScope } from '../../db/postedKeys.js';
import {
  normaliseYoutubeConfig,
  resolveYtChannel,
  DEFAULT_VIDEO_MESSAGE as YT_VIDEO_MSG,
  DEFAULT_LIVE_MESSAGE as YT_LIVE_MSG,
} from '../../modules/youtubeAlerts.js';
import {
  WC_PRESETS,
  normaliseWelcomeChannelConfig,
  publishWelcome,
  unpublishWelcome,
  createWelcomeChannel,
} from '../../modules/welcomeChannel.js';
import { listAppeals, getAppeal } from '../../db/appeals.js';
import { config as appConfig } from '../../config.js';
import { log } from '../../lib/log.js';
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
import {
  topMembers,
  memberCount,
  topMembersForPeriod,
  memberCountForPeriod,
  periodKeys,
  setXp,
  resetGuildLeveling,
} from '../../db/leveling.js';
import { recordAudit, listAudit } from '../../db/audit.js';
import { dailySeries, hourlySeries, topChannels, topVoiceChannels } from '../../db/insights.js';
import { flushGuild as flushGuildInsights } from '../../modules/insights.js';
import { forgetUser, describeUserData } from '../../db/purge.js';
import {
  guildChannelLocks,
  lockdownChannelLocks,
  isChannelLocked,
  clearChannelLock,
} from '../../db/channelLocks.js';
import { guildTempBans, clearTempBan } from '../../db/tempBans.js';
import { lockChannel, unlockChannel, lockPreflight } from '../../bot/lib/channelLock.js';
import { formatDuration } from '../../bot/lib/duration.js';
import { renderWelcomeCard } from '../../bot/lib/welcomeCard.js';
import { TESTABLE, sendModuleTest } from '../../bot/lib/moduleTest.js';
import { exportGuildConfig } from '../../db/exportConfig.js';
import { buildOverview } from '../lib/overviewSummary.js';
import { moduleIcon } from '../lib/moduleIcons.js';
import {
  listCleanupSchedules,
  getCleanupSchedule,
  createCleanupSchedule,
  updateCleanupSchedule,
  deleteCleanupSchedule,
  setCleanupScheduleEnabled,
} from '../../db/channelCleanup.js';

const router = Router();

// Module ids that have a real settings partial (views/guild/modules/<id>.ejs).
const CONFIG_VIEWS = new Set([
  'moderation',
  'logging',
  'welcome',
  'birthdays',
  'roles',
  'sticky',
  'tickets',
  'automod',
  'counting',
  'custom-commands',
  'reminders',
  'leveling',
  'autoresponder',
  'verification',
  'afk',
  'server-stats',
  'free-games',
  'appeals',
  'temp-voice',
  'welcome-channel',
  'starboard',
  'invite-tracker',
  'polls',
  'twitch-alerts',
  'youtube-alerts',
  'kick-alerts',
  'rss',
  'giveaways',
  'game-stats',
  'channel-cleanup',
]);
const BAN_DISPLAY_LIMIT = 200;
const WEB_MODERATOR = 'web';
// Tab ids for the Moderator page's CSS radio tabs; `?tab=` selects one on load
// so a POST that redirects back doesn't always snap to the first tab.
const MOD_TABS = ['automod', 'actions', 'admin', 'infr', 'log', 'cmd'];

function webModeratorId(req) {
  return currentUser(req)?.id ?? WEB_MODERATOR;
}
function moderatorDisplayName(req) {
  return currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`;
}
function parseUserId(raw) {
  const m = String(raw ?? '')
    .trim()
    .match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/);
  return m ? m[1] || m[2] : null;
}
// A data-retention "delete after N days" field: 0 (or junk) means keep forever.
function clampDays(raw) {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : 0;
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

router.get(
  '/:guildId/overview',
  asyncHandler(async (req, res) => {
    res.render('guild', {
      ...(await baseContext(req.guild, 'overview')),
      overview: await buildOverview(req.guild),
      msg: typeof req.query.msg === 'string' ? req.query.msg : null,
    });
  })
);

// Old bookmark → the renamed Settings panel.
router.get('/:guildId/general', (req, res) => res.redirect(`/guilds/${req.guild.id}/settings`));

router.get(
  '/:guildId/settings',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const settings = await getGuildSettings(guild.id);
    const color = await guildEmbedColor(guild.id);

    const roleView = (r) => ({ id: r.id, name: r.name, color: r.hexColor === '#000000' ? null : r.hexColor });
    const usable = [...guild.roles.cache.values()]
      .filter((r) => r.id !== guild.id && !r.managed)
      .sort((a, b) => b.position - a.position);
    const adminRoles = usable.filter((r) => r.permissions.has(PermissionFlagsBits.Administrator));
    const adminIds = new Set(adminRoles.map((r) => r.id));
    const stored = (await getBotMasterRoles(guild.id)).filter((id) => !adminIds.has(id));
    const storedSet = new Set(stored);

    res.render('guild', {
      ...(await baseContext(guild, 'settings')),
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
  })
);

router.post(
  '/:guildId/settings',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const back = `/guilds/${guild.id}/settings`;

    // Mod-log channel (empty = off).
    const channelId = String(req.body.modlogChannelId ?? '').trim();
    if (channelId === '') {
      await setModlogChannel(guild.id, null);
    } else if (guildTextChannels(guild).some((c) => c.id === channelId)) {
      await setModlogChannel(guild.id, channelId);
    } else {
      return res.redirect(`${back}?msg=badchannel`);
    }

    // Bot masters.
    await setBotMasterRoles(guild.id, [].concat(req.body.botMasterRoles ?? []));

    // Default embed colour.
    const hex = String(req.body.embedColor ?? '').replace('#', '');
    if (req.body.embedColorReset === 'on' || hex === '') await setEmbedColor(guild.id, null);
    else if (/^[0-9a-fA-F]{6}$/.test(hex)) await setEmbedColor(guild.id, parseInt(hex, 16));

    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: 'settings:server',
      detail: 'saved',
    });
    res.redirect(`${back}?msg=saved`);
  })
);

// --- Member data (data-subject requests) ---------------------------------

/** Fetch a Discord user's tag + avatar for display; falls back to the raw id. */
async function lookupProfile(userId) {
  try {
    const u = await runtime.client.users.fetch(userId);
    return { id: u.id, tag: u.tag, avatar: u.displayAvatarURL({ size: 64, extension: 'png' }) };
  } catch {
    return { id: userId, tag: null, avatar: null };
  }
}

const MEMBER_DATA_UNAFFECTED =
  'Messages already posted to channels, a completed giveaway’s winner list, and the server’s config-change log are not affected.';

router.get(
  '/:guildId/member-data',
  asyncHandler(async (req, res) => {
    const raw = String(req.query.user ?? '').trim();
    const userId = raw ? parseUserId(raw) : null;
    let lookup = null;
    if (raw && !userId) {
      lookup = { error: 'notanid', raw };
    } else if (userId) {
      lookup = {
        profile: await lookupProfile(userId),
        data: await describeUserData(req.guild.id, userId),
      };
    }
    res.render('guild', {
      ...(await baseContext(req.guild, 'member-data')),
      lookup,
      msg: typeof req.query.msg === 'string' ? req.query.msg : null,
    });
  })
);

router.post(
  '/:guildId/member-data/forget',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const userId = parseUserId(req.body.userId);
    const reason = String(req.body.reason ?? '')
      .trim()
      .slice(0, 500);
    const back = `/guilds/${guild.id}/member-data`;

    if (!userId) return res.redirect(`${back}?msg=md-baduser`);
    if (req.body.confirm !== 'on') return res.redirect(`${back}?user=${userId}&msg=noconfirm`);

    const r = await forgetUser(guild.id, userId);

    const dm = new EmbedBuilder()
      .setColor(0x58d68d)
      .setTitle(`Your data in ${guild.name} was deleted`)
      .setDescription(
        'A server administrator deleted the data Sylo had stored about you in this server, at your request.'
      )
      .addFields(
        { name: 'Moderation cases', value: String(r.warnings), inline: true },
        { name: 'Leveling record', value: String(r.leveling), inline: true },
        { name: 'Tickets', value: `${r.tickets} (${r.ticketMessages} msgs)`, inline: true },
        { name: 'Ban appeals', value: String(r.appeals), inline: true },
        { name: 'AFK status', value: String(r.afk), inline: true },
        { name: 'Saved birthday', value: String(r.birthdays), inline: true },
        { name: 'Giveaway entries', value: String(r.giveawayEntries), inline: true },
        { name: 'Invite records', value: String(r.invites), inline: true },
        { name: 'Not affected', value: MEMBER_DATA_UNAFFECTED }
      )
      .setTimestamp(Date.now());
    if (reason) dm.addFields({ name: 'Note from staff', value: reason });

    const dmDelivered = await runtime.client.users
      .fetch(userId)
      .then((u) => u.send({ embeds: [dm] }))
      .then(() => true)
      .catch(() => false);

    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: 'privacy:member-data',
      detail: `deleted data for ${userId}${reason ? ` — ${reason}` : ''}${dmDelivered ? '' : ' (DM failed)'}`,
    });

    res.redirect(`${back}?user=${userId}&msg=${dmDelivered ? 'forgot' : 'forgot-nodm'}`);
  })
);

router.get(
  '/:guildId/commands',
  asyncHandler(async (req, res) => {
    const overrides = await getCommandOverrides(req.guild.id);
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
      ...(await baseContext(req.guild, 'commands')),
      commands,
      roles,
      msg: typeof req.query.msg === 'string' ? req.query.msg : null,
    });
  })
);

router.get(
  '/:guildId/moderation',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const { rows: caseRows, total: caseTotal } = await listGuildCases(guild.id, 200);
    const tags = await resolveUserTags(
      runtime.client,
      caseRows.flatMap((c) => [c.user_id, c.moderator_id]).filter((id) => /^\d+$/.test(id))
    );
    const modLabels = { web: 'Dashboard', automod: 'AutoMod', auto: 'auto-threshold', '': 'system' };
    const cases = caseRows.map((c) => ({
      caseNumber: c.case_number,
      action: c.action,
      active: c.active === 1,
      user: tags.get(c.user_id) ?? c.user_id,
      userId: c.user_id,
      moderator:
        c.moderator_id === WEB_MODERATOR
          ? 'Dashboard'
          : (modLabels[c.moderator_id] ?? tags.get(c.moderator_id) ?? c.moderator_id),
      reason: c.reason,
      detail: c.detail,
      ago: timeAgo(c.created_at),
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

    const overrides = await getCommandOverrides(guild.id);
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

    const channelLocks = (await guildChannelLocks(guild.id)).map((r) => ({
      channelId: r.channel_id,
      name: guild.channels.cache.get(r.channel_id)?.name ?? null,
      lockedBy: r.locked_by,
      lockdown: r.lockdown === 1,
      ago: timeAgo(r.locked_at),
    }));
    const tbRows = await guildTempBans(guild.id);
    const tbTags = await resolveUserTags(
      runtime.client,
      tbRows.map((r) => r.user_id)
    );
    const now = Date.now();
    const tempBans = tbRows.map((r) => ({
      userId: r.user_id,
      tag: tbTags.get(r.user_id) ?? r.user_id,
      reason: r.reason,
      remaining: r.unban_at > now ? formatDuration(r.unban_at - now) : 'any moment now',
    }));

    res.render('guild', {
      ...(await baseContext(guild, 'moderation')),
      cases,
      caseTotal,
      caseShown: cases.length,
      bans,
      bansTotal,
      bansShown: bans.length,
      bansError,
      banLimit: BAN_DISPLAY_LIMIT,
      channelLocks,
      tempBans,
      lockdownActive: channelLocks.some((l) => l.lockdown),
      automodConfig: (await getGuildModule(guild.id, 'automod')).config,
      moderationCfg: (await getGuildModule(guild.id, 'moderation')).config,
      loggingCfg: (await getGuildModule(guild.id, 'logging')).config,
      commands,
      roles: assignableRoles(guild),
      automodRules: AUTOMOD_RULES,
      thresholdActions: THRESHOLD_ACTIONS,
      logEvents: LOG_EVENTS,
      modTab: MOD_TABS.includes(req.query.tab) ? req.query.tab : 'automod',
      msg: typeof req.query.msg === 'string' ? req.query.msg : null,
    });
  })
);

// Ban appeals review panel: open submissions + recent decisions.
router.get(
  '/:guildId/appeals',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const rows = await listAppeals(guild.id, 100);
    const cfg = normaliseAppealsConfig((await getGuildModule(guild.id, 'appeals')).config);
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
      ...(await baseContext(guild, 'appeals')),
      appeals,
      appealsOpen: appeals.filter((a) => a.status === 'open').length,
      appealsModuleEnabled: (await getGuildModule(guild.id, 'appeals')).enabled,
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
    const appeal = await getAppeal(guild.id, req.params.id);
    if (!appeal || appeal.status !== 'open') return res.redirect(`${back}?msg=appeal-gone`);

    const decision =
      req.body.decision === 'accept' ? 'accepted' : req.body.decision === 'deny' ? 'denied' : null;
    if (!decision) return res.redirect(`${back}?msg=appeal-bad`);
    const reason =
      String(req.body.reason ?? '')
        .trim()
        .slice(0, 1000) || 'No reason given';

    const result = await decideAndNotify(guild, appeal, {
      status: decision,
      decidedBy: moderatorDisplayName(req),
      reason,
    });
    if (!result.recorded) return res.redirect(`${back}?msg=appeal-gone`);

    await recordAudit(guild.id, {
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
    const { enabled, config } = await getGuildModule(guild.id, 'leveling');
    const cfg = normaliseLevelingConfig(config);
    const period = ['week', 'month'].includes(req.query.period) ? req.query.period : 'all';
    const keys = periodKeys();
    const rows =
      period === 'all'
        ? await topMembers(guild.id, 10)
        : await topMembersForPeriod(guild.id, keys[period], 10);
    const total =
      period === 'all' ? await memberCount(guild.id) : await memberCountForPeriod(guild.id, keys[period]);
    const tags = await resolveUserTags(
      runtime.client,
      rows.map((r) => r.user_id)
    );
    res.render('guild', {
      ...(await baseContext(guild, 'leaderboard')),
      levelingEnabled: enabled,
      publicLeaderboard: cfg.publicLeaderboard,
      leaderboardPeriod: period,
      vanitySlug: await getVanitySlug(guild.id),
      vanityBase: (appConfig.dashboardUrl ? appConfig.dashboardUrl.replace(/\/+$/, '') : '') + '/lb/',
      board: {
        total,
        rows: rows.map((r, i) => ({
          rank: i + 1,
          name: tags.get(r.user_id) ?? r.user_id,
          level: period === 'all' ? r.level : null,
          xp: r.xp,
          voiceXp: r.voice_xp ?? 0,
          voiceMinutes: r.voice_minutes ?? 0,
          messages: r.messages,
        })),
      },
      msg: typeof req.query.msg === 'string' ? req.query.msg : null,
    });
  })
);

// Flip only the public-leaderboard flag on the leveling module.
router.post(
  '/:guildId/leaderboard/public',
  asyncHandler(async (req, res) => {
    const prev = (await getGuildModule(req.guild.id, 'leveling')).config;
    const publicLeaderboard = req.body.publicLeaderboard === 'on';
    await setGuildModule(req.guild.id, 'leveling', { config: { ...prev, publicLeaderboard } });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'leveling:leaderboard',
      detail: publicLeaderboard ? 'made public' : 'made private',
    });
    res.redirect(`/guilds/${req.guild.id}/leaderboard?msg=saved`);
  })
);

// Vanity URL for the public leaderboard (blank slug clears it).
router.post(
  '/:guildId/leaderboard/vanity',
  asyncHandler(async (req, res) => {
    const back = `/guilds/${req.guild.id}/leaderboard`;
    const raw = String(req.body.slug ?? '').trim();
    if (raw === '') {
      await clearVanitySlug(req.guild.id);
      await recordAudit(req.guild.id, {
        actor: moderatorDisplayName(req),
        action: 'leveling:vanity',
        detail: 'cleared',
      });
      return res.redirect(`${back}?msg=vanity-cleared`);
    }
    const r = await setVanitySlug(req.guild.id, raw);
    if (!r.ok) return res.redirect(`${back}?msg=vanity-${r.error}`);
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'leveling:vanity',
      detail: `/lb/${r.slug}`,
    });
    res.redirect(`${back}?msg=vanity-set`);
  })
);

// Moderator → Admin tab: immunity roles (patch just automod's exemptRoles).
router.post(
  '/:guildId/m/automod/immunity',
  asyncHandler(async (req, res) => {
    const prev = (await getGuildModule(req.guild.id, 'automod')).config;
    const roles = [].concat(req.body.immunityRoles ?? []).filter((r) => /^\d{17,20}$/.test(r));
    await setGuildModule(req.guild.id, 'automod', {
      config: normaliseAutomodConfig({ ...prev, exemptRoles: roles }),
    });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:automod',
      detail: `immunity roles (${roles.length})`,
    });
    if (req.get('HX-Request')) {
      return res
        .status(204)
        .set('HX-Trigger', JSON.stringify({ toast: { msg: 'Immunity roles saved', kind: 'ok' } }))
        .end();
    }
    res.redirect(`/guilds/${req.guild.id}/moderation?msg=saved`);
  })
);

// Welcome: a PNG preview of the welcome image, using a sample member and the
// saved background. Cheap enough to render on demand; browser-cached via the
// ?v= cache-buster the view appends.
router.get(
  '/:guildId/m/welcome/card-preview',
  asyncHandler(async (req, res) => {
    const cfg = (await getGuildModule(req.guild.id, 'welcome')).config || {};
    const png = await renderWelcomeCard({
      name: 'New Member',
      avatarUrl: runtime.client?.user?.displayAvatarURL({ extension: 'png', size: 256 }),
      memberCount: req.guild.memberCount || 0,
      accent: await guildEmbedColor(req.guild.id),
      backgroundUrl: cfg.cardBackground || undefined,
    });
    if (!png) return res.status(204).end(); // canvas unavailable on this host
    res.set('Cache-Control', 'private, max-age=60').type('png').send(png);
  })
);

// Welcome Channel: create a read-only #welcome channel.
router.post(
  '/:guildId/m/welcome-channel/create-channel',
  asyncHandler(async (req, res) => {
    const back = `/guilds/${req.guild.id}/m/welcome-channel`;
    const r = await createWelcomeChannel(req.guild);
    if (!r.ok) return res.redirect(`${back}?msg=wc-fail`);
    const cfg = normaliseWelcomeChannelConfig((await getGuildModule(req.guild.id, 'welcome-channel')).config);
    await setGuildModule(req.guild.id, 'welcome-channel', { config: { ...cfg, channelId: r.channelId } });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:welcome-channel',
      detail: 'created #welcome',
    });
    res.redirect(`${back}?msg=wc-channel`);
  })
);

// Welcome Channel: remove the published message.
router.post(
  '/:guildId/m/welcome-channel/unpublish',
  asyncHandler(async (req, res) => {
    const back = `/guilds/${req.guild.id}/m/welcome-channel`;
    const cfg = normaliseWelcomeChannelConfig((await getGuildModule(req.guild.id, 'welcome-channel')).config);
    await unpublishWelcome(req.guild, cfg);
    await setGuildModule(req.guild.id, 'welcome-channel', { config: { ...cfg, messageId: '' } });
    res.redirect(`${back}?msg=wc-unpub`);
  })
);

// Full render context for a module's settings panel. Shared by the GET page,
// the htmx fragment render, and the config-POST re-render — so every module
// partial can read what it needs straight from locals (no per-include passthrough).
async function moduleViewLocals(mod, req, configOverride) {
  const { enabled, config } = await getGuildModule(req.guild.id, mod.id);
  const hasView = CONFIG_VIEWS.has(mod.id);
  // The temp-voice view renders each hub's id straight into an Edit/Delete URL;
  // a hub saved by an older build can lack `id`, producing an empty path
  // segment and a 404. Normalise on read so every hub has an id + defaults.
  const viewConfig = mod.id === 'temp-voice' ? normaliseTempVoiceConfig(config) : config;
  const cleanupRows = mod.id === 'channel-cleanup' ? await listCleanupSchedules(req.guild.id) : [];
  const levelingOverrides = mod.id === 'leveling' ? await getCommandOverrides(req.guild.id) : null;
  return {
    ...(await baseContext(req.guild, `m/${mod.id}`)),
    activeModule: mod,
    moduleIconName: moduleIcon(mod.id),
    moduleEnabled: enabled,
    moduleTestable: enabled && TESTABLE.has(mod.id),
    moduleConfig: configOverride ?? viewConfig,
    configView: hasView ? `guild/modules/${mod.id}` : 'guild/modules/stub',
    configPartialRel: hasView ? `modules/${mod.id}` : 'modules/stub',
    logEvents: LOG_EVENTS,
    welcomePlaceholders: WELCOME_PLACEHOLDERS,
    thresholdActions: THRESHOLD_ACTIONS,
    modlogChannelId: (await getGuildSettings(req.guild.id))?.modlog_channel_id ?? '',
    roles: [
      'roles',
      'tickets',
      'automod',
      'leveling',
      'autoresponder',
      'verification',
      'free-games',
      'welcome',
      'birthdays',
      'starboard',
      'polls',
      'twitch-alerts',
      'youtube-alerts',
      'kick-alerts',
      'rss',
      'giveaways',
      'counting',
    ].includes(mod.id)
      ? assignableRoles(req.guild)
      : [],
    welcomeAutoroles:
      mod.id === 'welcome' ? ((await getGuildModule(req.guild.id, 'roles')).config.autoroles ?? []) : [],
    verificationEnabled:
      mod.id === 'welcome' ? (await getGuildModule(req.guild.id, 'verification')).enabled : false,
    wcPresets:
      mod.id === 'welcome-channel'
        ? WC_PRESETS.map((p) => ({ id: p.id, label: p.label, kind: p.kind, defaults: p.make() }))
        : [],
    automodRules: AUTOMOD_RULES,
    automodActions: AUTOMOD_ACTIONS,
    nativeMappable: NATIVE_MAPPABLE,
    presetKeys: PRESET_KEYS,
    verifyModes: VERIFY_MODES,
    turnstileEnabled: appConfig.turnstileEnabled,
    twitchEnabled: appConfig.twitchEnabled,
    twitchDefaultMessage: TWITCH_DEFAULT_MESSAGE,
    kickEnabled: appConfig.kickEnabled,
    kickDefaultMessage: KICK_DEFAULT_MESSAGE,
    rssDefaultTemplate: RSS_DEFAULT_TEMPLATE,
    ytVideoMessage: YT_VIDEO_MSG,
    ytLiveMessage: YT_LIVE_MSG,
    dashboardUrlSet: Boolean(appConfig.dashboardUrl),
    voiceChannels: ['server-stats', 'temp-voice'].includes(mod.id) ? guildVoiceChannels(req.guild) : [],
    categories: mod.id === 'temp-voice' ? guildCategories(req.guild) : [],
    statTypes: STAT_TYPES,
    countingState: mod.id === 'counting' ? await getCounting(req.guild.id) : null,
    countingPenalties:
      mod.id === 'counting'
        ? (await listCountingPenalties(req.guild.id)).map((p) => ({
            userId: p.user_id,
            label: req.guild.members.cache.get(p.user_id)?.user.tag ?? p.user_id,
            roleName: req.guild.roles.cache.get(p.role_id)?.name ?? p.role_id,
            restoreAt: Number(p.restore_at),
          }))
        : [],
    ccPlaceholders: CC_PLACEHOLDERS,
    arPlaceholders: AR_PLACEHOLDERS,
    arMatchModes: AR_MATCH_MODES,
    reminders:
      mod.id === 'reminders'
        ? (await listScheduled(req.guild.id)).map((j) => ({
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
    cleanupSchedules: cleanupRows.map((s) => ({
      id: s.id,
      channel: guildTextChannels(req.guild).find((c) => c.id === s.channel_id)?.name ?? s.channel_id,
      dayList: s.dayList,
      time: s.time_hhmm,
      maxAgeHours: s.max_age_hours,
      skipPinned: s.skip_pinned === 1,
      enabled: s.enabled === 1,
      lastRunDate: s.last_run_date,
      lastRunCount: s.last_run_count,
    })),
    schedulePresets: SCHEDULE_PRESETS,
    announceModes: ANNOUNCE_MODES,
    xpRates: XP_RATES,
    levelingCommands:
      mod.id === 'leveling'
        ? ['rank', 'leaderboard']
            .map((name) => {
              const cmd = runtime.client?.commands?.get(name);
              if (!cmd) return null;
              const ov = levelingOverrides.get(name);
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
    levelingBoard:
      mod.id === 'leveling'
        ? {
            total: await memberCount(req.guild.id),
            rows: (await topMembers(req.guild.id, 15)).map((r, i) => ({
              rank: i + 1,
              userId: r.user_id,
              level: r.level,
              xp: r.xp,
              voiceXp: r.voice_xp,
              voiceMinutes: r.voice_minutes,
              messages: r.messages,
            })),
          }
        : null,
    inviteBoard:
      mod.id === 'invite-tracker'
        ? {
            total: await inviterCount(req.guild.id),
            canReadInvites: Boolean(req.guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)),
            rows: (await topInviters(req.guild.id, 15)).map((r, i) => ({
              rank: i + 1,
              userId: r.user_id,
              net: r.net,
              regular: r.regular,
              leaves: r.leaves,
              bonus: r.bonus,
            })),
          }
        : null,
    gameStatsRecent:
      mod.id === 'game-stats'
        ? (await recentLookups(15)).map((r) => ({
            game: r.game,
            title: r.title,
            username: r.username,
            platform: r.platform,
            ago: timeAgo(r.created_at),
          }))
        : [],
    giveaways:
      mod.id === 'giveaways'
        ? await Promise.all(
            [
              ...(await activeGiveaways(req.guild.id)).map((g) => ({ ...g, state: 'active' })),
              ...(await endedGiveaways(req.guild.id, 8)).map((g) => ({ ...g, state: 'ended' })),
            ].map(async (g) => ({
              id: g.id,
              prize: g.prize,
              state: g.state,
              winners: g.winners,
              endsAt: g.ends_at,
              entries: await giveawayEntryCount(g.id),
              wonIds: g.wonIds,
              channel: guildTextChannels(req.guild).find((c) => c.id === g.channel_id)?.name ?? g.channel_id,
              requiredRoleId: g.required_role_id,
            }))
          )
        : [],
    msg: typeof req.query.msg === 'string' ? req.query.msg : null,
  };
}

router.get(
  '/:guildId/m/:moduleId',
  asyncHandler(async (req, res) => {
    const mod = getModule(req.params.moduleId);
    if (!mod) return res.redirect(`/guilds/${req.guild.id}/overview`);
    const locals = await moduleViewLocals(mod, req);
    // A bare htmx GET (explicit hx-get to #module-config) wants just the panel;
    // an hx-boost navigation (HX-Boosted) is a full-page swap and needs the whole
    // document.
    if (req.get('HX-Request') && !req.get('HX-Boosted')) {
      return res.render('guild/_module-config', locals);
    }
    res.render('guild', locals);
  })
);

// Send a representative test message for a module to its configured channel.
router.post(
  '/:guildId/m/:moduleId/test',
  asyncHandler(async (req, res) => {
    const id = req.params.moduleId;
    const back = `/guilds/${req.guild.id}/m/${id}`;
    const r = TESTABLE.has(id) ? await sendModuleTest(req.guild, id) : { ok: false, reason: 'no-channel' };

    const toast = r.ok
      ? { msg: `Test sent to #${r.channelName}`, kind: 'ok' }
      : {
          msg:
            r.reason === 'no-channel'
              ? 'Set a channel for this module first.'
              : 'Send failed — check the bot has access to that channel.',
          kind: 'bad',
        };
    if (req.get('HX-Request')) {
      return res.status(204).set('HX-Trigger', JSON.stringify({ toast })).end();
    }
    const msg = r.ok ? 'test-sent' : r.reason === 'no-channel' ? 'test-nochan' : 'test-fail';
    res.redirect(`${back}?msg=${msg}`);
  })
);

// Save a module's settings.
router.post(
  '/:guildId/m/:moduleId/config',
  asyncHandler(async (req, res) => {
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
        infractionRetentionDays: clampDays(req.body.infractionRetentionDays),
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
      const cardBg = String(req.body.cardBackground ?? '').trim();
      config = {
        joinChannel: joinOn ? chan(req.body.joinChannel) : '',
        joinMessage: joinOn ? String(req.body.joinMessage ?? '').slice(0, 1500) : '',
        leaveChannel: leaveOn ? chan(req.body.leaveChannel) : '',
        leaveMessage: leaveOn ? String(req.body.leaveMessage ?? '').slice(0, 1500) : '',
        dmMessage: dmOn ? String(req.body.dmMessage ?? '').slice(0, 1500) : '',
        useEmbed: req.body.useEmbed === 'on',
        card: req.body.enable_card === 'on',
        cardBackground: /^https:\/\/\S+$/i.test(cardBg) ? cardBg.slice(0, 500) : '',
      };
      // "Give roles to new members" here writes the Reaction roles & autoroles module.
      const autoOn = req.body.enable_autorole === 'on';
      const newRoles = autoOn ? [].concat(req.body.newRoles ?? []).filter((r) => /^\d{17,20}$/.test(r)) : [];
      const rolesMod = await getGuildModule(req.guild.id, 'roles');
      await setGuildModule(req.guild.id, 'roles', {
        enabled: rolesMod.enabled || newRoles.length > 0,
        config: { ...rolesMod.config, autoroles: newRoles },
      });
    } else if (mod.id === 'roles') {
      const existing = (await getGuildModule(req.guild.id, 'roles')).config;
      const autoroles = [].concat(req.body.autoroles ?? []).filter((r) => /^\d{17,20}$/.test(r));
      config = { autoroles, reactionMessages: existing.reactionMessages ?? [] };
    } else if (mod.id === 'sticky') {
      const prev = (await getGuildModule(req.guild.id, 'sticky')).config;
      const prevById = new Map((prev.stickies ?? []).map((s) => [s.channelId, s]));
      const chans = [].concat(req.body.s_channel ?? []);
      const contents = [].concat(req.body.s_content ?? []);
      const bots = [].concat(req.body.s_bots ?? []);
      const cooldowns = [].concat(req.body.s_cooldown ?? []);
      const stickies = chans
        .map((channelId, i) => ({
          channelId,
          content: String(contents[i] ?? '').slice(0, 2000),
          lastMessageId: prevById.get(channelId)?.lastMessageId ?? null,
          repostOnBots: bots[i] === 'on',
          cooldownSeconds: Math.max(0, Math.min(3600, Math.floor(Number(cooldowns[i])) || 0)),
        }))
        .filter((s) => /^\d{17,20}$/.test(s.channelId) && s.content.trim() !== '');
      config = { stickies };
    } else if (mod.id === 'tickets') {
      config = {
        greeting: String(req.body.greeting ?? '').slice(0, 1500),
        closeMessage: String(req.body.closeMessage ?? '').slice(0, 1500),
        notifyChannel: /^\d{17,20}$/.test(req.body.notifyChannel ?? '') ? req.body.notifyChannel : '',
        staffRoles: [].concat(req.body.staffRoles ?? []).filter((r) => /^\d{17,20}$/.test(r)),
        transcriptRetentionDays: clampDays(req.body.transcriptRetentionDays),
      };
    } else if (mod.id === 'automod') {
      const b = req.body;
      const prevAutomod = (await getGuildModule(req.guild.id, 'automod')).config;
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
        native: {
          enabled: b.native_enabled === 'on',
          words: b.native_words === 'on',
          mentions: b.native_mentions === 'on',
          spam: b.native_spam === 'on',
          presets: [].concat(b.native_presets ?? []),
        },
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
      const penaltyMinutes = Math.round(Number(req.body.penaltyMinutes));
      config = {
        channelId: /^\d{17,20}$/.test(req.body.channelId ?? '') ? req.body.channelId : '',
        allowSameUser: req.body.allowSameUser === 'on',
        resetOnFail: req.body.resetOnFail === 'on',
        react: req.body.react === 'on',
        penaltyRoleId: /^\d{17,20}$/.test(req.body.penaltyRoleId ?? '') ? req.body.penaltyRoleId : '',
        penaltyMinutes:
          Number.isFinite(penaltyMinutes) && penaltyMinutes > 0
            ? Math.min(penaltyMinutes, 10080) // cap at one week
            : 15,
      };
    } else if (mod.id === 'leveling') {
      const levels = [].concat(req.body.rw_level ?? []);
      const roleIds = [].concat(req.body.rw_role ?? []);
      const multTargets = [].concat(req.body.mult_target ?? []);
      const multFactors = [].concat(req.body.mult_factor ?? []);
      const prevLvl = (await getGuildModule(req.guild.id, 'leveling')).config;
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
        voiceXpEnabled: req.body.voiceXpEnabled === 'on',
        voiceXpPerMin: req.body.voiceXpPerMin,
        voiceAfkExcluded: req.body.voiceAfkExcluded === 'on',
        multipliers: multTargets.map((target, i) => {
          const [type, id] = String(target).split(':');
          return { type, id, factor: multFactors[i] ?? '' };
        }),
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
      const prev = (await getGuildModule(req.guild.id, 'verification')).config;
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
    } else if (mod.id === 'youtube-alerts') {
      const inputs = [].concat(req.body.yt_input ?? []);
      const prevId = [].concat(req.body.yt_resolvedId ?? []);
      const prevName = [].concat(req.body.yt_resolvedName ?? []);
      const chans = [].concat(req.body.yt_channel ?? []);
      const rolez = [].concat(req.body.yt_role ?? []);
      const notify = [].concat(req.body.yt_notify ?? []); // 'both' | 'video' | 'live'
      const ytEnd = [].concat(req.body.yt_onEnd ?? []);
      const vMsg = [].concat(req.body.yt_videoMessage ?? []);
      const lMsg = [].concat(req.body.yt_liveMessage ?? []);

      const alerts = [];
      for (let i = 0; i < inputs.length; i += 1) {
        const input = String(inputs[i] ?? '').trim();
        if (!input && !prevId[i]) continue;
        let resolved =
          /^UC[\w-]{20,}$/.test(prevId[i] ?? '') && !input
            ? { channelId: prevId[i], name: prevName[i] || '' }
            : null;
        if (!resolved) resolved = (await resolveYtChannel(input || prevId[i])) || null;
        if (!resolved && /^UC[\w-]{20,}$/.test(prevId[i] ?? ''))
          resolved = { channelId: prevId[i], name: prevName[i] || '' };
        if (!resolved) continue;
        const n = notify[i] || 'both';
        alerts.push({
          ytChannelId: resolved.channelId,
          name: resolved.name || prevName[i] || '',
          discordChannelId: chans[i] ?? '',
          roleId: rolez[i] ?? '',
          onVideo: n === 'both' || n === 'video',
          onLive: n === 'both' || n === 'live',
          onEnd: ytEnd[i] ?? 'delete',
          videoMessage: vMsg[i] ?? '',
          liveMessage: lMsg[i] ?? '',
        });
      }
      config = normaliseYoutubeConfig({ alerts });
    } else if (mod.id === 'twitch-alerts') {
      const logins = [].concat(req.body.tw_login ?? []);
      const chans = [].concat(req.body.tw_channel ?? []);
      const rolez = [].concat(req.body.tw_role ?? []);
      const msgs = [].concat(req.body.tw_message ?? []);
      const fmts = [].concat(req.body.tw_format ?? []);
      const twEnd = [].concat(req.body.tw_onEnd ?? []);
      config = normaliseTwitchConfig({
        alerts: logins.map((login, i) => ({
          login,
          channelId: chans[i] ?? '',
          roleId: rolez[i] ?? '',
          message: msgs[i] ?? '',
          plainText: fmts[i] === 'text',
          onEnd: twEnd[i] ?? 'delete',
        })),
      });
    } else if (mod.id === 'kick-alerts') {
      const slugs = [].concat(req.body.kc_slug ?? []);
      const chans = [].concat(req.body.kc_channel ?? []);
      const rolez = [].concat(req.body.kc_role ?? []);
      const msgs = [].concat(req.body.kc_message ?? []);
      const fmts = [].concat(req.body.kc_format ?? []);
      const kcEnd = [].concat(req.body.kc_onEnd ?? []);
      config = normaliseKickConfig({
        alerts: slugs.map((slug, i) => ({
          slug,
          channelId: chans[i] ?? '',
          roleId: rolez[i] ?? '',
          message: msgs[i] ?? '',
          plainText: fmts[i] === 'text',
          onEnd: kcEnd[i] ?? 'delete',
        })),
      });
    } else if (mod.id === 'rss') {
      const ids = [].concat(req.body.rss_id ?? []);
      const types = [].concat(req.body.rss_type ?? []);
      const refs = [].concat(req.body.rss_ref ?? []);
      const chans = [].concat(req.body.rss_channel ?? []);
      const rolez = [].concat(req.body.rss_role ?? []);
      const tpls = [].concat(req.body.rss_template ?? []);
      const prevIds = new Set(
        ((await getGuildModule(req.guild.id, 'rss')).config.feeds ?? []).map((f) => f.id)
      );
      config = normaliseRssConfig({
        feeds: refs.map((ref, i) => ({
          id: ids[i] ?? '',
          type: types[i] ?? 'url',
          ref,
          channelId: chans[i] ?? '',
          roleId: rolez[i] ?? '',
          template: tpls[i] ?? '',
        })),
      });
      // Drop the dedup state for feeds that were removed, so re-adding the same
      // URL later starts fresh rather than silently swallowing a backlog.
      const keptIds = new Set(config.feeds.map((f) => f.id));
      for (const id of prevIds) {
        if (!keptIds.has(id)) await clearScope(req.guild.id, `rss:${id}`);
      }
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
      const prev = (await getGuildModule(req.guild.id, 'welcome-channel')).config;
      let spec;
      try {
        spec = JSON.parse(req.body.spec || '{}');
      } catch {
        spec = {};
      }
      config = normaliseWelcomeChannelConfig({
        channelId: req.body.channelId,
        messageId: prev.messageId,
        spec,
      });
    } else if (mod.id === 'giveaways') {
      config = normaliseGiveawaysConfig({ ping: req.body.ping, dmWinners: req.body.dmWinners === 'on' });
    } else if (mod.id === 'birthdays') {
      config = normaliseBirthdaysConfig({
        channel: req.body.channel,
        message: req.body.message,
        roleId: [].concat(req.body.roleId ?? '')[0],
        pingRole: req.body.pingRole === 'on',
      });
    } else {
      return res.redirect(back);
    }

    await setGuildModule(req.guild.id, mod.id, { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: `module:${mod.id}`,
      detail: 'settings saved',
    });
    if (mod.id === 'invite-tracker') {
      primeInviteCache(req.guild).catch((err) =>
        log.error('invite-tracker', 'cache prime after save failed:', err.message)
      );
    }
    if (mod.id === 'verification') {
      ensureVerifyMessage(req.guild, config).catch((err) =>
        log.error('verification', 'ensure message after save failed:', err.message)
      );
    }
    let nativeNote = '';
    let nativeWarned = false;
    if (mod.id === 'automod') {
      const r = await syncGuildAutomod(req.guild, config);
      if (r.skipped === 'missing-permission') {
        nativeNote = ' - native rules skipped: Sylo needs the Manage Server permission';
        nativeWarned = true;
      } else if (r.skipped === 'fetch-failed' || r.errors.length) {
        nativeNote = ' - some native rules could not be updated';
        nativeWarned = true;
      } else if (r.created || r.edited || r.removed) {
        nativeNote = ` - native rules +${r.created} ~${r.edited} -${r.removed}`;
      }
    }
    if (mod.id === 'welcome-channel' && req.body.action === 'publish') {
      const cfg = normaliseWelcomeChannelConfig(
        (await getGuildModule(req.guild.id, 'welcome-channel')).config
      );
      const r = await publishWelcome(req.guild, cfg);
      if (r.ok) {
        await setGuildModule(req.guild.id, 'welcome-channel', {
          enabled: true,
          config: { ...cfg, messageId: r.messageId },
        });
        return res.redirect(`${back}?msg=wc-published`);
      }
      return res.redirect(`${back}?msg=wc-fail`);
    }

    // htmx: swap the re-rendered panel + fire a toast instead of a full reload.
    if (req.get('HX-Request')) {
      return res
        .set(
          'HX-Trigger',
          JSON.stringify({ toast: { msg: `Saved${nativeNote}`, kind: nativeWarned ? 'warn' : 'ok' } })
        )
        .render('guild/_module-config', await moduleViewLocals(mod, req, config));
    }
    res.redirect(`${back}?msg=saved`);
  })
);

// Giveaways: end / reroll from the dashboard.
router.post(
  '/:guildId/m/giveaways/:id/:action',
  asyncHandler(async (req, res) => {
    const back = `/guilds/${req.guild.id}/m/giveaways`;
    const id = Number(req.params.id);
    const g = await getGiveawayInGuild(id, req.guild.id);
    if (!g) return res.redirect(`${back}?msg=badcommand`);

    if (req.params.action === 'end' && !g.ended) {
      await endGiveaway(id);
      await recordAudit(req.guild.id, {
        actor: moderatorDisplayName(req),
        action: 'module:giveaways',
        detail: `ended #${id}`,
      });
    } else if (req.params.action === 'reroll' && g.ended) {
      const count = Math.max(1, Math.min(Number(req.body.count) || 1, 20));
      await endGiveaway(id, { rerollCount: count });
      await recordAudit(req.guild.id, {
        actor: moderatorDisplayName(req),
        action: 'module:giveaways',
        detail: `rerolled #${id}`,
      });
    }
    res.redirect(`${back}?msg=saved`);
  })
);

// Counting: correct the running number (or reset it) from the dashboard.
router.post(
  '/:guildId/m/counting/count',
  asyncHandler(async (req, res) => {
    const back = `/guilds/${req.guild.id}/m/counting`;
    if (req.body.reset === 'true') {
      await resetCount(req.guild.id);
      await recordAudit(req.guild.id, {
        actor: moderatorDisplayName(req),
        action: 'counting:reset',
        detail: 'count set to 0',
      });
      return res.redirect(`${back}?msg=count-reset`);
    }
    const n = Number(req.body.current);
    if (!Number.isInteger(n) || n < 0 || n > 1e12) {
      return res.redirect(`${back}?msg=count-bad`);
    }
    await setCount(req.guild.id, n);
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'counting:set',
      detail: `count = ${n}`,
    });
    res.redirect(`${back}?msg=count-set`);
  })
);

// Counting: end a member's bench early — hand the penalty role straight back.
router.post(
  '/:guildId/m/counting/penalty/release',
  asyncHandler(async (req, res) => {
    const back = `/guilds/${req.guild.id}/m/counting`;
    const userId = String(req.body.userId ?? '');
    if (!/^\d{17,20}$/.test(userId)) return res.redirect(`${back}?msg=count-bad`);

    const cfg = (await getGuildModule(req.guild.id, 'counting')).config;
    const role = cfg.penaltyRoleId ? req.guild.roles.cache.get(cfg.penaltyRoleId) : null;
    const member = await req.guild.members.fetch(userId).catch(() => null);
    if (role && member && !member.roles.cache.has(role.id) && role.editable) {
      await member.roles.add(role, 'Counting: bench ended early from the dashboard').catch(() => {});
    }
    await clearCountingPenalty(req.guild.id, userId);
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'counting:unbench',
      detail: `released ${userId}`,
    });
    res.redirect(`${back}?msg=count-unbenched`);
  })
);

// Leveling: set a member's XP, or wipe the whole guild leaderboard.
router.post(
  '/:guildId/m/leveling/xp',
  asyncHandler(async (req, res) => {
    const back = `/guilds/${req.guild.id}/m/leveling`;
    if (req.body.reset === 'true') {
      await resetGuildLeveling(req.guild.id);
      await recordAudit(req.guild.id, {
        actor: moderatorDisplayName(req),
        action: 'leveling:reset',
        detail: 'all XP wiped',
      });
      return res.redirect(`${back}?msg=lvl-reset`);
    }
    const userId = parseUserId(req.body.userId);
    const xp = Number(req.body.xp);
    if (!userId || !Number.isInteger(xp) || xp < 0 || xp > 1e12) {
      return res.redirect(`${back}?msg=lvl-bad`);
    }
    await setXp(req.guild.id, userId, xp);
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'leveling:setxp',
      detail: `${userId} → ${xp} XP`,
    });

    // Reconcile reward roles for the new level (adds/strips per config).
    const cfg = normaliseLevelingConfig((await getGuildModule(req.guild.id, 'leveling')).config);
    const member = await req.guild.members.fetch(userId).catch(() => null);
    if (member) await syncRewards(member, levelFromXp(xp), cfg).catch(() => {});

    res.redirect(`${back}?msg=lvl-set`);
  })
);

// --- Reminders builder (MEE6-style) ----------------------------------

const REM_BASE = 'm/reminders';

function toMs(v) {
  const t = new Date(String(v ?? '')).getTime();
  return Number.isFinite(t) ? t : null;
}

async function renderReminderBuilder(req, res, rec) {
  res.render('reminder-builder', {
    ...(await baseContext(req.guild, REM_BASE)),
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

router.get(
  '/:guildId/m/reminders/r/new',
  asyncHandler((req, res) => renderReminderBuilder(req, res, null))
);

// Express 5 dropped inline path regex — a numeric ("new" for the POST) id shape
// is enforced in the handler instead.
const isRemId = (v) => /^\d+$/.test(v ?? '');

router.get(
  '/:guildId/m/reminders/r/:id',
  asyncHandler(async (req, res) => {
    if (!isRemId(req.params.id)) return res.redirect(`/guilds/${req.guild.id}/${REM_BASE}`);
    const rec = await getScheduled(req.guild.id, Number(req.params.id));
    if (!rec) return res.redirect(`/guilds/${req.guild.id}/${REM_BASE}`);
    await renderReminderBuilder(req, res, rec);
  })
);

router.post(
  '/:guildId/m/reminders/r/:id',
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (req.params.id !== 'new' && !isRemId(req.params.id)) {
      return res.redirect(`/guilds/${req.guild.id}/${REM_BASE}`);
    }
    const existing = req.params.id === 'new' ? null : await getScheduled(req.guild.id, Number(req.params.id));
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
      name:
        String(b.name ?? '')
          .trim()
          .slice(0, 100) || 'Untitled reminder',
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
      await updateReminder(req.guild.id, existing.id, data);
      id = existing.id;
    } else {
      id = await createReminder(req.guild.id, data);
    }
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:reminders',
      detail: `${existing ? 'updated' : 'created'} "${data.name}"`,
    });
    res.redirect(`/guilds/${req.guild.id}/${REM_BASE}/r/${id}?msg=saved`);
  })
);

router.post(
  '/:guildId/m/reminders/r/:id/delete',
  asyncHandler(async (req, res) => {
    if (isRemId(req.params.id)) await deleteScheduled(req.guild.id, Number(req.params.id));
    res.redirect(`/guilds/${req.guild.id}/${REM_BASE}?msg=saved`);
  })
);

router.post(
  '/:guildId/m/reminders/r/:id/toggle',
  asyncHandler(async (req, res) => {
    const rec = isRemId(req.params.id) ? await getScheduled(req.guild.id, Number(req.params.id)) : null;
    if (rec) await setScheduledEnabled(req.guild.id, rec.id, rec.enabled !== 1);
    res.redirect(`/guilds/${req.guild.id}/${REM_BASE}?msg=saved`);
  })
);

// --- Channel cleanup builder -----------------------------------------

const CLEAN_BASE = 'm/channel-cleanup';
const isCleanId = (v) => /^\d+$/.test(v ?? '');
const MAX_AGE_HOURS_CAP = 24 * 90; // 90 days

async function renderCleanupBuilder(req, res, rec) {
  res.render('channel-cleanup-builder', {
    ...(await baseContext(req.guild, CLEAN_BASE)),
    channels: guildTextChannels(req.guild),
    guildId: req.guild.id,
    weekdays: WEEKDAYS,
    isNew: !rec,
    rec: rec || {
      id: '',
      channel_id: '',
      dayList: [0, 1, 2, 3, 4, 5, 6],
      time_hhmm: '03:00',
      max_age_hours: 24,
      skip_pinned: 1,
      enabled: 1,
    },
    msg: typeof req.query.msg === 'string' ? req.query.msg : null,
  });
}

router.get(
  '/:guildId/m/channel-cleanup/s/new',
  asyncHandler((req, res) => renderCleanupBuilder(req, res, null))
);

router.get(
  '/:guildId/m/channel-cleanup/s/:id',
  asyncHandler(async (req, res) => {
    if (!isCleanId(req.params.id)) return res.redirect(`/guilds/${req.guild.id}/${CLEAN_BASE}`);
    const rec = await getCleanupSchedule(req.guild.id, Number(req.params.id));
    if (!rec) return res.redirect(`/guilds/${req.guild.id}/${CLEAN_BASE}`);
    await renderCleanupBuilder(req, res, rec);
  })
);

router.post(
  '/:guildId/m/channel-cleanup/s/:id',
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (req.params.id !== 'new' && !isCleanId(req.params.id)) {
      return res.redirect(`/guilds/${req.guild.id}/${CLEAN_BASE}`);
    }
    const existing =
      req.params.id === 'new' ? null : await getCleanupSchedule(req.guild.id, Number(req.params.id));
    if (req.params.id !== 'new' && !existing) return res.redirect(`/guilds/${req.guild.id}/${CLEAN_BASE}`);
    const back = `/guilds/${req.guild.id}/${CLEAN_BASE}/s/${existing ? existing.id : 'new'}`;

    const channelId = /^\d{17,20}$/.test(b.channelId ?? '') ? b.channelId : '';
    if (!channelId) return res.redirect(`${back}?msg=badchannel`);

    const days = WEEKDAYS.map(([n]) => n).filter((n) => b[`day_${n}`] === 'on');
    const maxAgeHours = Math.min(MAX_AGE_HOURS_CAP, Math.max(1, Math.floor(Number(b.maxAgeHours)) || 24));
    if (!/^\d{2}:\d{2}$/.test(b.timeHhmm ?? '')) return res.redirect(`${back}?msg=cc-time`);

    const data = {
      channelId,
      days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
      timeHhmm: b.timeHhmm,
      maxAgeHours,
      skipPinned: b.skipPinned === 'on',
    };

    let id;
    if (existing) {
      await updateCleanupSchedule(req.guild.id, existing.id, data);
      id = existing.id;
    } else {
      id = await createCleanupSchedule(req.guild.id, data);
    }
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:channel-cleanup',
      detail: `${existing ? 'updated' : 'created'} schedule for #${
        guildTextChannels(req.guild).find((c) => c.id === channelId)?.name ?? channelId
      }`,
    });
    res.redirect(`/guilds/${req.guild.id}/${CLEAN_BASE}/s/${id}?msg=saved`);
  })
);

router.post(
  '/:guildId/m/channel-cleanup/s/:id/delete',
  asyncHandler(async (req, res) => {
    if (isCleanId(req.params.id)) await deleteCleanupSchedule(req.guild.id, Number(req.params.id));
    res.redirect(`/guilds/${req.guild.id}/${CLEAN_BASE}?msg=saved`);
  })
);

router.post(
  '/:guildId/m/channel-cleanup/s/:id/toggle',
  asyncHandler(async (req, res) => {
    const rec = isCleanId(req.params.id)
      ? await getCleanupSchedule(req.guild.id, Number(req.params.id))
      : null;
    if (rec) await setCleanupScheduleEnabled(req.guild.id, rec.id, rec.enabled !== 1);
    res.redirect(`/guilds/${req.guild.id}/${CLEAN_BASE}?msg=saved`);
  })
);

// --- Temporary voice "hub" builder (MEE6-style) ---------------------

async function tvHubs(guildId) {
  return normaliseTempVoiceConfig((await getGuildModule(guildId, 'temp-voice')).config).hubs;
}

async function renderTvBuilder(req, res, hub) {
  res.render('tv-builder', {
    ...(await baseContext(req.guild, 'm/temp-voice')),
    guildId: req.guild.id,
    voiceChannels: guildVoiceChannels(req.guild),
    categories: guildCategories(req.guild),
    roles: assignableRoles(req.guild),
    isNew: !hub,
    hub: hub || {
      id: '',
      hubChannelId: '',
      categoryId: '',
      nameTemplate: "#{index} - {username}'s Channel",
      userLimit: 0,
      bitrate: 0,
      keepAliveMinutes: 0,
      ownershipLock: false,
      syncCategory: false,
      syncChannel: false,
      roleMode: 'allow',
      roleList: [],
      useRolesForAccess: false,
      ignoredRoles: [],
      moderatorRoles: [],
      ownerPerms: {
        manageChannels: true,
        managePermissions: false,
        prioritySpeaker: false,
        moveMembers: false,
      },
      textChannel: { enabled: false, restrictCommands: false, pinUsages: false, restrict: false },
    },
    msg: typeof req.query.msg === 'string' ? req.query.msg : null,
  });
}

router.get(
  '/:guildId/m/temp-voice/hub/new',
  asyncHandler((req, res) => renderTvBuilder(req, res, null))
);

router.get(
  '/:guildId/m/temp-voice/hub/:id',
  asyncHandler(async (req, res) => {
    const hub = (await tvHubs(req.guild.id)).find((h) => h.id === req.params.id);
    if (!hub) return res.redirect(`/guilds/${req.guild.id}/m/temp-voice`);
    await renderTvBuilder(req, res, hub);
  })
);

router.post(
  '/:guildId/m/temp-voice/hub',
  asyncHandler(async (req, res) => {
    const back = `/guilds/${req.guild.id}/m/temp-voice`;
    const b = req.body;
    if (!/^\d{17,20}$/.test(b.hubChannelId ?? '')) return res.redirect(`${back}?msg=badchannel`);

    const prev = await tvHubs(req.guild.id);
    const id = /^\d+$/.test(b.id ?? '') ? b.id : String(Date.now());
    const existing = prev.find((h) => h.id === id);
    const hub = {
      id,
      hubChannelId: b.hubChannelId,
      categoryId: b.categoryId ?? '',
      nameTemplate: b.nameTemplate ?? '',
      userLimit: b.userLimit,
      bitrate: b.bitrate,
      keepAliveMinutes: b.keepAliveMinutes,
      ownershipLock: b.ownershipLock === 'on',
      syncCategory: b.syncCategory === 'on',
      syncChannel: b.syncChannel === 'on',
      roleMode: b.roleMode === 'deny' ? 'deny' : 'allow',
      roleList: [].concat(b.roleList ?? []),
      useRolesForAccess: b.useRolesForAccess === 'on',
      ignoredRoles: [].concat(b.ignoredRoles ?? []),
      moderatorRoles: [].concat(b.moderatorRoles ?? []),
      ownerPerms: {
        manageChannels: b.op_manageChannels === 'on',
        managePermissions: b.op_managePermissions === 'on',
        prioritySpeaker: b.op_prioritySpeaker === 'on',
        moveMembers: b.op_moveMembers === 'on',
      },
      textChannel: {
        enabled: b.tc_enabled === 'on',
        restrictCommands: b.tc_restrictCommands === 'on',
        pinUsages: b.tc_pinUsages === 'on',
        restrict: b.tc_restrict === 'on',
      },
    };
    const next = existing ? prev.map((h) => (h.id === id ? hub : h)) : [...prev, hub];
    await setGuildModule(req.guild.id, 'temp-voice', {
      enabled: true,
      config: normaliseTempVoiceConfig({ hubs: next }),
    });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:temp-voice',
      detail: `${existing ? 'updated' : 'created'} a hub`,
    });
    res.redirect(`${back}?msg=saved`);
  })
);

router.post(
  '/:guildId/m/temp-voice/hub/:id/delete',
  asyncHandler(async (req, res) => {
    const prev = await tvHubs(req.guild.id);
    await setGuildModule(req.guild.id, 'temp-voice', {
      config: normaliseTempVoiceConfig({ hubs: prev.filter((h) => h.id !== req.params.id) }),
    });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:temp-voice',
      detail: 'deleted a hub',
    });
    res.redirect(`/guilds/${req.guild.id}/m/temp-voice?msg=saved`);
  })
);

// --- Reaction-role builder (MEE6-style) ---------------------------------

async function renderRrBuilder(req, res, rm) {
  res.render('rr-builder', {
    ...(await baseContext(req.guild, 'm/roles')),
    channels: guildTextChannels(req.guild),
    roles: assignableRoles(req.guild),
    guildId: req.guild.id,
    isNew: !rm,
    rm: rm || {
      id: '',
      channelId: '',
      messageId: '',
      style: 'reaction',
      message: 'React to this message to get your roles!',
      embed: { kind: 'embed', color: '#5865f2', description: 'React to this message to get your roles!' },
      exclusive: false,
      mode: 'default',
      placeholder: '',
      selMin: 0,
      selMax: 0,
      pairs: [],
    },
  });
}

router.get(
  '/:guildId/m/roles/rr/new',
  asyncHandler((req, res) => renderRrBuilder(req, res, null))
);

router.get(
  '/:guildId/m/roles/rr/:id',
  asyncHandler(async (req, res) => {
    const list = (await getGuildModule(req.guild.id, 'roles')).config.reactionMessages ?? [];
    await renderRrBuilder(req, res, list.find((x) => String(x.id) === req.params.id) || null);
  })
);

router.post(
  '/:guildId/m/roles/rr',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const back = `/guilds/${guild.id}/m/roles`;
    const cfg = (await getGuildModule(guild.id, 'roles')).config;
    const list = Array.isArray(cfg.reactionMessages) ? cfg.reactionMessages : [];

    const channelId = /^\d{17,20}$/.test(req.body.channelId ?? '') ? req.body.channelId : '';
    if (!channelId) return res.redirect(`${back}?msg=badchannel`);

    let embed;
    try {
      embed = JSON.parse(req.body.embed || '{}');
    } catch {
      embed = {};
    }

    const style = ['buttons', 'select'].includes(req.body.rr_style) ? req.body.rr_style : 'reaction';
    const emojis = [].concat(req.body.rr_emoji ?? []);
    const roleIds = [].concat(req.body.rr_role ?? []);
    const labels = [].concat(req.body.rr_label ?? []);
    const btnStyles = [].concat(req.body.rr_btnstyle ?? []);
    const pairs = [];
    roleIds.forEach((rid, i) => {
      if (!/^\d{17,20}$/.test(rid ?? '')) return;
      const parsed = parseEmoji(emojis[i] ?? '', guild);
      // The reaction style needs a usable emoji; button / select styles don't.
      if (style === 'reaction' && !parsed) return;
      pairs.push({
        ...(parsed || { key: '', display: '', react: '' }),
        roleId: rid,
        label: String(labels[i] ?? '').slice(0, 80),
        btnStyle: ['primary', 'secondary', 'success', 'danger'].includes(btnStyles[i])
          ? btnStyles[i]
          : 'secondary',
      });
    });
    if (pairs.length === 0) return res.redirect(`${back}?msg=needpair`);

    const id = /^\d+$/.test(req.body.id ?? '') ? req.body.id : String(Date.now());
    const existing = list.find((x) => String(x.id) === id);
    const rm = {
      id,
      channelId,
      messageId: existing?.messageId || '',
      style,
      message: String(req.body.message ?? '').slice(0, 2000),
      embed: normaliseEmbedSpec(embed),
      exclusive: req.body.exclusive === 'on',
      mode: req.body.mode === 'reverse' ? 'reverse' : 'default',
      placeholder: String(req.body.rr_placeholder ?? '').slice(0, 150),
      selMin: Number.parseInt(req.body.rr_selmin, 10) || 0,
      selMax: Number.parseInt(req.body.rr_selmax, 10) || 0,
      pairs,
    };
    // Re-publishing after a style change: drop the old message so the new one is
    // posted cleanly (components vs reactions differ enough that editing is messy).
    if (existing && existing.style && existing.style !== style && existing.messageId) {
      const oldCh = guild.channels.cache.get(existing.channelId);
      const oldMsg = oldCh && (await oldCh.messages.fetch(existing.messageId).catch(() => null));
      if (oldMsg) await oldMsg.delete().catch(() => {});
      rm.messageId = '';
    }

    let ok = false;
    try {
      rm.messageId = await publishReactionMessage(guild, rm);
      ok = true;
    } catch (err) {
      log.error('roles', 'publish reaction message failed:', err.message);
    }

    const next = existing ? list.map((x) => (String(x.id) === id ? rm : x)) : [...list, rm];
    await setGuildModule(guild.id, 'roles', { enabled: true, config: { ...cfg, reactionMessages: next } });
    await recordAudit(guild.id, {
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
    const cfg = (await getGuildModule(guild.id, 'roles')).config;
    const list = Array.isArray(cfg.reactionMessages) ? cfg.reactionMessages : [];
    const rm = list.find((x) => String(x.id) === req.params.id);
    if (rm?.messageId && rm.channelId) {
      const ch = guild.channels.cache.get(rm.channelId);
      const m = ch && (await ch.messages.fetch(rm.messageId).catch(() => null));
      if (m) await m.delete().catch(() => {});
    }
    await setGuildModule(guild.id, 'roles', {
      config: { ...cfg, reactionMessages: list.filter((x) => String(x.id) !== req.params.id) },
    });
    res.redirect(`/guilds/${guild.id}/m/roles?msg=saved`);
  })
);

// --- Starboard builder (MEE6-style) -----------------------------------

async function starboardBoards(guildId) {
  return normaliseStarboard((await getGuildModule(guildId, 'starboard')).config).boards;
}

async function renderSbBuilder(req, res, board) {
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
    ...(await baseContext(req.guild, 'm/starboard')),
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

router.get(
  '/:guildId/m/starboard/sb/new',
  asyncHandler((req, res) => renderSbBuilder(req, res, null))
);

router.get(
  '/:guildId/m/starboard/sb/:id',
  asyncHandler(async (req, res) => {
    const board = (await starboardBoards(req.guild.id)).find((b) => b.id === req.params.id);
    if (!board) return res.redirect(`/guilds/${req.guild.id}/m/starboard`);
    await renderSbBuilder(req, res, board);
  })
);

router.post(
  '/:guildId/m/starboard/sb',
  asyncHandler(async (req, res) => {
    const back = `/guilds/${req.guild.id}/m/starboard`;
    const b = req.body;
    const channelId = /^\d{17,20}$/.test(b.channelId ?? '') ? b.channelId : '';
    if (!channelId) return res.redirect(`${back}?msg=badchannel`);

    const prev = normaliseStarboard((await getGuildModule(req.guild.id, 'starboard')).config);
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
    await setGuildModule(req.guild.id, 'starboard', { enabled: true, config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:starboard',
      detail: `${existing ? 'updated' : 'created'} board "${board.name}"`,
    });

    // Catch up on messages that already clear the (possibly just-lowered) bar.
    const saved = config.boards.find((x) => x.id === id);
    if (saved) {
      rescanBoard(req.guild, saved)
        .then((r) =>
          log.info('starboard', `rescan ${req.guild.id}/${id}: scanned ${r.scanned}, posted ${r.posted}`)
        )
        .catch((err) => log.error('starboard', 'rescan failed:', err.message));
    }
    res.redirect(`${back}?msg=sb-saved`);
  })
);

router.post(
  '/:guildId/m/starboard/sb/:id/delete',
  asyncHandler(async (req, res) => {
    const prev = normaliseStarboard((await getGuildModule(req.guild.id, 'starboard')).config);
    const config = normaliseStarboard({ boards: prev.boards.filter((b) => b.id !== req.params.id) });
    await setGuildModule(req.guild.id, 'starboard', { config });
    await deleteBoardEntries(req.guild.id, req.params.id);
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:starboard',
      detail: 'deleted a board',
    });
    res.redirect(`/guilds/${req.guild.id}/m/starboard?msg=saved`);
  })
);

// --- Custom-command builder (MEE6-style actions) ----------------------

async function ccCommands(guildId) {
  return normaliseCustomCommands((await getGuildModule(guildId, 'custom-commands')).config).commands;
}

async function renderCcBuilder(req, res, cmd) {
  res.render('cc-builder', {
    ...(await baseContext(req.guild, 'm/custom-commands')),
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

router.get(
  '/:guildId/m/custom-commands/cmd/new',
  asyncHandler((req, res) => renderCcBuilder(req, res, null))
);

router.get(
  '/:guildId/m/custom-commands/cmd/:id',
  asyncHandler(async (req, res) => {
    const cmd = (await ccCommands(req.guild.id)).find((c) => c.id === req.params.id);
    if (!cmd) return res.redirect(`/guilds/${req.guild.id}/m/custom-commands`);
    await renderCcBuilder(req, res, cmd);
  })
);

router.post(
  '/:guildId/m/custom-commands/cmd',
  asyncHandler(async (req, res) => {
    const back = `/guilds/${req.guild.id}/m/custom-commands`;

    let actions;
    try {
      actions = JSON.parse(req.body.actions || '[]');
    } catch {
      return res.redirect(`${back}?msg=cc-bad`);
    }
    if (!Array.isArray(actions)) actions = [];

    const name = String(req.body.name ?? '')
      .trim()
      .toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) return res.redirect(`${back}?msg=cc-name`);
    if (runtime.client?.commands?.has(name)) return res.redirect(`${back}?msg=cc-reserved`);

    const prev = normaliseCustomCommands((await getGuildModule(req.guild.id, 'custom-commands')).config);
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

    await setGuildModule(req.guild.id, 'custom-commands', { enabled: true, config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:custom-commands',
      detail: `${existing ? 'updated' : 'created'} /${name}`,
    });
    await syncGuildCustomCommands(req.guild).catch((err) =>
      log.error('custom-commands', 'sync after save failed:', err.message)
    );
    res.redirect(`${back}?msg=saved`);
  })
);

router.post(
  '/:guildId/m/custom-commands/cmd/:id/delete',
  asyncHandler(async (req, res) => {
    const prev = normaliseCustomCommands((await getGuildModule(req.guild.id, 'custom-commands')).config);
    const config = normaliseCustomCommands({
      commands: prev.commands.filter((c) => c.id !== req.params.id),
    });
    await setGuildModule(req.guild.id, 'custom-commands', { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:custom-commands',
      detail: 'deleted a command',
    });
    await syncGuildCustomCommands(req.guild).catch((err) =>
      log.error('custom-commands', 'sync after delete failed:', err.message)
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
    if (!userId) return res.redirect(`${back}?tab=infr&msg=baduser`);

    if (!guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
      return res.redirect(`${back}?tab=infr&msg=perms`);
    }
    const existing = await guild.bans.fetch(userId).catch(() => null);
    if (!existing) {
      await clearTempBan(guild.id, userId); // stale timer for an already-lifted ban
      return res.redirect(`${back}?tab=infr&msg=notbanned`);
    }

    await guild.bans.remove(userId, `${moderatorDisplayName(req)}: unbanned via dashboard`);
    await clearTempBan(guild.id, userId); // in case this was a scheduled temporary ban

    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('Ban removed')
      .setDescription(`${existing.user.tag} (\`${existing.user.id}\`)`)
      .addFields({ name: 'Moderator', value: moderatorDisplayName(req) })
      .setTimestamp(Date.now());
    await postModLog(guild, embed);

    res.redirect(`${back}?tab=infr&msg=unbanned`);
  })
);

const LOCKDOWN_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];

// Lock every text channel (dashboard equivalent of /lockdown start).
router.post(
  '/:guildId/moderation/lock-all',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const back = `/guilds/${guild.id}/moderation`;
    const moderatorTag = moderatorDisplayName(req);

    let locked = 0;
    for (const channel of guild.channels.cache.values()) {
      if (!LOCKDOWN_TYPES.includes(channel.type)) continue;
      if ((await isChannelLocked(guild.id, channel.id)) || lockPreflight(channel)) continue;
      try {
        await lockChannel(channel, { moderatorTag, lockdown: true });
        locked += 1;
      } catch {
        /* skip a channel we can't edit */
      }
    }

    await recordAudit(guild.id, {
      actor: moderatorTag,
      action: 'moderation:lockdown',
      detail: `locked ${locked} channel(s)`,
    });
    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('🔒 Server lockdown started')
      .addFields(
        { name: 'Channels locked', value: String(locked) },
        { name: 'Moderator', value: moderatorTag }
      )
      .setTimestamp(Date.now());
    await postModLog(guild, embed);
    res.redirect(`${back}?tab=infr&msg=locked-all`);
  })
);

// End the lockdown — restore every channel /lockdown locked.
router.post(
  '/:guildId/moderation/unlock-all',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const back = `/guilds/${guild.id}/moderation`;
    const moderatorTag = moderatorDisplayName(req);

    let unlocked = 0;
    for (const row of await lockdownChannelLocks(guild.id)) {
      const channel = guild.channels.cache.get(row.channel_id);
      if (!channel) {
        await clearChannelLock(guild.id, row.channel_id);
        continue;
      }
      try {
        await unlockChannel(channel, { moderatorTag });
        unlocked += 1;
      } catch {
        /* skip */
      }
    }

    await recordAudit(guild.id, {
      actor: moderatorTag,
      action: 'moderation:lockdown',
      detail: `unlocked ${unlocked} channel(s)`,
    });
    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('🔓 Server lockdown ended')
      .addFields(
        { name: 'Channels unlocked', value: String(unlocked) },
        { name: 'Moderator', value: moderatorTag }
      )
      .setTimestamp(Date.now());
    await postModLog(guild, embed);
    res.redirect(`${back}?tab=infr&msg=unlocked-all`);
  })
);

// Unlock a single channel.
router.post(
  '/:guildId/moderation/unlock-channel',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const back = `/guilds/${guild.id}/moderation`;
    const channelId = String(req.body.channelId ?? '');
    if (!/^\d{17,20}$/.test(channelId) || !(await isChannelLocked(guild.id, channelId))) {
      return res.redirect(`${back}?tab=infr&msg=lock-gone`);
    }

    const moderatorTag = moderatorDisplayName(req);
    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      await clearChannelLock(guild.id, channelId);
      return res.redirect(`${back}?tab=infr&msg=unlocked-one`);
    }
    if (lockPreflight(channel)) return res.redirect(`${back}?tab=infr&msg=perms`);

    await unlockChannel(channel, { moderatorTag });
    await recordAudit(guild.id, {
      actor: moderatorTag,
      action: 'moderation:unlock',
      detail: `#${channel.name}`,
    });
    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('Channel unlocked')
      .addFields({ name: 'Channel', value: `#${channel.name}` }, { name: 'Moderator', value: moderatorTag })
      .setTimestamp(Date.now());
    await postModLog(guild, embed);
    res.redirect(`${back}?tab=infr&msg=unlocked-one`);
  })
);

// Bulk enable/disable from the overview "select mode". Client reloads on 200.
// Registered before the `:moduleId` route so "bulk" isn't read as a module id.
router.post(
  '/:guildId/modules/bulk',
  asyncHandler(async (req, res) => {
    const ids = [...new Set([].concat(req.body.ids ?? []))].filter((id) => getModule(id));
    const enabled = Boolean(req.body.enabled);
    for (const id of ids) {
      await setGuildModule(req.guild.id, id, { enabled });
      if (id === 'custom-commands') {
        syncGuildCustomCommands(req.guild).catch((err) =>
          log.error('custom-commands', 'sync after bulk toggle failed:', err.message)
        );
      }
      if (id === 'invite-tracker' && enabled) {
        primeInviteCache(req.guild).catch((err) =>
          log.error('invite-tracker', 'cache prime after bulk enable failed:', err.message)
        );
      }
    }
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:bulk',
      detail: `${enabled ? 'enabled' : 'disabled'} ${ids.length} module(s)`,
    });
    res.json({ ok: true, count: ids.length, enabled });
  })
);

// Toggle a module on/off. Driven by htmx (see _module-toggle.ejs / _plugin-cta.ejs);
// still answers plain JSON for the no-JS / programmatic path.
router.post(
  '/:guildId/modules/:moduleId',
  asyncHandler(async (req, res) => {
    const mod = getModule(req.params.moduleId);
    if (!mod) return res.status(404).json({ error: 'Unknown module' });
    const enabled = Boolean(req.body?.enabled);
    await setGuildModule(req.guild.id, mod.id, { enabled });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: `module:${mod.id}`,
      detail: enabled ? 'enabled' : 'disabled',
    });
    if (mod.id === 'custom-commands') {
      syncGuildCustomCommands(req.guild).catch((err) =>
        log.error('custom-commands', 'sync after toggle failed:', err.message)
      );
    }
    if (mod.id === 'invite-tracker' && enabled) {
      primeInviteCache(req.guild).catch((err) =>
        log.error('invite-tracker', 'cache prime after enable failed:', err.message)
      );
    }
    if (mod.id === 'automod') {
      // Re-assert native rules when turned back on; tear them down when off.
      const cfg = normaliseAutomodConfig((await getGuildModule(req.guild.id, 'automod')).config);
      const target = enabled ? cfg : { ...cfg, native: { ...cfg.native, enabled: false } };
      syncGuildAutomod(req.guild, target).catch((err) =>
        log.error('automod', 'native sync after toggle failed:', err.message)
      );
    }
    if (req.get('HX-Request')) {
      res.set(
        'HX-Trigger',
        JSON.stringify({
          moduleToggled: { id: mod.id, enabled },
          toast: { msg: `${mod.name} ${enabled ? 'enabled' : 'disabled'}`, kind: 'ok' },
        })
      );
      // Two callers: the plugin-grid "Enable" button and the settings-page switch.
      if (req.body.view === 'grid') {
        return res.render('guild/_plugin-cta', { href: `/guilds/${req.guild.id}/m/${mod.id}` });
      }
      return res.render('guild/_module-toggle', {
        guild: req.guild,
        activeModule: mod,
        moduleEnabled: enabled,
        toggleDisabled: missingIntents(mod).length > 0,
      });
    }
    res.json({ enabled });
  })
);

// Invite tracker: nudge a member's bonus invites from the dashboard.
router.post(
  '/:guildId/m/invite-tracker/bonus',
  asyncHandler(async (req, res) => {
    const back = `/guilds/${req.guild.id}/m/invite-tracker`;
    const userId = parseUserId(req.body.userId);
    const bonus = Number(req.body.bonus);
    if (!userId || !Number.isInteger(bonus) || bonus < -100000 || bonus > 100000) {
      return res.redirect(`${back}?msg=inv-bad`);
    }
    await setBonus(req.guild.id, userId, bonus);
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:invite-tracker',
      detail: `${userId} bonus → ${bonus}`,
    });
    res.redirect(`${back}?msg=saved`);
  })
);

// Download the guild's configuration as JSON (backup / "export my setup").
router.get(
  '/:guildId/export',
  asyncHandler(async (req, res) => {
    const data = await exportGuildConfig(req.guild.id);
    res.setHeader('Content-Disposition', `attachment; filename="sylo-${req.guild.id}-config.json"`);
    res.type('application/json').send(JSON.stringify(data, null, 2));
  })
);

// Config change history.
router.get(
  '/:guildId/audit',
  asyncHandler(async (req, res) => {
    res.render('guild', {
      ...(await baseContext(req.guild, 'audit')),
      audit: (await listAudit(req.guild.id, 150)).map((a) => ({
        actor: a.actor,
        action: a.action,
        detail: a.detail,
        ago: timeAgo(a.created_at),
      })),
    });
  })
);

// Server insights — activity charts from the guild_daily / guild_hourly rollups.
router.get(
  '/:guildId/insights',
  asyncHandler(async (req, res) => {
    // range: 24 / 48 hours (hourly buckets), or 7 / 30 / 90 days.
    const HOURLY = { 24: 24, 48: 48 };
    const DAILY = { 7: 7, 30: 30, 90: 90 };
    const raw = String(req.query.range ?? '30');
    const hourly = raw in HOURLY;
    const range = hourly ? HOURLY[raw] : (DAILY[raw] ?? 30);
    const series = hourly ? await hourlySeries(req.guild.id, range) : await dailySeries(req.guild.id, range);

    // Per-channel totals ("top channels") are only kept daily; for an hourly
    // window fall back to the last day.
    const topDays = hourly ? 1 : range;
    const chans = [...guildTextChannels(req.guild), ...guildVoiceChannels(req.guild)];
    // A `name:` bucket already carries a captured channel name (temp voice, since
    // deleted); a plain id resolves to the live channel, else it's since deleted.
    const nameOf = (id) =>
      id.startsWith('name:') ? id.slice(5) : (chans.find((c) => c.id === id)?.name ?? 'deleted channel');

    res.render('guild', {
      ...(await baseContext(req.guild, 'insights')),
      insightsEnabled: (await getGuildModule(req.guild.id, 'insights')).enabled,
      insightsRange: range,
      insightsGranularity: hourly ? 'hour' : 'day',
      insightsSeries: series,
      insightsTotals: {
        messages: series.reduce((t, d) => t + d.messages, 0),
        joins: series.reduce((t, d) => t + d.joins, 0),
        leaves: series.reduce((t, d) => t + d.leaves, 0),
        net: series.reduce((t, d) => t + d.joins - d.leaves, 0),
        peakActive: series.reduce((m, d) => Math.max(m, d.activeMembers), 0),
        voiceMinutes: series.reduce((t, d) => t + d.voiceMinutes, 0),
        voicePeak: series.reduce((m, d) => Math.max(m, d.voicePeak), 0),
      },
      insightsTopChannels: (await topChannels(req.guild.id, topDays, 6)).map((t) => ({
        name: nameOf(t.channelId),
        messages: t.messages,
      })),
      insightsTopVoice: (await topVoiceChannels(req.guild.id, topDays, 6)).map((t) => ({
        name: nameOf(t.channelId),
        minutes: t.minutes,
      })),
    });
  })
);

// "Refresh now" — flush the in-memory counters for this guild, then reload.
router.post(
  '/:guildId/insights/refresh',
  asyncHandler(async (req, res) => {
    await flushGuildInsights(req.guild.id);
    const range = ['24', '48', '7', '30', '90'].includes(String(req.body.range))
      ? String(req.body.range)
      : '30';
    const back = `/guilds/${req.guild.id}/insights?range=${range}`;
    if (req.get('HX-Request')) return res.set('HX-Redirect', back).status(204).end();
    res.redirect(back);
  })
);

router.post(
  '/:guildId/general',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const back = `/guilds/${guild.id}/general`;

    // Mod-log channel (empty = disabled).
    const channelId = String(req.body.modlogChannelId ?? '').trim();
    if (channelId === '') {
      await setModlogChannel(guild.id, null);
      await recordAudit(guild.id, {
        actor: moderatorDisplayName(req),
        action: 'settings:modlog',
        detail: 'disabled',
      });
      return res.redirect(`${back}?msg=saved`);
    }
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !guildTextChannels(guild).some((c) => c.id === channelId)) {
      return res.redirect(`${back}?msg=badchannel`);
    }
    if (!channel.permissionsFor(guild.members.me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
      return res.redirect(`${back}?msg=perms`);
    }
    await setModlogChannel(guild.id, channelId);
    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: 'settings:modlog',
      detail: `#${channel.name}`,
    });
    res.redirect(`${back}?msg=saved`);
  })
);

router.post(
  '/:guildId/commands/:command',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const command = req.params.command;
    const hx = Boolean(req.get('HX-Request'));
    if (!runtime.client?.commands?.has(command)) {
      if (hx) {
        return res
          .status(404)
          .set('HX-Trigger', JSON.stringify({ toast: { msg: 'Unknown command', kind: 'bad' } }))
          .end();
      }
      return res.redirect(`/guilds/${guild.id}/commands?msg=badcommand`);
    }
    // Accepts an array (multi-select) or a comma/space-separated string of ids.
    const toIds = (v) =>
      (Array.isArray(v) ? v : v == null ? [] : String(v).split(/[\s,]+/))
        .map((s) => String(s).trim())
        .filter((s) => /^\d{17,20}$/.test(s));

    const on = req.body.enabled === 'on' || req.body.enabled === 'true';
    await setCommandOverride(guild.id, command, {
      enabled: on,
      allowedChannels: toIds(req.body.channels),
      allowedRoles: toIds(req.body.roles),
    });
    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: `command:/${command}`,
      detail: on ? 'updated limits' : 'disabled',
    });
    if (hx) {
      return res
        .status(204)
        .set('HX-Trigger', JSON.stringify({ toast: { msg: `/${command} updated`, kind: 'ok' } }))
        .end();
    }
    res.redirect(`/guilds/${guild.id}/commands?msg=saved`);
  })
);

router.post(
  '/:guildId/warnings',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const back = `/guilds/${guild.id}/moderation`;

    const userId = parseUserId(req.body.userId);
    const reason = String(req.body.reason ?? '')
      .trim()
      .slice(0, 400);
    if (!userId || reason === '') return res.redirect(`${back}?tab=infr&msg=baduser`);

    const user = await runtime.client.users.fetch(userId).catch(() => null);
    if (!user) return res.redirect(`${back}?tab=infr&msg=baduser`);
    if (user.bot) return res.redirect(`${back}?tab=infr&msg=botuser`);

    const { id, count } = await addWarning({
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
    res.redirect(`${back}?tab=infr&msg=${logged ? 'warned' : 'warned-nolog'}`);
  })
);

// Edit a case's reason (dashboard equivalent of /case reason).
router.post(
  '/:guildId/cases/reason',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const back = `/guilds/${guild.id}/moderation?tab=infr`;
    const n = Number(req.body.caseNumber);
    const reason = String(req.body.reason ?? '')
      .trim()
      .slice(0, 1000);
    if (!Number.isInteger(n) || n < 1 || reason === '' || !(await getCase(guild.id, n))) {
      return res.redirect(`${back}&msg=warn-gone`);
    }
    await editCaseReason(guild.id, n, reason);
    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: 'moderation:case-reason',
      detail: `#${n}`,
    });
    res.redirect(`${back}&msg=warn-removed`);
  })
);

// Soft-delete / restore one case (dashboard equivalent of /case delete).
router.post(
  '/:guildId/cases/:n/:op',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const back = `/guilds/${guild.id}/moderation?tab=infr`;
    if (req.params.op !== 'delete' && req.params.op !== 'restore') return res.redirect(back);
    const n = Number(req.params.n);
    const active = req.params.op === 'restore';

    const existing = Number.isInteger(n) ? await getCase(guild.id, n) : null;
    if (!existing) return res.redirect(`${back}&msg=warn-gone`);
    await setCaseActive(guild.id, n, active);

    const target = await runtime.client.users.fetch(existing.user_id).catch(() => null);
    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle(active ? `Case #${n} restored` : `Case #${n} deleted`)
      .addFields(
        {
          name: 'User',
          value: target ? `${target.tag} (\`${existing.user_id}\`)` : `\`${existing.user_id}\``,
        },
        { name: 'Original reason', value: existing.reason || '—' },
        { name: active ? 'Restored by' : 'Deleted by', value: moderatorDisplayName(req) }
      )
      .setTimestamp(Date.now());
    await postModLog(guild, embed);
    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: `moderation:case-${req.params.op}`,
      detail: `#${n}`,
    });
    res.redirect(`${back}&msg=warn-removed`);
  })
);

// Delete every warning for one member (dashboard equivalent of /warn clear).
router.post(
  '/:guildId/warnings/clear',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const back = `/guilds/${guild.id}/moderation?tab=infr`;
    const userId = parseUserId(req.body.userId);
    if (!userId) return res.redirect(`${back}&msg=baduser`);

    const n = await clearWarnings(guild.id, userId);
    if (n === 0) return res.redirect(`${back}&msg=warn-none`);

    const target = await runtime.client.users.fetch(userId).catch(() => null);
    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('Warnings cleared')
      .addFields(
        { name: 'User', value: target ? `${target.tag} (\`${userId}\`)` : `\`${userId}\`` },
        { name: 'Removed', value: `${n} warning${n === 1 ? '' : 's'}` },
        { name: 'Moderator', value: moderatorDisplayName(req) }
      )
      .setTimestamp(Date.now());
    await postModLog(guild, embed);
    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: 'moderation:warn-clear',
      detail: `${n} for ${userId}`,
    });
    res.redirect(`${back}&msg=warn-cleared`);
  })
);

export default router;
