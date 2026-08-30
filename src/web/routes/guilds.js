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
import { getGuildSettings, setModlogChannel } from '../../db/guildSettings.js';
import { listGuildWarnings, addWarning } from '../../db/warnings.js';
import { notifyTarget, MOD_COLOR } from '../../bot/lib/moderation.js';
import { postModLog } from '../../bot/lib/modlog.js';
import { timeAgo } from '../lib/format.js';
import { LOG_EVENTS } from '../../modules/logging.js';
import { WELCOME_PLACEHOLDERS } from '../../modules/welcome.js';
import { applyWarnThresholds, normaliseThresholds, THRESHOLD_ACTIONS } from '../../modules/moderation.js';
import { normaliseAutomodConfig, AUTOMOD_RULES, AUTOMOD_ACTIONS } from '../../modules/automod.js';
import { parseEmoji, createReactionMessage } from '../../modules/roles.js';
import { getCounting, setCount, resetCount } from '../../db/counting.js';
import { normaliseCustomCommands, CC_PLACEHOLDERS } from '../../modules/customCommands.js';
import { normaliseAutoresponder, AR_MATCH_MODES, AR_PLACEHOLDERS } from '../../modules/autoresponder.js';
import { normaliseVerificationConfig, VERIFY_MODES, ensureVerifyMessage } from '../../modules/verification.js';
import { normaliseServerStats, STAT_TYPES } from '../../modules/serverStats.js';
import { normaliseAppealsConfig, decideAndNotify } from '../../modules/appeals.js';
import { normaliseTempVoiceConfig } from '../../modules/tempVoice.js';
import { listAppeals, getAppeal } from '../../db/appeals.js';
import { config as appConfig } from '../../config.js';
import {
  listScheduled,
  createScheduled,
  deleteScheduled,
  setScheduledEnabled,
  getScheduled,
} from '../../db/scheduledMessages.js';
import {
  SCHEDULE_PRESETS,
  SCHEDULE_UNITS,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
} from '../../modules/scheduledMessages.js';
import { syncGuildCustomCommands } from '../../bot/lib/customCommandSync.js';
import { normaliseLevelingConfig, ANNOUNCE_MODES } from '../../modules/leveling.js';
import { topMembers, memberCount, setXp, resetGuildLeveling } from '../../db/leveling.js';
import { recordAudit, listAudit } from '../../db/audit.js';
import { exportGuildConfig } from '../../db/exportConfig.js';
import { buildOverview } from '../lib/overviewSummary.js';

const router = Router();

// Module ids that have a real settings partial (views/guild/modules/<id>.ejs).
const CONFIG_VIEWS = new Set([
  'moderation', 'logging', 'welcome', 'roles', 'sticky', 'tickets', 'automod', 'counting',
  'custom-commands', 'scheduled-messages', 'leveling', 'autoresponder', 'verification',
  'afk', 'server-stats', 'free-games', 'appeals', 'temp-voice',
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

router.get('/:guildId/general', (req, res) => {
  const settings = getGuildSettings(req.guild.id);
  res.render('guild', {
    ...baseContext(req.guild, 'general'),
    modlogChannelId: settings?.modlog_channel_id ?? '',
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
    roles: ['roles', 'tickets', 'automod', 'leveling', 'autoresponder', 'verification', 'free-games'].includes(mod.id)
      ? assignableRoles(req.guild)
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
    scheduledJobs: mod.id === 'scheduled-messages'
      ? listScheduled(req.guild.id).map((j) => ({
          id: j.id,
          channel: guildTextChannels(req.guild).find((c) => c.id === j.channel_id)?.name ?? j.channel_id,
          content: j.content,
          intervalMinutes: j.interval_minutes,
          enabled: j.enabled === 1,
          nextRun: j.enabled === 1 ? new Date(j.next_run_at).toISOString() : null,
          lastRun: j.last_run_at ? timeAgo(j.last_run_at) : null,
        }))
      : [],
    schedulePresets: SCHEDULE_PRESETS,
    scheduleUnits: SCHEDULE_UNITS,
    announceModes: ANNOUNCE_MODES,
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
    msg: typeof req.query.msg === 'string' ? req.query.msg : null,
  });
});

// Save a module's settings.
router.post('/:guildId/m/:moduleId/config', (req, res) => {
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
    config = {
      joinChannel: chan(req.body.joinChannel),
      joinMessage: String(req.body.joinMessage ?? '').slice(0, 1500),
      leaveChannel: chan(req.body.leaveChannel),
      leaveMessage: String(req.body.leaveMessage ?? '').slice(0, 1500),
      dmMessage: String(req.body.dmMessage ?? '').slice(0, 1500),
      useEmbed: req.body.useEmbed === 'on',
    };
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
    const rule = (key) => ({
      enabled: b[`r_${key}_enabled`] === 'on',
      action: b[`r_${key}_action`],
    });
    config = normaliseAutomodConfig({
      deleteMessage: b.deleteMessage === 'on',
      timeoutMinutes: b.timeoutMinutes,
      exemptChannels: [].concat(b.exemptChannels ?? []),
      exemptRoles: [].concat(b.exemptRoles ?? []),
      rules: {
        invites: rule('invites'),
        links: { ...rule('links'), allowed: b.r_links_allowed },
        spam: { ...rule('spam'), max: b.r_spam_max, seconds: b.r_spam_seconds },
        mentions: { ...rule('mentions'), max: b.r_mentions_max },
        caps: { ...rule('caps'), minLength: b.r_caps_minLength, percent: b.r_caps_percent },
        words: { ...rule('words'), list: b.r_words_list },
      },
    });
  } else if (mod.id === 'counting') {
    config = {
      channelId: /^\d{17,20}$/.test(req.body.channelId ?? '') ? req.body.channelId : '',
      allowSameUser: req.body.allowSameUser === 'on',
      resetOnFail: req.body.resetOnFail === 'on',
      react: req.body.react === 'on',
    };
  } else if (mod.id === 'custom-commands') {
    // Repeating rows: cc_name[], cc_response[], cc_type[], cc_embedTitle[], cc_embedColor[].
    const names = [].concat(req.body.cc_name ?? []);
    const responses = [].concat(req.body.cc_response ?? []);
    const types = [].concat(req.body.cc_type ?? []);
    const titles = [].concat(req.body.cc_embedTitle ?? []);
    const colors = [].concat(req.body.cc_embedColor ?? []);
    config = normaliseCustomCommands({
      prefix: req.body.prefix,
      slash: req.body.slash === 'on',
      commands: names.map((name, i) => ({
        name,
        response: responses[i] ?? '',
        embed: types[i] === 'embed',
        embedTitle: titles[i] ?? '',
        embedColor: colors[i] ?? '',
      })),
    });
  } else if (mod.id === 'leveling') {
    const levels = [].concat(req.body.rw_level ?? []);
    const roleIds = [].concat(req.body.rw_role ?? []);
    config = normaliseLevelingConfig({
      cooldownSeconds: req.body.cooldownSeconds,
      announce: req.body.announce,
      announceChannel: req.body.announceChannel,
      announceMessage: req.body.announceMessage,
      noXpChannels: [].concat(req.body.noXpChannels ?? []),
      noXpRoles: [].concat(req.body.noXpRoles ?? []),
      stackRewards: req.body.stackRewards === 'on',
      publicLeaderboard: req.body.publicLeaderboard === 'on',
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
  } else {
    return res.redirect(back);
  }

  setGuildModule(req.guild.id, mod.id, { config });
  recordAudit(req.guild.id, { actor: moderatorDisplayName(req), action: `module:${mod.id}`, detail: 'settings saved' });
  if (mod.id === 'custom-commands') {
    syncGuildCustomCommands(req.guild).catch((err) =>
      console.error('[custom-commands] sync after save failed:', err.message)
    );
  }
  if (mod.id === 'verification') {
    ensureVerifyMessage(req.guild, config).catch((err) =>
      console.error('[verification] ensure message after save failed:', err.message)
    );
  }
  res.redirect(`${back}?msg=saved`);
});

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
router.post('/:guildId/m/leveling/xp', (req, res) => {
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
  res.redirect(`${back}?msg=lvl-set`);
});

// --- Scheduled messages: one job per row, managed here (not in module config) ---
router.post('/:guildId/m/scheduled-messages/job', (req, res) => {
  const back = `/guilds/${req.guild.id}/m/scheduled-messages`;
  const channelId = String(req.body.channelId ?? '');
  const content = String(req.body.content ?? '').trim();
  const customVal = String(req.body.customValue ?? '').trim();
  const unitMult = Number(req.body.customUnit) || 1;
  const minutes = Math.floor(
    customVal !== '' ? Number(customVal) * unitMult : Number(req.body.intervalMinutes)
  );

  if (!guildTextChannels(req.guild).some((c) => c.id === channelId)) {
    return res.redirect(`${back}?msg=badchannel`);
  }
  if (content === '' || !Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
    return res.redirect(`${back}?msg=sched-bad`);
  }
  createScheduled(req.guild.id, { channelId, content: content.slice(0, 2000), intervalMinutes: minutes });
  res.redirect(`${back}?msg=saved`);
});

router.post('/:guildId/m/scheduled-messages/job/:id/delete', (req, res) => {
  deleteScheduled(req.guild.id, Number(req.params.id));
  res.redirect(`/guilds/${req.guild.id}/m/scheduled-messages?msg=saved`);
});

router.post('/:guildId/m/scheduled-messages/job/:id/toggle', (req, res) => {
  const job = getScheduled(req.guild.id, Number(req.params.id));
  if (job) setScheduledEnabled(req.guild.id, job.id, job.enabled !== 1);
  res.redirect(`/guilds/${req.guild.id}/m/scheduled-messages?msg=saved`);
});

// Create a reaction-role message: the bot posts it and adds the reactions.
router.post(
  '/:guildId/m/roles/reaction-message',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const back = `/guilds/${guild.id}/m/roles`;
    const channelId = String(req.body.channelId ?? '');
    if (!/^\d{17,20}$/.test(channelId)) return res.redirect(`${back}?msg=badchannel`);

    const emojis = [].concat(req.body.re_emoji ?? []);
    const roleIds = [].concat(req.body.re_role ?? []);
    const pairs = [];
    for (let i = 0; i < emojis.length; i += 1) {
      const parsed = parseEmoji(emojis[i], guild);
      if (parsed && /^\d{17,20}$/.test(roleIds[i] ?? '')) {
        pairs.push({ ...parsed, roleId: roleIds[i] });
      }
    }
    if (pairs.length === 0) return res.redirect(`${back}?msg=needpair`);

    const colorHex = String(req.body.color ?? '').replace('#', '');
    try {
      const record = await createReactionMessage(guild, {
        channelId,
        title: String(req.body.title ?? '').slice(0, 240),
        description: String(req.body.description ?? '').slice(0, 1500),
        color: /^[0-9a-fA-F]{6}$/.test(colorHex) ? parseInt(colorHex, 16) : undefined,
        pairs,
      });
      const cfg = getGuildModule(guild.id, 'roles').config;
      cfg.reactionMessages = [...(cfg.reactionMessages ?? []), record];
      // Turn the module on — a reaction message is useless while it's disabled.
      setGuildModule(guild.id, 'roles', { enabled: true, config: cfg });
      res.redirect(`${back}?msg=saved`);
    } catch (err) {
      console.error('[roles] create reaction message failed:', err.message);
      res.redirect(`${back}?msg=rrfail`);
    }
  })
);

// Remove a reaction-role message from config (leaves the Discord message).
router.post('/:guildId/m/roles/reaction-message/:index/delete', (req, res) => {
  const guild = req.guild;
  const back = `/guilds/${guild.id}/m/roles`;
  const cfg = getGuildModule(guild.id, 'roles').config;
  const list = cfg.reactionMessages ?? [];
  const idx = Number(req.params.index);
  if (Number.isInteger(idx) && idx >= 0 && idx < list.length) {
    list.splice(idx, 1);
    setGuildModule(guild.id, 'roles', { config: { ...cfg, reactionMessages: list } });
  }
  res.redirect(`${back}?msg=saved`);
});

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
  res.json({ enabled });
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
