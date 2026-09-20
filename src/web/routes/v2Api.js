// JSON API for the V2 dashboard SPA (web-v2/). Mounted at /api/v2, entirely
// after the app-wide requireAuth (src/web/server.js), so every route here
// already has a signed-in req.session.user — same cookie-session V1 uses,
// nothing new. Read-only reuse of V1's data-layer functions (baseContext,
// getGuild, requireGuildAdmin) — none of them are modified by this file.
import { createRequire } from 'node:module';
import { Router, raw } from 'express';
import { requireGuildAdmin, requireOwner, manageableGuilds, currentUser } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getGuild, baseContext, assignableRoles } from '../lib/guildContext.js';
import { guildTextChannels, resolveUserTags } from '../lib/discord.js';
import { buildOverview } from '../lib/overviewSummary.js';
import { getDashboardVersion, setDashboardVersion, DASHBOARD_VERSIONS } from '../../db/userPrefs.js';
import { getGuildModule, setGuildModule } from '../../db/modules.js';
import { normaliseLevelingConfig } from '../../modules/leveling.js';
import { normaliseAutomodConfig } from '../../modules/automod.js';
import { primeGuild as primeInviteCache } from '../../modules/inviteTracker.js';
import { syncGuildAutomod } from '../../bot/lib/automodSync.js';
import { syncGuildCustomCommands } from '../../bot/lib/customCommandSync.js';
import { WELCOME_PLACEHOLDERS } from '../../modules/welcome.js';
import { normaliseBirthdaysConfig } from '../../modules/birthdays.js';
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

export default router;
