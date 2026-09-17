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
