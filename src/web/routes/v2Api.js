// JSON API for the V2 dashboard SPA (web-v2/). Mounted at /api/v2, entirely
// after the app-wide requireAuth (src/web/server.js), so every route here
// already has a signed-in req.session.user — same cookie-session V1 uses,
// nothing new. Read-only reuse of V1's data-layer functions (baseContext,
// getGuild, requireGuildAdmin) — none of them are modified by this file.
import { createRequire } from 'node:module';
import { Router, raw } from 'express';
import { PermissionFlagsBits } from 'discord.js';
import {
  requireGuildAdmin,
  requireOwner,
  requireRealUser,
  isOwner,
  manageableGuilds,
  currentUser,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getGuild, baseContext, assignableRoles } from '../lib/guildContext.js';
import { guildTextChannels, guildVoiceChannels, resolveUserTags } from '../lib/discord.js';
import { buildOverview } from '../lib/overviewSummary.js';
import { getDashboardVersion, setDashboardVersion, DASHBOARD_VERSIONS } from '../../db/userPrefs.js';
import {
  ROADMAP_STATUSES,
  listPublicPosts,
  listPendingPosts,
  listUserPending,
  createPost as createRoadmapPost,
  setPostStatus as setRoadmapPostStatus,
  updatePost as updateRoadmapPost,
  deletePost as deleteRoadmapPost,
  toggleVote as toggleRoadmapVote,
  getPost as getRoadmapPost,
  groupPublicPosts,
  cleanTitle as cleanRoadmapTitle,
  cleanDescription as cleanRoadmapDescription,
} from '../../db/roadmap.js';
import { mdToHtml } from '../lib/markdown.js';
import { voteLimit as roadmapVoteLimit, suggestLimit as roadmapSuggestLimit } from './roadmap.js';
import { getGuildModule, setGuildModule } from '../../db/modules.js';
import { normaliseLevelingConfig } from '../../modules/leveling.js';
import {
  normaliseAutomodConfig,
  AUTOMOD_RULES,
  AUTOMOD_ACTIONS,
  NATIVE_MAPPABLE,
  PRESET_KEYS,
} from '../../modules/automod.js';
import { normaliseHoneypotConfig, HONEYPOT_ACTIONS, ensureHoneypotMessages } from '../../modules/honeypot.js';
import { recentHoneypotCatches } from '../../db/honeypotCatches.js';
import { primeGuild as primeInviteCache } from '../../modules/inviteTracker.js';
import { syncGuildAutomod } from '../../bot/lib/automodSync.js';
import { syncGuildCustomCommands } from '../../bot/lib/customCommandSync.js';
import { WELCOME_PLACEHOLDERS } from '../../modules/welcome.js';
import { normaliseBirthdaysConfig } from '../../modules/birthdays.js';
import { normaliseAppealsConfig } from '../../modules/appeals.js';
import { normaliseThresholds, THRESHOLD_ACTIONS } from '../../modules/moderation.js';
import { normaliseServerStats, STAT_TYPES } from '../../modules/serverStats.js';
import { normaliseAutoresponder, AR_MATCH_MODES, AR_PLACEHOLDERS } from '../../modules/autoresponder.js';
import { normaliseInviteTrackerConfig } from '../../modules/inviteTracker.js';
import { topInviters, inviterCount, setBonus } from '../../db/inviteTracker.js';
import { normaliseTwitchConfig, DEFAULT_MESSAGE as TWITCH_DEFAULT_MSG } from '../../modules/twitchAlerts.js';
import { normaliseKickConfig, DEFAULT_MESSAGE as KICK_DEFAULT_MSG } from '../../modules/kickAlerts.js';
import { normaliseRssConfig, DEFAULT_TEMPLATE as RSS_DEFAULT_TPL, FEED_TYPES } from '../../modules/rss.js';
import { clearScope } from '../../db/postedKeys.js';
import { dailySeries, hourlySeries, topChannels, topVoiceChannels } from '../../db/insights.js';
import { flushGuild as flushGuildInsights } from '../../modules/insights.js';
import { recentLookups } from '../../db/cache.js';
import { normaliseGiveawaysConfig, endGiveaway } from '../../modules/giveaways.js';
import {
  listComposed,
  getComposed,
  createComposed,
  updateComposed,
  deleteComposed,
} from '../../db/composedMessages.js';
import { sendComposed, editComposed } from '../../modules/messageCreator.js';
import {
  activeGiveaways,
  endedGiveaways,
  giveawayEntryCount,
  getGiveawayInGuild,
} from '../../db/giveaways.js';
import { getCounting, setCount, resetCount } from '../../db/counting.js';
import { listCountingPenalties, clearCountingPenalty } from '../../db/countingPenalties.js';
import { normaliseAutoReact, AUTO_REACT_MODES, AUTO_REACT_ROLE_ACTIONS } from '../../modules/autoReact.js';
import { LOG_EVENTS } from '../../modules/logging.js';
import {
  normaliseVerificationConfig,
  VERIFY_MODES,
  ensureVerifyMessage,
} from '../../modules/verification.js';
import {
  topMembers,
  topMembersForPeriod,
  memberCount,
  memberCountForPeriod,
  periodKeys,
} from '../../db/leveling.js';
import { getVanitySlug, setVanitySlug, clearVanitySlug } from '../../db/leaderboardVanity.js';
import {
  getGuildSettings,
  setModlogChannel,
  getBotMasterRoles,
  setBotMasterRoles,
  setEmbedColor,
  guildEmbedColor,
} from '../../db/guildSettings.js';
import { recordAudit } from '../../db/audit.js';
import { runtime, uptimeSeconds, isDiscordReady, guildCount } from '../../runtime.js';
import {
  getPresenceConfig,
  setPresenceConfig,
  PRESENCE_TYPES,
  PRESENCE_STATUSES,
} from '../../db/appSettings.js';
import { applyPresence } from '../../bot/lib/presence.js';
import { config } from '../../config.js';
import { dashboardStats, moduleUsage } from '../../db/dashboardStats.js';
import {
  listBackups,
  runBackup,
  deleteBackup,
  dbFileInfo,
  importBuffer,
  restoreFromBackup,
  resolveBackup,
  inspectDbFile,
} from '../../db/backup.js';
import { offsiteBackupStatus } from '../../db/offsiteBackup.js';
import { MODULES, getModule } from '../../modules/registry.js';
import { timeAgo, formatUptime, formatBytes } from '../lib/format.js';
import { log } from '../../lib/log.js';
import { sendDevLogTest } from '../../lib/devLog.js';

const require = createRequire(import.meta.url);
const { version } = require('../../../package.json');

// Same budget as V1's /health equivalent (src/web/routes/health.js) — a
// stuck script shouldn't be able to fill the disk or thrash restarts. Keyed
// by mount path + IP, so this is an independent bucket from V1's, not shared.
const backupLimit = rateLimit({
  windowMs: 60_000,
  max: 12,
  message: 'Too many backup operations — wait a minute.',
});

const router = Router();

// Mirrors guilds.js's private moderatorDisplayName() — used for audit-log
// "actor" strings, same convention V1 uses.
function moderatorDisplayName(req) {
  return currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`;
}

// Mirrors guilds.js's private parseUserId() — a raw snowflake or an
// `<@id>`/`<@!id>` mention, as pasted straight out of Discord.
function parseUserId(raw) {
  const m = String(raw ?? '')
    .trim()
    .match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/);
  return m ? m[1] || m[2] : null;
}

// Mirrors guilds.js's private clampDays() — a "delete after N days" field
// where 0 (or junk) means keep forever.
function clampDays(raw) {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : 0;
}

// Same list V1's server switcher and "Choose a server" picker use
// (src/web/middleware/auth.js:129) — the SPA's own guild picker.
router.get('/guilds', (req, res) => {
  res.json({ guilds: manageableGuilds(req) });
});

// The SPA is served as static files (no EJS), so it has no <meta
// name="csrf-token"> to read the way V1's pages do — this hands it the same
// per-session token the shared `csrf` middleware already put on
// req.session.csrf, for the x-csrf-token header on state-changing calls.
router.get('/csrf', (req, res) => {
  res.json({ token: req.session?.csrf ?? null });
});

router.get(
  '/prefs',
  asyncHandler(async (req, res) => {
    res.json({ dashboardVersion: await getDashboardVersion(req.session.user.id) });
  })
);

router.post(
  '/prefs',
  asyncHandler(async (req, res) => {
    const requested = req.body?.dashboardVersion;
    if (!DASHBOARD_VERSIONS.includes(requested)) {
      return res
        .status(400)
        .json({ error: `dashboardVersion must be one of ${DASHBOARD_VERSIONS.join(', ')}` });
    }
    const dashboardVersion = await setDashboardVersion(req.session.user.id, requested);
    res.json({ dashboardVersion });
  })
);

// Mirrors the loadGuild + requireGuildAdmin pair guilds.js uses for every
// /:guildId route (guilds.js:221-231) — can't import loadGuild directly,
// it's a private, unexported function in that file, so this is the same
// three lines reimplemented for JSON instead of the `guild-missing` view.
function loadGuildJson(req, res, next) {
  req.guild = getGuild(req);
  if (!req.guild) return res.status(404).json({ error: 'Unknown or unavailable server' });
  next();
}
// Note: requireGuildAdmin's failure paths render V1's HTML error/login
// pages, not JSON (it's shared, unmodified V1 code) — the web-v2 fetch
// wrapper checks response.ok/content-type before parsing JSON and falls
// back to a plain "log in" / "no access" state rather than crashing on it.
router.use('/guilds/:guildId', loadGuildJson, requireGuildAdmin);

router.get(
  '/guilds/:guildId/overview',
  asyncHandler(async (req, res) => {
    // baseContext for the guild/ticket/appeal summary; buildOverview (the
    // same view-model V1's own "Combined Overview" page uses, see
    // src/web/lib/overviewSummary.js) for the category-grouped module cards
    // — reused wholesale rather than re-deriving the same grouping here.
    const [{ guild, openTickets, openAppeals }, { groups }] = await Promise.all([
      baseContext(req.guild, 'overview'),
      buildOverview(req.guild),
    ]);
    res.json({ guild, openTickets, openAppeals, groups });
  })
);

// Toggle a module on/off — mirrors guilds.js:2671-2721 (minus the htmx
// branch, this is a plain JSON API). Same per-module side effects on
// enable/disable as V1: re-sync custom commands, prime the invite-tracker
// cache, push/tear down automod's native Discord AutoMod rules.
router.post(
  '/guilds/:guildId/modules/:moduleId',
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
      const cfg = normaliseAutomodConfig((await getGuildModule(req.guild.id, 'automod')).config);
      const target = enabled ? cfg : { ...cfg, native: { ...cfg.native, enabled: false } };
      syncGuildAutomod(req.guild, target).catch((err) =>
        log.error('automod', 'native sync after toggle failed:', err.message)
      );
    }
    res.json({ enabled });
  })
);

// --- Per-module config ------------------------------------------------------
// One GET+POST pair per module, added as each gets a real V2 form (see
// web-v2/src/moduleForms/) — mirrors guilds.js's shared `/m/:moduleId/config`
// route (guilds.js:1014 on), which handles all 32 modules in one big
// if/else keyed on form-encoded field names. There's no way to generalise
// that across modules (every module's config shape and field names are
// different), so each gets its own small pair here instead, same as
// Leaderboard/Settings/Personalizer/Health already do.

router.get(
  '/guilds/:guildId/modules/afk/config',
  asyncHandler(async (req, res) => {
    const { config } = await getGuildModule(req.guild.id, 'afk');
    res.json({
      config: {
        setNickname: config.setNickname !== false,
        mentionReply: config.mentionReply !== false,
        ignoreChannels: Array.isArray(config.ignoreChannels) ? config.ignoreChannels : [],
      },
      channels: guildTextChannels(req.guild),
    });
  })
);

router.post(
  '/guilds/:guildId/modules/afk/config',
  asyncHandler(async (req, res) => {
    const config = {
      setNickname: Boolean(req.body.setNickname),
      mentionReply: Boolean(req.body.mentionReply),
      ignoreChannels: [].concat(req.body.ignoreChannels ?? []).filter((id) => /^\d{17,20}$/.test(id)),
    };
    await setGuildModule(req.guild.id, 'afk', { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:afk',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

router.get(
  '/guilds/:guildId/modules/welcome/config',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const { config: cfg } = await getGuildModule(guild.id, 'welcome');
    const rolesModule = await getGuildModule(guild.id, 'roles');
    const picked = Array.isArray(rolesModule.config.autoroles) ? rolesModule.config.autoroles : [];
    const verification = await getGuildModule(guild.id, 'verification');

    // Same explicit-flag-with-old-config-fallback as welcome.ejs (the toggle-
    // reverts-on-save bug fixed for issue #197) — never infer "on" from
    // content for a config that has an explicit flag already.
    const joinEnabled =
      cfg.joinEnabled !== undefined
        ? Boolean(cfg.joinEnabled)
        : Boolean(cfg.joinChannel && String(cfg.joinMessage || '').trim());
    const dmEnabled =
      cfg.dmEnabled !== undefined ? Boolean(cfg.dmEnabled) : Boolean(String(cfg.dmMessage || '').trim());
    const leaveEnabled =
      cfg.leaveEnabled !== undefined
        ? Boolean(cfg.leaveEnabled)
        : Boolean(cfg.leaveChannel && String(cfg.leaveMessage || '').trim());
    const autoroleEnabled =
      cfg.autoroleEnabled !== undefined ? Boolean(cfg.autoroleEnabled) : picked.length > 0;

    res.json({
      config: {
        joinEnabled,
        joinChannel: cfg.joinChannel || '',
        joinMessage: cfg.joinMessage || '',
        useEmbed: Boolean(cfg.useEmbed),
        card: Boolean(cfg.card),
        cardBackground: cfg.cardBackground || '',
        dmEnabled,
        dmMessage: cfg.dmMessage || '',
        leaveEnabled,
        leaveChannel: cfg.leaveChannel || '',
        leaveMessage: cfg.leaveMessage || '',
        autoroleEnabled,
        autoroles: picked,
      },
      channels: guildTextChannels(guild),
      roles: assignableRoles(guild),
      verificationEnabled: verification.enabled,
      placeholders: WELCOME_PLACEHOLDERS,
    });
  })
);

router.post(
  '/guilds/:guildId/modules/welcome/config',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const chan = (v) => (/^\d{17,20}$/.test(v ?? '') ? v : '');
    const joinOn = Boolean(req.body.joinEnabled);
    const dmOn = Boolean(req.body.dmEnabled);
    const leaveOn = Boolean(req.body.leaveEnabled);
    const cardBg = String(req.body.cardBackground ?? '').trim();
    const config = {
      joinEnabled: joinOn,
      joinChannel: joinOn ? chan(req.body.joinChannel) : '',
      joinMessage: joinOn ? String(req.body.joinMessage ?? '').slice(0, 1500) : '',
      leaveEnabled: leaveOn,
      leaveChannel: leaveOn ? chan(req.body.leaveChannel) : '',
      leaveMessage: leaveOn ? String(req.body.leaveMessage ?? '').slice(0, 1500) : '',
      dmEnabled: dmOn,
      dmMessage: dmOn ? String(req.body.dmMessage ?? '').slice(0, 1500) : '',
      useEmbed: Boolean(req.body.useEmbed),
      card: Boolean(req.body.card),
      cardBackground: /^https:\/\/\S+$/i.test(cardBg) ? cardBg.slice(0, 500) : '',
    };
    const autoOn = Boolean(req.body.autoroleEnabled);
    config.autoroleEnabled = autoOn;
    const newRoles = autoOn ? [].concat(req.body.autoroles ?? []).filter((r) => /^\d{17,20}$/.test(r)) : [];
    const rolesMod = await getGuildModule(guild.id, 'roles');
    await setGuildModule(guild.id, 'roles', {
      enabled: rolesMod.enabled || newRoles.length > 0,
      config: { ...rolesMod.config, autoroles: newRoles },
    });
    await setGuildModule(guild.id, 'welcome', { config });
    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:welcome',
      detail: 'settings saved',
    });
    res.json({ config: { ...config, autoroles: newRoles } });
  })
);

router.get(
  '/guilds/:guildId/modules/birthdays/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'birthdays');
    res.json({
      config: normaliseBirthdaysConfig(cfg),
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
    });
  })
);

router.post(
  '/guilds/:guildId/modules/birthdays/config',
  asyncHandler(async (req, res) => {
    const config = normaliseBirthdaysConfig(req.body);
    await setGuildModule(req.guild.id, 'birthdays', { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:birthdays',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

router.get(
  '/guilds/:guildId/modules/verification/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'verification');
    res.json({
      config: normaliseVerificationConfig(cfg),
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
      modes: VERIFY_MODES,
      turnstileEnabled: config.turnstileEnabled,
    });
  })
);

router.post(
  '/guilds/:guildId/modules/verification/config',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const prev = (await getGuildModule(guild.id, 'verification')).config;
    const cfg = normaliseVerificationConfig({
      mode: req.body.mode,
      verifiedRoleId: req.body.verifiedRoleId,
      channelId: req.body.channelId,
      messageId: prev.messageId, // bot-managed, not form-editable
      title: req.body.title,
      message: req.body.message,
      successMessage: req.body.successMessage,
      logChannelId: req.body.logChannelId,
      kickAfterMinutes: req.body.kickAfterMinutes,
    });
    await setGuildModule(guild.id, 'verification', { config: cfg });
    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:verification',
      detail: 'settings saved',
    });
    ensureVerifyMessage(guild, cfg).catch((err) =>
      log.error('verification', 'ensure message after save failed:', err.message)
    );
    res.json({ config: cfg });
  })
);

router.get(
  '/guilds/:guildId/modules/honeypot/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'honeypot');
    res.json({
      config: normaliseHoneypotConfig(cfg),
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
      actions: HONEYPOT_ACTIONS,
      catches: (await recentHoneypotCatches(req.guild.id, 25)).map((c) => ({
        userTag: c.user_tag,
        kind: c.kind,
        channelName: req.guild.channels.cache.get(c.channel_id)?.name ?? 'deleted channel',
        action: c.action,
        ago: timeAgo(c.created_at),
      })),
    });
  })
);

router.post(
  '/guilds/:guildId/modules/honeypot/config',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    // messageId and triggerCount are bot-managed — never trust whatever the
    // client echoes back, re-derive both server-side by channelId, same as
    // the V1 form branch.
    const prev = (await getGuildModule(guild.id, 'honeypot')).config;
    const prevMsgByChannel = new Map((prev.messages ?? []).map((m) => [m.channelId, m]));
    const prevChanByChannel = new Map((prev.channels ?? []).map((c) => [c.channelId, c]));
    const rawChannels = Array.isArray(req.body.channels) ? req.body.channels : [];
    const rawMessages = Array.isArray(req.body.messages) ? req.body.messages : [];
    const config = normaliseHoneypotConfig({
      exemptRoles: req.body.exemptRoles,
      channels: rawChannels.map((c) => ({
        ...c,
        triggerCount: prevChanByChannel.get(c.channelId)?.triggerCount ?? 0,
      })),
      messages: rawMessages.map((m) => ({
        ...m,
        messageId: prevMsgByChannel.get(m.channelId)?.messageId ?? '',
        triggerCount: prevMsgByChannel.get(m.channelId)?.triggerCount ?? 0,
      })),
    });
    await setGuildModule(guild.id, 'honeypot', { config });
    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:honeypot',
      detail: 'settings saved',
    });
    ensureHoneypotMessages(guild, config).catch((err) =>
      log.error('honeypot', 'ensure message after save failed:', err.message)
    );
    res.json({ config });
  })
);

router.get(
  '/guilds/:guildId/modules/free-games/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'free-games');
    res.json({
      config: {
        channelId: cfg.channelId || '',
        roleId: cfg.roleId || '',
      },
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
    });
  })
);

router.post(
  '/guilds/:guildId/modules/free-games/config',
  asyncHandler(async (req, res) => {
    const config = {
      channelId: /^\d{17,20}$/.test(req.body.channelId ?? '') ? req.body.channelId : '',
      roleId: /^\d{17,20}$/.test(req.body.roleId ?? '') ? req.body.roleId : '',
    };
    await setGuildModule(req.guild.id, 'free-games', { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:free-games',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

router.get(
  '/guilds/:guildId/modules/counting/config',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const { config: cfg } = await getGuildModule(guild.id, 'counting');
    const state = await getCounting(guild.id);
    const penalties = await listCountingPenalties(guild.id);
    res.json({
      config: {
        channelId: cfg.channelId || '',
        react: cfg.react !== false,
        allowSameUser: Boolean(cfg.allowSameUser),
        resetOnFail: cfg.resetOnFail !== false,
        penaltyRoleId: cfg.penaltyRoleId || '',
        penaltyMinutes: cfg.penaltyMinutes || 15,
      },
      channels: guildTextChannels(guild),
      roles: assignableRoles(guild),
      state: {
        current: state.current,
        record: state.record,
        lastUserId: state.last_user_id,
      },
      penalties: penalties.map((p) => ({
        userId: p.user_id,
        label: guild.members.cache.get(p.user_id)?.user.tag ?? p.user_id,
        roleName: guild.roles.cache.get(p.role_id)?.name ?? p.role_id,
        restoreAt: Number(p.restore_at),
      })),
    });
  })
);

router.post(
  '/guilds/:guildId/modules/counting/config',
  asyncHandler(async (req, res) => {
    const penaltyMinutes = Math.round(Number(req.body.penaltyMinutes));
    const config = {
      channelId: /^\d{17,20}$/.test(req.body.channelId ?? '') ? req.body.channelId : '',
      allowSameUser: Boolean(req.body.allowSameUser),
      resetOnFail: Boolean(req.body.resetOnFail),
      react: Boolean(req.body.react),
      penaltyRoleId: /^\d{17,20}$/.test(req.body.penaltyRoleId ?? '') ? req.body.penaltyRoleId : '',
      penaltyMinutes:
        Number.isFinite(penaltyMinutes) && penaltyMinutes > 0 ? Math.min(penaltyMinutes, 10080) : 15,
    };
    await setGuildModule(req.guild.id, 'counting', { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:counting',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

router.post(
  '/guilds/:guildId/modules/counting/count',
  asyncHandler(async (req, res) => {
    if (req.body.reset === true) {
      await resetCount(req.guild.id);
      await recordAudit(req.guild.id, {
        actor: moderatorDisplayName(req),
        action: 'counting:reset',
        detail: 'count set to 0',
      });
      return res.json({ state: await getCounting(req.guild.id) });
    }
    const n = Number(req.body.current);
    if (!Number.isInteger(n) || n < 0 || n > 1e12) {
      return res.status(400).json({ error: 'Invalid count' });
    }
    await setCount(req.guild.id, n);
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'counting:set',
      detail: `count = ${n}`,
    });
    res.json({ state: await getCounting(req.guild.id) });
  })
);

router.post(
  '/guilds/:guildId/modules/counting/penalty/release',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const userId = String(req.body.userId ?? '');
    if (!/^\d{17,20}$/.test(userId)) return res.status(400).json({ error: 'Invalid user' });

    const cfg = (await getGuildModule(guild.id, 'counting')).config;
    const role = cfg.penaltyRoleId ? guild.roles.cache.get(cfg.penaltyRoleId) : null;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (role && member && !member.roles.cache.has(role.id) && role.editable) {
      await member.roles.add(role, 'Counting: bench ended early from the dashboard').catch(() => {});
    }
    await clearCountingPenalty(guild.id, userId);
    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: 'counting:unbench',
      detail: `released ${userId}`,
    });
    res.json({ ok: true });
  })
);

router.get(
  '/guilds/:guildId/modules/auto-react/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'auto-react');
    res.json({
      config: normaliseAutoReact(cfg),
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
      modes: AUTO_REACT_MODES,
      roleActions: AUTO_REACT_ROLE_ACTIONS,
    });
  })
);

router.post(
  '/guilds/:guildId/modules/auto-react/config',
  asyncHandler(async (req, res) => {
    // The form sends a raw "target users" string per rule (IDs/@mentions,
    // space/comma separated), same as V1's rx_users field — split it into
    // ids here rather than pushing that parsing into the React form.
    const rules = Array.isArray(req.body.rules) ? req.body.rules : [];
    const config = normaliseAutoReact({
      cooldownSeconds: req.body.cooldownSeconds,
      logChannelId: req.body.logChannelId,
      rules: rules.map((r) => ({
        targetUsers: String(r.targetUsersText ?? '')
          .split(/[\s,]+/)
          .map((s) => parseUserId(s))
          .filter(Boolean),
        targetRoles: r.targetRoleId ? [r.targetRoleId] : [],
        emojis: r.emojis,
        mode: r.mode,
        chance: r.chance,
        roleId: r.roleId,
        roleAction: r.roleAction,
        channelId: r.channelId,
      })),
    });
    await setGuildModule(req.guild.id, 'auto-react', { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:auto-react',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

router.get(
  '/guilds/:guildId/modules/moderation/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'moderation');
    res.json({
      config: {
        dmOnPunish: cfg.dmOnPunish !== false,
        warnThresholds: normaliseThresholds(cfg.warnThresholds),
        infractionRetentionDays: Number(cfg.infractionRetentionDays) || 0,
      },
      thresholdActions: THRESHOLD_ACTIONS,
    });
  })
);

router.post(
  '/guilds/:guildId/modules/moderation/config',
  asyncHandler(async (req, res) => {
    const config = {
      dmOnPunish: req.body.dmOnPunish !== false,
      warnThresholds: normaliseThresholds(req.body.warnThresholds),
      infractionRetentionDays: clampDays(req.body.infractionRetentionDays),
    };
    await setGuildModule(req.guild.id, 'moderation', { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:moderation',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

router.get(
  '/guilds/:guildId/modules/automod/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'automod');
    const settings = await getGuildSettings(req.guild.id);
    res.json({
      config: normaliseAutomodConfig(cfg),
      channels: guildTextChannels(req.guild),
      automodRules: AUTOMOD_RULES,
      automodActions: AUTOMOD_ACTIONS,
      nativeMappable: NATIVE_MAPPABLE,
      presetKeys: PRESET_KEYS,
      modlogChannelId: settings?.modlog_channel_id || '',
    });
  })
);

router.post(
  '/guilds/:guildId/modules/automod/config',
  asyncHandler(async (req, res) => {
    // Immunity (exempt) roles are managed on the Admin tab, not this form —
    // keep whatever is already stored, same as V1's guilds.js.
    const prev = (await getGuildModule(req.guild.id, 'automod')).config;
    const config = normaliseAutomodConfig({
      deleteMessage: true,
      timeoutMinutes: req.body.timeoutMinutes,
      exemptChannels: req.body.exemptChannels,
      exemptRoles: prev.exemptRoles ?? [],
      native: req.body.native,
      rules: req.body.rules,
    });
    await setGuildModule(req.guild.id, 'automod', { config });

    let nativeNote = '';
    let nativeWarned = false;
    const r = await syncGuildAutomod(req.guild, config);
    if (r.skipped === 'missing-permission') {
      nativeNote = 'native rules skipped: Sylo needs the Manage Server permission';
      nativeWarned = true;
    } else if (r.skipped === 'fetch-failed' || r.errors.length) {
      nativeNote = 'some native rules could not be updated';
      nativeWarned = true;
    } else if (r.created || r.edited || r.removed) {
      nativeNote = `native rules +${r.created} ~${r.edited} -${r.removed}`;
    }

    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:automod',
      detail: 'settings saved',
    });
    res.json({ config, nativeNote, nativeWarned });
  })
);

router.get(
  '/guilds/:guildId/modules/sticky/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'sticky');
    res.json({
      config: { stickies: Array.isArray(cfg.stickies) ? cfg.stickies : [] },
      channels: guildTextChannels(req.guild),
    });
  })
);

router.post(
  '/guilds/:guildId/modules/sticky/config',
  asyncHandler(async (req, res) => {
    // lastMessageId is bot-managed (the currently-posted sticky message per
    // channel) — carried over from the previous config by channelId, same
    // as V1's guilds.js, rather than letting the form touch it.
    const prev = (await getGuildModule(req.guild.id, 'sticky')).config;
    const prevById = new Map((prev.stickies ?? []).map((s) => [s.channelId, s]));
    const rows = Array.isArray(req.body.stickies) ? req.body.stickies : [];
    const stickies = rows
      .map((s) => ({
        channelId: s.channelId,
        content: String(s.content ?? '').slice(0, 2000),
        lastMessageId: prevById.get(s.channelId)?.lastMessageId ?? null,
        repostOnBots: Boolean(s.repostOnBots),
        cooldownSeconds: Math.max(0, Math.min(3600, Math.floor(Number(s.cooldownSeconds)) || 0)),
      }))
      .filter((s) => /^\d{17,20}$/.test(s.channelId) && s.content.trim() !== '');
    const config = { stickies };
    await setGuildModule(req.guild.id, 'sticky', { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:sticky',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

router.get(
  '/guilds/:guildId/modules/server-stats/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'server-stats');
    res.json({
      config: normaliseServerStats(cfg),
      voiceChannels: guildVoiceChannels(req.guild),
      statTypes: STAT_TYPES,
    });
  })
);

router.post(
  '/guilds/:guildId/modules/server-stats/config',
  asyncHandler(async (req, res) => {
    const config = normaliseServerStats({
      refreshMinutes: req.body.refreshMinutes,
      channels: req.body.channels,
    });
    await setGuildModule(req.guild.id, 'server-stats', { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:server-stats',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

router.get(
  '/guilds/:guildId/modules/autoresponder/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'autoresponder');
    res.json({
      config: normaliseAutoresponder(cfg),
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
      matchModes: AR_MATCH_MODES,
      placeholders: AR_PLACEHOLDERS,
    });
  })
);

router.post(
  '/guilds/:guildId/modules/autoresponder/config',
  asyncHandler(async (req, res) => {
    // embedColor isn't exposed on this form — same as V1, which never sends
    // it either, so normaliseAutoresponder's default applies on every save.
    const config = normaliseAutoresponder({
      cooldownSeconds: req.body.cooldownSeconds,
      ignoreChannels: req.body.ignoreChannels,
      ignoreRoles: req.body.ignoreRoles,
      responders: req.body.responders,
    });
    await setGuildModule(req.guild.id, 'autoresponder', { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:autoresponder',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

async function inviteBoard(guild) {
  const rows = await topInviters(guild.id, 15);
  const tags = await resolveUserTags(
    runtime.client,
    rows.map((r) => r.user_id)
  );
  return {
    total: await inviterCount(guild.id),
    canReadInvites: Boolean(guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)),
    rows: rows.map((r, i) => ({
      rank: i + 1,
      userId: r.user_id,
      name: tags.get(r.user_id) ?? r.user_id,
      net: r.net,
      regular: r.regular,
      leaves: r.leaves,
      bonus: r.bonus,
    })),
  };
}

router.get(
  '/guilds/:guildId/modules/invite-tracker/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'invite-tracker');
    res.json({
      config: normaliseInviteTrackerConfig(cfg),
      channels: guildTextChannels(req.guild),
      board: await inviteBoard(req.guild),
    });
  })
);

router.post(
  '/guilds/:guildId/modules/invite-tracker/config',
  asyncHandler(async (req, res) => {
    const config = normaliseInviteTrackerConfig({
      joinLogChannelId: req.body.joinLogChannelId,
      graceHours: req.body.graceHours,
    });
    await setGuildModule(req.guild.id, 'invite-tracker', { config });
    primeInviteCache(req.guild).catch((err) =>
      log.error('invite-tracker', 'cache prime after save failed:', err.message)
    );
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:invite-tracker',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

router.post(
  '/guilds/:guildId/modules/invite-tracker/bonus',
  asyncHandler(async (req, res) => {
    const userId = parseUserId(req.body.userId);
    const bonus = Number(req.body.bonus);
    if (!userId || !Number.isInteger(bonus) || bonus < -100000 || bonus > 100000) {
      return res.status(400).json({ error: 'Invalid member id or bonus value.' });
    }
    await setBonus(req.guild.id, userId, bonus);
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:invite-tracker',
      detail: `${userId} bonus → ${bonus}`,
    });
    res.json({ board: await inviteBoard(req.guild) });
  })
);

router.get(
  '/guilds/:guildId/modules/twitch-alerts/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'twitch-alerts');
    res.json({
      config: normaliseTwitchConfig(cfg),
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
      twitchEnabled: config.twitchEnabled,
      defaultMessage: TWITCH_DEFAULT_MSG,
    });
  })
);

router.post(
  '/guilds/:guildId/modules/twitch-alerts/config',
  asyncHandler(async (req, res) => {
    const config = normaliseTwitchConfig({ alerts: req.body.alerts });
    await setGuildModule(req.guild.id, 'twitch-alerts', { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:twitch-alerts',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

router.get(
  '/guilds/:guildId/modules/kick-alerts/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'kick-alerts');
    res.json({
      config: normaliseKickConfig(cfg),
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
      kickEnabled: config.kickEnabled,
      defaultMessage: KICK_DEFAULT_MSG,
    });
  })
);

router.post(
  '/guilds/:guildId/modules/kick-alerts/config',
  asyncHandler(async (req, res) => {
    const config = normaliseKickConfig({ alerts: req.body.alerts });
    await setGuildModule(req.guild.id, 'kick-alerts', { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:kick-alerts',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

router.get(
  '/guilds/:guildId/modules/rss/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'rss');
    res.json({
      config: normaliseRssConfig(cfg),
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
      feedTypes: FEED_TYPES,
      defaultTemplate: RSS_DEFAULT_TPL,
    });
  })
);

router.post(
  '/guilds/:guildId/modules/rss/config',
  asyncHandler(async (req, res) => {
    const prevIds = new Set(
      ((await getGuildModule(req.guild.id, 'rss')).config.feeds ?? []).map((f) => f.id)
    );
    const config = normaliseRssConfig({ feeds: req.body.feeds });
    // Drop dedup state for feeds that were removed, so re-adding the same
    // URL later starts fresh rather than silently swallowing a backlog —
    // same cleanup guilds.js's POST handler does.
    const keptIds = new Set(config.feeds.map((f) => f.id));
    for (const id of prevIds) {
      if (!keptIds.has(id)) await clearScope(req.guild.id, `rss:${id}`);
    }
    await setGuildModule(req.guild.id, 'rss', { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:rss',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

// No POST route — this module has nothing to configure beyond the
// enable/disable toggle every module already gets. Read-only, matching
// V1's game-stats.ejs (command docs + the shared lookup cache).
router.get(
  '/guilds/:guildId/modules/game-stats/config',
  asyncHandler(async (req, res) => {
    res.json({
      recent: (await recentLookups(15)).map((r) => ({
        game: r.game,
        title: r.title,
        username: r.username,
        platform: r.platform,
        ago: timeAgo(r.created_at),
      })),
    });
  })
);

router.get(
  '/guilds/:guildId/modules/logging/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'logging');
    res.json({
      config: {
        channel: cfg.channel || '',
        events: Object.fromEntries(LOG_EVENTS.map(([key]) => [key, Boolean(cfg.events?.[key])])),
      },
      channels: guildTextChannels(req.guild),
      logEvents: LOG_EVENTS,
    });
  })
);

router.post(
  '/guilds/:guildId/modules/logging/config',
  asyncHandler(async (req, res) => {
    const config = {
      channel: /^\d{17,20}$/.test(req.body.channel ?? '') ? req.body.channel : '',
      events: Object.fromEntries(LOG_EVENTS.map(([key]) => [key, Boolean(req.body.events?.[key])])),
    };
    await setGuildModule(req.guild.id, 'logging', { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:logging',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

router.get(
  '/guilds/:guildId/modules/tickets/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'tickets');
    res.json({
      config: {
        greeting: cfg.greeting || '',
        closeMessage: cfg.closeMessage || '',
        notifyChannel: cfg.notifyChannel || '',
        staffRoles: Array.isArray(cfg.staffRoles) ? cfg.staffRoles : [],
        transcriptRetentionDays: Number(cfg.transcriptRetentionDays) || 0,
      },
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
    });
  })
);

router.post(
  '/guilds/:guildId/modules/tickets/config',
  asyncHandler(async (req, res) => {
    const config = {
      greeting: String(req.body.greeting ?? '').slice(0, 1500),
      closeMessage: String(req.body.closeMessage ?? '').slice(0, 1500),
      notifyChannel: /^\d{17,20}$/.test(req.body.notifyChannel ?? '') ? req.body.notifyChannel : '',
      staffRoles: [].concat(req.body.staffRoles ?? []).filter((r) => /^\d{17,20}$/.test(r)),
      transcriptRetentionDays: clampDays(req.body.transcriptRetentionDays),
    };
    await setGuildModule(req.guild.id, 'tickets', { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:tickets',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

router.get(
  '/guilds/:guildId/modules/appeals/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'appeals');
    res.json({
      config: normaliseAppealsConfig(cfg),
      channels: guildTextChannels(req.guild),
      dashboardUrlSet: Boolean(config.dashboardUrl),
    });
  })
);

router.post(
  '/guilds/:guildId/modules/appeals/config',
  asyncHandler(async (req, res) => {
    const cfg = normaliseAppealsConfig({
      questions: req.body.questions,
      autoUnbanOnAccept: req.body.autoUnbanOnAccept,
      reviewChannelId: req.body.reviewChannelId,
      cooldownDays: req.body.cooldownDays,
      appealMessage: req.body.appealMessage,
      appealServerInvite: req.body.appealServerInvite,
    });
    await setGuildModule(req.guild.id, 'appeals', { config: cfg });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:appeals',
      detail: 'settings saved',
    });
    res.json({ config: cfg });
  })
);

async function giveawaysList(guild) {
  const channels = guildTextChannels(guild);
  const raw = [
    ...(await activeGiveaways(guild.id)).map((g) => ({ ...g, state: 'active' })),
    ...(await endedGiveaways(guild.id, 8)).map((g) => ({ ...g, state: 'ended' })),
  ];
  return Promise.all(
    raw.map(async (g) => ({
      id: g.id,
      prize: g.prize,
      state: g.state,
      winners: g.winners,
      endsAt: g.ends_at,
      entries: await giveawayEntryCount(g.id),
      wonIds: g.wonIds,
      channel: channels.find((c) => c.id === g.channel_id)?.name ?? g.channel_id,
      requiredRoleId: g.required_role_id,
    }))
  );
}

router.get(
  '/guilds/:guildId/modules/giveaways/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'giveaways');
    res.json({
      config: normaliseGiveawaysConfig(cfg),
      giveaways: await giveawaysList(req.guild),
    });
  })
);

router.post(
  '/guilds/:guildId/modules/giveaways/config',
  asyncHandler(async (req, res) => {
    const config = normaliseGiveawaysConfig({ ping: req.body.ping, dmWinners: req.body.dmWinners });
    await setGuildModule(req.guild.id, 'giveaways', { config });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:giveaways',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

router.post(
  '/guilds/:guildId/modules/giveaways/:id/end',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const g = await getGiveawayInGuild(id, req.guild.id);
    if (!g || g.ended) return res.status(400).json({ error: 'Not an active giveaway' });
    await endGiveaway(id);
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:giveaways',
      detail: `ended #${id}`,
    });
    res.json({ giveaways: await giveawaysList(req.guild) });
  })
);

router.post(
  '/guilds/:guildId/modules/giveaways/:id/reroll',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const g = await getGiveawayInGuild(id, req.guild.id);
    if (!g || !g.ended) return res.status(400).json({ error: 'Not an ended giveaway' });
    const count = Math.max(1, Math.min(Number(req.body.count) || 1, 20));
    await endGiveaway(id, { rerollCount: count });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'module:giveaways',
      detail: `rerolled #${id}`,
    });
    res.json({ giveaways: await giveawaysList(req.guild) });
  })
);

// --- Embed messages (mirrors src/web/routes/guildMessages.js) --------------
// Not a toggleable module (no /modules/:id route, no enable/disable) — its
// own top-level guild-scoped feature, same as Leaderboard/Settings. Overview
// and the sidebar special-case its href instead of assuming the standard
// `/m/:id` module-page path.

const numericId = (v) => /^\d+$/.test(v ?? '');
const specTitle = (spec) => spec?.embeds?.[0]?.title || spec?.content?.slice(0, 60) || '(no text)';

function composedListItem(guild, c) {
  return {
    id: c.id,
    name: c.name || specTitle(c.spec),
    channel: guildTextChannels(guild).find((ch) => ch.id === c.channel_id)?.name ?? c.channel_id,
    published: Boolean(c.message_id),
    when: timeAgo(c.updated_at),
  };
}

function composedRecJson(rec) {
  return { id: rec.id, name: rec.name, channelId: rec.channel_id, messageId: rec.message_id, spec: rec.spec };
}

router.get(
  '/guilds/:guildId/messages',
  asyncHandler(async (req, res) => {
    const items = (await listComposed(req.guild.id, 200)).map((c) => composedListItem(req.guild, c));
    res.json({ items });
  })
);

router.get(
  '/guilds/:guildId/messages/:id',
  asyncHandler(async (req, res) => {
    const isNew = req.params.id === 'new';
    let rec = null;
    if (!isNew) {
      if (!numericId(req.params.id)) return res.status(404).json({ error: 'Not found' });
      rec = await getComposed(req.guild.id, Number(req.params.id));
      if (!rec) return res.status(404).json({ error: 'Not found' });
    }
    res.json({
      isNew,
      rec: rec
        ? composedRecJson(rec)
        : { id: '', name: '', channelId: '', messageId: null, spec: { content: '', embeds: [], rows: [] } },
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
    });
  })
);

router.post(
  '/guilds/:guildId/messages/:id',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const isNew = req.params.id === 'new';
    if (!isNew && !numericId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const existing = isNew ? null : await getComposed(guild.id, Number(req.params.id));
    if (!isNew && !existing) return res.status(404).json({ error: 'Not found' });

    const spec = req.body.spec;
    if (!spec || typeof spec !== 'object') return res.status(400).json({ error: "Missing 'spec'" });
    const normalisedSpec = {
      content: String(spec.content ?? ''),
      embeds: Array.isArray(spec.embeds) ? spec.embeds : [],
      rows: Array.isArray(spec.rows) ? spec.rows : [],
    };
    const name =
      String(req.body.name ?? '')
        .trim()
        .slice(0, 100) || 'Untitled embed';
    const channelId = /^\d{17,20}$/.test(req.body.channelId ?? '') ? req.body.channelId : '';
    const publish = req.body.action === 'publish';

    let rec = existing;
    if (!rec) {
      rec = await createComposed(guild.id, { name, channelId, messageId: null, spec: normalisedSpec });
    } else {
      rec = await updateComposed(guild.id, rec.id, {
        name,
        channelId: channelId || rec.channel_id,
        messageId: rec.message_id,
        spec: normalisedSpec,
      });
    }

    if (!publish) return res.json({ rec: composedRecJson(rec), status: 'saved' });

    if (!/^\d{17,20}$/.test(rec.channel_id)) {
      return res.status(400).json({ error: 'Pick a channel before publishing.', rec: composedRecJson(rec) });
    }
    try {
      if (rec.message_id) {
        await editComposed(guild, rec.channel_id, rec.message_id, normalisedSpec);
        return res.json({ rec: composedRecJson(rec), status: 'updated' });
      }
      const message = await sendComposed(guild, rec.channel_id, normalisedSpec);
      rec = await updateComposed(guild.id, rec.id, {
        name,
        channelId: rec.channel_id,
        messageId: message.id,
        spec: normalisedSpec,
      });
      return res.json({ rec: composedRecJson(rec), status: 'sent' });
    } catch (err) {
      return res.status(400).json({ error: err.message, rec: composedRecJson(rec) });
    }
  })
);

router.post(
  '/guilds/:guildId/messages/:id/unpublish',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    if (!numericId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const rec = await getComposed(guild.id, Number(req.params.id));
    if (!rec) return res.status(404).json({ error: 'Not found' });
    if (rec.message_id) {
      try {
        const ch = guild.channels.cache.get(rec.channel_id) ?? (await guild.channels.fetch(rec.channel_id));
        await ch.messages.delete(rec.message_id);
      } catch {
        /* already gone */
      }
      await updateComposed(guild.id, rec.id, {
        name: rec.name,
        channelId: rec.channel_id,
        messageId: null,
        spec: rec.spec,
      });
    }
    res.json({ rec: composedRecJson(await getComposed(guild.id, rec.id)) });
  })
);

router.post(
  '/guilds/:guildId/messages/:id/delete',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    if (!numericId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const rec = await getComposed(guild.id, Number(req.params.id));
    if (rec) {
      if (rec.message_id) {
        try {
          const ch = guild.channels.cache.get(rec.channel_id) ?? (await guild.channels.fetch(rec.channel_id));
          await ch.messages.delete(rec.message_id);
        } catch {
          /* already gone */
        }
      }
      await deleteComposed(guild.id, rec.id);
    }
    res.json({ ok: true });
  })
);

// --- Leaderboard (mirrors guilds.js:614-696) --------------------------------

router.get(
  '/guilds/:guildId/leaderboard',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const { enabled, config: levelingConfig } = await getGuildModule(guild.id, 'leveling');
    const cfg = normaliseLevelingConfig(levelingConfig);
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
    res.json({
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) },
      levelingEnabled: enabled,
      publicLeaderboard: cfg.publicLeaderboard,
      period,
      vanitySlug: await getVanitySlug(guild.id),
      total,
      rows: rows.map((r, i) => ({
        rank: i + 1,
        name: tags.get(r.user_id) ?? r.user_id,
        level: period === 'all' ? r.level : null,
        xp: r.xp,
        voiceMinutes: r.voice_minutes ?? 0,
        messages: r.messages,
      })),
    });
  })
);

router.post(
  '/guilds/:guildId/leaderboard/public',
  asyncHandler(async (req, res) => {
    const prev = (await getGuildModule(req.guild.id, 'leveling')).config;
    const publicLeaderboard = Boolean(req.body.publicLeaderboard);
    await setGuildModule(req.guild.id, 'leveling', { config: { ...prev, publicLeaderboard } });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'leveling:leaderboard',
      detail: publicLeaderboard ? 'made public' : 'made private',
    });
    res.json({ publicLeaderboard });
  })
);

router.post(
  '/guilds/:guildId/leaderboard/vanity',
  asyncHandler(async (req, res) => {
    const raw = String(req.body.slug ?? '').trim();
    if (raw === '') {
      await clearVanitySlug(req.guild.id);
      await recordAudit(req.guild.id, {
        actor: moderatorDisplayName(req),
        action: 'leveling:vanity',
        detail: 'cleared',
      });
      return res.json({ vanitySlug: null });
    }
    const r = await setVanitySlug(req.guild.id, raw);
    if (!r.ok) return res.status(400).json({ error: r.error });
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: 'leveling:vanity',
      detail: `/lb/${r.slug}`,
    });
    res.json({ vanitySlug: r.slug });
  })
);

// --- Guild settings (mirrors guilds.js:262-324) -----------------------------

router.get(
  '/guilds/:guildId/settings',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const settings = await getGuildSettings(guild.id);
    const color = await guildEmbedColor(guild.id);
    const roles = assignableRoles(guild);
    const stored = new Set(await getBotMasterRoles(guild.id));
    res.json({
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) },
      modlogChannelId: settings?.modlog_channel_id ?? '',
      embedColorHex: '#' + color.toString(16).padStart(6, '0'),
      channels: guildTextChannels(guild),
      roles,
      botMasterRoleIds: [...stored],
    });
  })
);

router.post(
  '/guilds/:guildId/settings',
  asyncHandler(async (req, res) => {
    const guild = req.guild;

    const channelId = String(req.body.modlogChannelId ?? '').trim();
    if (channelId === '') {
      await setModlogChannel(guild.id, null);
    } else if (guildTextChannels(guild).some((c) => c.id === channelId)) {
      await setModlogChannel(guild.id, channelId);
    } else {
      return res.status(400).json({ error: 'Unknown channel' });
    }

    await setBotMasterRoles(guild.id, [].concat(req.body.botMasterRoleIds ?? []));

    const hex = String(req.body.embedColor ?? '').replace('#', '');
    if (req.body.embedColorReset || hex === '') await setEmbedColor(guild.id, null);
    else if (/^[0-9a-fA-F]{6}$/.test(hex)) await setEmbedColor(guild.id, parseInt(hex, 16));
    else return res.status(400).json({ error: 'embedColor must be a 6-digit hex value' });

    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: 'settings:server',
      detail: 'saved',
    });
    res.json({ ok: true });
  })
);

// --- Server insights (mirrors guilds.js:2804-2864) -------------------------

const INSIGHTS_HOURLY = { 24: 24, 48: 48 };
const INSIGHTS_DAILY = { 7: 7, 30: 30, 90: 90 };

router.get(
  '/guilds/:guildId/insights',
  asyncHandler(async (req, res) => {
    const raw = String(req.query.range ?? '30');
    const hourly = raw in INSIGHTS_HOURLY;
    const range = hourly ? INSIGHTS_HOURLY[raw] : (INSIGHTS_DAILY[raw] ?? 30);
    const series = hourly ? await hourlySeries(req.guild.id, range) : await dailySeries(req.guild.id, range);

    // Per-channel totals ("top channels") are only kept daily; for an
    // hourly window fall back to the last day.
    const topDays = hourly ? 1 : range;
    const chans = [...guildTextChannels(req.guild), ...guildVoiceChannels(req.guild)];
    const nameOf = (id) =>
      id.startsWith('name:') ? id.slice(5) : (chans.find((c) => c.id === id)?.name ?? 'deleted channel');

    res.json({
      range,
      granularity: hourly ? 'hour' : 'day',
      series,
      totals: {
        messages: series.reduce((t, d) => t + d.messages, 0),
        joins: series.reduce((t, d) => t + d.joins, 0),
        leaves: series.reduce((t, d) => t + d.leaves, 0),
        net: series.reduce((t, d) => t + d.joins - d.leaves, 0),
        peakActive: series.reduce((m, d) => Math.max(m, d.activeMembers), 0),
        voiceMinutes: series.reduce((t, d) => t + d.voiceMinutes, 0),
        voicePeak: series.reduce((m, d) => Math.max(m, d.voicePeak), 0),
      },
      topChannels: (await topChannels(req.guild.id, topDays, 6)).map((t) => ({
        name: nameOf(t.channelId),
        messages: t.messages,
      })),
      topVoice: (await topVoiceChannels(req.guild.id, topDays, 6)).map((t) => ({
        name: nameOf(t.channelId),
        minutes: t.minutes,
      })),
    });
  })
);

router.post(
  '/guilds/:guildId/insights/refresh',
  asyncHandler(async (req, res) => {
    await flushGuildInsights(req.guild.id);
    res.json({ ok: true });
  })
);

// --- Bot Personalizer (mirrors settings.js) — bot-wide, not per-guild ------
// Gated by the app-wide requireAuth only, same as V1's /settings route: no
// requireGuildAdmin/requireOwner here, matching V1's existing access level
// exactly rather than tightening or loosening it.

router.get('/personalizer', (req, res) => {
  const u = runtime.client?.user ?? null;
  res.json({
    bot: u
      ? {
          tag: u.tag,
          username: u.username,
          id: u.id,
          avatar: u.displayAvatarURL({ size: 128 }),
          banner: u.bannerURL ? u.bannerURL({ size: 512 }) : null,
        }
      : null,
  });
});

router.get(
  '/personalizer/presence',
  asyncHandler(async (req, res) => {
    res.json({ presence: await getPresenceConfig(), types: PRESENCE_TYPES, statuses: PRESENCE_STATUSES });
  })
);

router.post(
  '/personalizer/identity',
  asyncHandler(async (req, res) => {
    const u = runtime.client?.user;
    if (!u) return res.status(503).json({ error: 'The bot is not connected yet — try again in a moment.' });

    const isHttps = (s) => /^https:\/\/\S+$/i.test(s);
    const done = [];
    const failed = [];

    const name = String(req.body.username || '').trim();
    if (name && name !== u.username) {
      if (name.length < 2 || name.length > 32) failed.push('username (2–32 characters)');
      else {
        try {
          await u.setUsername(name);
          done.push('username');
        } catch (e) {
          failed.push(`username (${e.message || 'rejected — Discord limits this to ~2 changes/hour'})`);
        }
      }
    }

    if (req.body.resetAvatar) {
      try {
        await u.setAvatar(null);
        done.push('avatar reset to default');
      } catch {
        failed.push('avatar reset');
      }
    } else {
      const avatar = String(req.body.avatarUrl || '').trim();
      if (avatar) {
        if (!isHttps(avatar)) failed.push('avatar (must be an https image URL)');
        else {
          try {
            await u.setAvatar(avatar);
            done.push('avatar');
          } catch (e) {
            failed.push(`avatar (${e.message || 'could not load that image'})`);
          }
        }
      }
    }

    const banner = String(req.body.bannerUrl || '').trim();
    if (banner) {
      if (!isHttps(banner)) failed.push('banner (must be an https image URL)');
      else {
        try {
          await u.setBanner(banner);
          done.push('banner');
        } catch (e) {
          failed.push(`banner (${e.message || 'not available for this bot'})`);
        }
      }
    }

    res.json({ done, failed });
  })
);

router.post(
  '/personalizer/presence',
  asyncHandler(async (req, res) => {
    const presence = await setPresenceConfig({
      status: req.body.status,
      type: req.body.type,
      text: req.body.text,
    });
    if (runtime.client) applyPresence(runtime.client);
    res.json({ presence });
  })
);

// --- Health (mirrors health.js's owner-only HTML page in full — status,
// stats, module adoption, error log, dev-log test, and backups
// create/download/import/delete/restore. The one thing NOT duplicated here
// is the actual backup-file byte-stream download — that's a GET with no
// JSON body, so the page just links straight to V1's existing
// /health/backups/:name route, same cookie session, same requireOwner gate.)

router.get(
  '/health',
  requireOwner,
  asyncHandler(async (req, res) => {
    const client = runtime.client;
    const guilds = client ? [...client.guilds.cache.values()] : [];
    const memberReach = guilds.reduce((sum, g) => sum + (g.memberCount ?? 0), 0);
    const gatewayPing = client?.ws?.ping;

    const usage = await moduleUsage();
    const modules = MODULES.map((m) => ({ name: m.name, icon: m.icon, guilds: usage.get(m.id) ?? 0 }))
      .filter((m) => m.guilds > 0)
      .sort((a, b) => b.guilds - a.guilds);

    const dbInfo = await dbFileInfo();
    const ready = isDiscordReady();

    res.json({
      ready,
      botTag: client?.user?.tag ?? null,
      version,
      uptime: formatUptime(uptimeSeconds()),
      guildCount: guildCount(),
      memberReach,
      gatewayPing: typeof gatewayPing === 'number' && gatewayPing >= 0 ? Math.round(gatewayPing) : null,
      pingHistory: runtime.pingHistory.slice(),
      stats: await dashboardStats(),
      modules,
      lastError: runtime.lastError,
      lastErrorAgo: runtime.lastError ? timeAgo(runtime.lastError.at) : null,
      errors: runtime.errors
        .slice(0, 25)
        .map((e) => ({ message: e.message, scope: e.scope, ago: timeAgo(e.at) })),
      db: {
        size: formatBytes(dbInfo.size),
        wal: dbInfo.wal === null ? null : formatBytes(dbInfo.wal),
        postgres: Boolean(config.databaseUrl),
        intervalHours: config.backupIntervalHours,
        retention: config.backupRetention,
        offsite: offsiteBackupStatus(),
      },
      backups: listBackups()
        .slice(0, 25)
        .map((b) => ({ name: b.name, size: formatBytes(b.size), ago: timeAgo(b.mtime) })),
      devLogConfigured: Boolean(config.devLogChannelId),
    });
  })
);

router.post(
  '/health/dev-log-test',
  requireOwner,
  backupLimit,
  asyncHandler(async (req, res) => {
    const result = await sendDevLogTest();
    res.json(result.ok ? { ok: true } : { ok: false, error: result.error });
  })
);

router.post('/health/dev-log-error-test', requireOwner, backupLimit, (req, res) => {
  log.error(
    'dev-log-test',
    'Manually triggered from the V2 dashboard — if you see this in the dev-log channel, the real error pipeline works end to end.'
  );
  res.json({ ok: true });
});

router.post(
  '/health/backups',
  requireOwner,
  backupLimit,
  asyncHandler(async (req, res) => {
    try {
      const { name } = await runBackup('manual');
      res.json({ name });
    } catch (err) {
      res.status(500).json({ error: err.message || 'backup failed' });
    }
  })
);

router.post('/health/backups/:name/delete', requireOwner, backupLimit, (req, res) => {
  deleteBackup(req.params.name);
  res.json({ ok: true });
});

router.post(
  '/health/backups/import',
  requireOwner,
  backupLimit,
  raw({ type: () => true, limit: '128mb' }),
  asyncHandler(async (req, res) => {
    const result = await importBuffer(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ name: result.name });
  })
);

// Restores, then exits the process so the container/process manager restarts
// Sylo on the restored data — same as V1. Responds first so the request
// doesn't hang while the process is going down.
router.post(
  '/health/backups/:name/restore',
  requireOwner,
  backupLimit,
  asyncHandler(async (req, res) => {
    const name = req.params.name;
    const full = resolveBackup(name);
    if (!full) return res.status(404).json({ error: 'no such backup' });
    const check = await inspectDbFile(full);
    if (!check.ok) return res.status(400).json({ error: check.error });

    res.json({ ok: true });
    setTimeout(() => {
      restoreFromBackup(name).catch((err) => log.error('db', 'Restore failed:', err.message));
    }, 750);
  })
);

// --- Roadmap (mirrors src/web/routes/roadmap.js's V1 pages in full — bot-
// wide, not per-guild, same as Health/Personalizer above. The vote/suggest
// rate limiters are the *same* instances V1 uses (imported from roadmap.js,
// not re-created here) so a user can't double their effective limit by
// switching between the V1 and V2 UI.)

function withRoadmapHtml(p) {
  return { ...p, descriptionHtml: mdToHtml(p.description) };
}
function roadmapGroupsWithHtml(posts) {
  const groups = groupPublicPosts(posts);
  for (const list of Object.values(groups)) {
    for (const p of list) p.descriptionHtml = mdToHtml(p.description);
  }
  return groups;
}

router.get(
  '/roadmap',
  asyncHandler(async (req, res) => {
    const userId = req.session?.user?.id ?? null;
    const posts = await listPublicPosts(userId);
    const mine = userId ? await listUserPending(userId) : [];
    res.json({
      groups: roadmapGroupsWithHtml(posts),
      mine: mine.map((p) => ({ ...withRoadmapHtml(p), ago: timeAgo(p.createdAt) })),
      isOwner: userId ? isOwner(userId) : false,
    });
  })
);

router.post(
  '/roadmap/:id/vote',
  requireRealUser,
  roadmapVoteLimit,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const post = Number.isInteger(id) ? await getRoadmapPost(id) : null;
    if (!post || post.status === 'pending') return res.status(404).json({ error: 'No such post' });
    res.json(await toggleRoadmapVote(id, req.session.user.id));
  })
);

router.post(
  '/roadmap/suggest',
  requireRealUser,
  roadmapSuggestLimit,
  asyncHandler(async (req, res) => {
    const title = cleanRoadmapTitle(req.body.title);
    const description = cleanRoadmapDescription(req.body.description);
    if (!title || !description) {
      return res.status(400).json({ error: 'Title (3-100 chars) and description are required.' });
    }
    await createRoadmapPost({ title, description, userId: req.session.user.id, status: 'pending' });
    res.json({ ok: true });
  })
);

router.get(
  '/roadmap/admin',
  requireOwner,
  asyncHandler(async (req, res) => {
    const [pending, publicPosts] = await Promise.all([listPendingPosts(), listPublicPosts()]);
    res.json({
      statuses: ROADMAP_STATUSES.filter((s) => s !== 'pending'),
      pending: pending.map((p) => ({ ...withRoadmapHtml(p), ago: timeAgo(p.createdAt) })),
      posts: publicPosts
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((p) => ({ ...withRoadmapHtml(p), ago: timeAgo(p.createdAt) })),
    });
  })
);

router.post(
  '/roadmap/admin',
  requireOwner,
  requireRealUser,
  asyncHandler(async (req, res) => {
    const title = cleanRoadmapTitle(req.body.title);
    const description = cleanRoadmapDescription(req.body.description);
    if (!title || !description) {
      return res.status(400).json({ error: 'Title (3-100 chars) and description are required.' });
    }
    const post = await createRoadmapPost({
      title,
      description,
      userId: req.session.user.id,
      status: 'planned',
    });
    res.json({ post: withRoadmapHtml(post) });
  })
);

router.post(
  '/roadmap/admin/:id/approve',
  requireOwner,
  asyncHandler(async (req, res) => {
    res.json({ post: await setRoadmapPostStatus(Number(req.params.id), 'planned') });
  })
);

router.post(
  '/roadmap/admin/:id/reject',
  requireOwner,
  asyncHandler(async (req, res) => {
    await deleteRoadmapPost(Number(req.params.id));
    res.json({ ok: true });
  })
);

router.post(
  '/roadmap/admin/:id/status',
  requireOwner,
  asyncHandler(async (req, res) => {
    const status = String(req.body.status ?? '');
    if (!ROADMAP_STATUSES.includes(status) || status === 'pending') {
      return res.status(400).json({ error: 'Invalid status' });
    }
    res.json({ post: await setRoadmapPostStatus(Number(req.params.id), status) });
  })
);

router.post(
  '/roadmap/admin/:id/edit',
  requireOwner,
  asyncHandler(async (req, res) => {
    const title = cleanRoadmapTitle(req.body.title);
    const description = cleanRoadmapDescription(req.body.description);
    if (!title || !description) {
      return res.status(400).json({ error: 'Title (3-100 chars) and description are required.' });
    }
    const post = await updateRoadmapPost(Number(req.params.id), { title, description });
    res.json({ post: withRoadmapHtml(post) });
  })
);

router.post(
  '/roadmap/admin/:id/delete',
  requireOwner,
  asyncHandler(async (req, res) => {
    await deleteRoadmapPost(Number(req.params.id));
    res.json({ ok: true });
  })
);

export default router;
