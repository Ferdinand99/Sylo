// "Undo this change" for the change history (the audit log's diff view): which saved changes can be
// undone, what the undo would save, and how it is saved.
//
// An undo is not a second way to write settings. It builds the config a save of the earlier values would
// have produced and sends it through the same steps as the module's own save route: the module's
// normaliser (the same function the route calls, so every limit and clamp applies), setGuildModule (which
// runs the role-grant check for the person who asks, the way a form save does), and the module's after-save
// work (a sync with the platform, a message that is kept up to date). It then writes its own audit entry,
// which keeps its own before and after.
//
// What is undone is the module's settings. Things kept in tables of their own (reminders, shop items,
// custom commands, saved messages) are not part of a module's settings and are out of scope; a module whose
// save route does more than normalise and store (reaction roles, starboard rescans, event posts) is not in
// the list below, so its history shows the change and offers no undo.
import { log } from '../../lib/log.js';
import { getGuildModule, setGuildModule } from '../../db/modules.js';
import {
  getGuildSettings,
  getBotMasterRoles,
  setBotMasterRoles,
  setModlogChannel,
  setEmbedColor,
  setCommandPrefix,
  withoutEveryone,
} from '../../db/guildSettings.js';
import { clearScope } from '../../db/postedKeys.js';
import { platformOfGuild } from '../../platform/platformOf.js';
import { commandPrefixError } from '../../lib/commandPrefix.js';
import { getModule } from '../../modules/registry.js';
import { normaliseAfkConfig } from '../../modules/afk.js';
import { normaliseAppealsConfig } from '../../modules/appeals.js';
import { normaliseAutoReact } from '../../modules/autoReact.js';
import { normaliseAutoThreadsConfig } from '../../modules/autoThreads.js';
import { normaliseAutomodConfig } from '../../modules/automod.js';
import { normaliseAutoresponder } from '../../modules/autoresponder.js';
import { normaliseBirthdaysConfig } from '../../modules/birthdays.js';
import { normaliseCountingConfig } from '../../modules/counting.js';
import { normaliseGiveawaysConfig } from '../../modules/giveaways.js';
import { normaliseHoneypotConfig, ensureHoneypotMessages } from '../../modules/honeypot.js';
import { normaliseInviteTrackerConfig, primeGuild as primeInviteCache } from '../../modules/inviteTracker.js';
import { normaliseIntroductionsConfig } from '../../modules/introductions.js';
import { normaliseKickConfig } from '../../modules/kickAlerts.js';
import { normaliseLevelingConfig } from '../../modules/leveling.js';
import { LOG_EVENTS } from '../../modules/logging.js';
import { normaliseModerationConfig } from '../../modules/moderation.js';
import { normalisePollsConfig } from '../../modules/polls.js';
import { normaliseQuoteBoardConfig } from '../../modules/quoteBoard.js';
import { normaliseRssConfig } from '../../modules/rss.js';
import { normaliseServerStats } from '../../modules/serverStats.js';
import { normaliseStickyConfig } from '../../modules/sticky.js';
import { normaliseSuggestionsConfig } from '../../modules/suggestions.js';
import { normaliseTempRolesConfig } from '../../modules/tempRoles.js';
import { normaliseTicketsConfig } from '../../modules/tickets.js';
import { normaliseTwitchConfig } from '../../modules/twitchAlerts.js';
import { normaliseVerificationConfig, ensureVerifyMessage } from '../../modules/verification.js';
import { normaliseWelcomeChannelConfig } from '../../modules/welcomeChannel.js';
import { normaliseWelcomeConfig } from '../../modules/welcome.js';
import { normaliseEconomyConfig } from '../../modules/economy.js';
import { syncGuildAutomod } from '../../bot/lib/automodSync.js';
import { guildTextChannels } from './discord.js';
import { canPostInChannel } from './modlogChannel.js';
import { shouldSaveBotMasters } from './botMasters.js';

const isId = (v) => /^\d{17,20}$/.test(v ?? '');
const keepId = (list, prev, key) => new Map((prev[list] ?? []).map((item) => [item[key], item]));

/**
 * The modules that can be undone: for each, the normalise step of its save route (`cfg` is the config to
 * restore, `prev` what is saved now, `guild` the server) and, if the route does something once saved,
 * `after`. Written to mirror the routes in src/web/routes/*.js; test/configUndo.test.js saves every one of
 * them back unchanged.
 * @type {Record<string, { normalise: (cfg: any, ctx: { guild: any, prev: any }) => any,
 *   after?: (ctx: { guild: any, prev: any }, config: any) => unknown }>}
 */
export const UNDOABLE = {
  afk: { normalise: (cfg) => normaliseAfkConfig(cfg) },
  appeals: {
    normalise: (cfg) =>
      normaliseAppealsConfig({
        questions: cfg.questions,
        autoUnbanOnAccept: cfg.autoUnbanOnAccept,
        reviewChannelId: cfg.reviewChannelId,
        cooldownDays: cfg.cooldownDays,
        appealMessage: cfg.appealMessage,
        appealServerInvite: cfg.appealServerInvite,
      }),
  },
  automod: {
    normalise: (cfg) =>
      normaliseAutomodConfig({
        deleteMessage: true,
        timeoutMinutes: cfg.timeoutMinutes,
        exemptChannels: cfg.exemptChannels,
        exemptRoles: cfg.exemptRoles,
        native: cfg.native,
        rules: cfg.rules,
      }),
    after: ({ guild }, config) => syncGuildAutomod(guild, config),
  },
  'auto-react': {
    normalise: (cfg) =>
      normaliseAutoReact({
        cooldownSeconds: cfg.cooldownSeconds,
        logChannelId: cfg.logChannelId,
        rules: cfg.rules,
      }),
  },
  'auto-threads': {
    normalise: (cfg, { guild }) => {
      const allowed = new Set(guildTextChannels(guild).map((c) => c.id));
      const out = normaliseAutoThreadsConfig({ rules: cfg.rules });
      out.rules = out.rules.filter((r) => allowed.has(r.channelId));
      return out;
    },
  },
  autoresponder: {
    normalise: (cfg) =>
      normaliseAutoresponder({
        cooldownSeconds: cfg.cooldownSeconds,
        ignoreChannels: cfg.ignoreChannels,
        ignoreRoles: cfg.ignoreRoles,
        responders: cfg.responders,
      }),
  },
  birthdays: { normalise: (cfg) => normaliseBirthdaysConfig(cfg) },
  counting: { normalise: (cfg) => normaliseCountingConfig(cfg) },
  economy: { normalise: (cfg) => normaliseEconomyConfig(cfg) },
  'free-games': {
    normalise: (cfg) => ({
      channelId: isId(cfg.channelId) ? cfg.channelId : '',
      roleId: isId(cfg.roleId) ? cfg.roleId : '',
    }),
  },
  giveaways: {
    normalise: (cfg) => normaliseGiveawaysConfig({ ping: cfg.ping, dmWinners: cfg.dmWinners }),
  },
  honeypot: {
    // The message ids and catch counters are the bot's, not the form's: they stay as they are saved now.
    normalise: (cfg, { prev }) => {
      const messages = keepId('messages', prev, 'channelId');
      const channels = keepId('channels', prev, 'channelId');
      return normaliseHoneypotConfig({
        exemptRoles: cfg.exemptRoles,
        channels: (Array.isArray(cfg.channels) ? cfg.channels : []).map((c) => ({
          ...c,
          triggerCount: channels.get(c?.channelId)?.triggerCount ?? 0,
        })),
        messages: (Array.isArray(cfg.messages) ? cfg.messages : []).map((m) => ({
          ...m,
          messageId: messages.get(m?.channelId)?.messageId ?? '',
          triggerCount: messages.get(m?.channelId)?.triggerCount ?? 0,
        })),
      });
    },
    after: ({ guild }, config) => ensureHoneypotMessages(guild, config),
  },
  introductions: {
    // Which message the prompt is published as is the server's to track, not the form's.
    normalise: (cfg, { prev }) =>
      normaliseIntroductionsConfig({
        ...cfg,
        promptChannelId: normaliseIntroductionsConfig(prev).promptChannelId,
        promptMessageId: normaliseIntroductionsConfig(prev).promptMessageId,
      }),
  },
  'invite-tracker': {
    normalise: (cfg) =>
      normaliseInviteTrackerConfig({ joinLogChannelId: cfg.joinLogChannelId, graceHours: cfg.graceHours }),
    after: ({ guild }) => primeInviteCache(guild),
  },
  'kick-alerts': { normalise: (cfg) => normaliseKickConfig({ alerts: cfg.alerts }) },
  leveling: {
    // The public-leaderboard switch lives on the Leaderboard page: it keeps its saved value.
    normalise: (cfg, { prev }) =>
      normaliseLevelingConfig({ ...cfg, publicLeaderboard: prev.publicLeaderboard !== false }),
  },
  logging: {
    normalise: (cfg) => ({
      channel: isId(cfg.channel) ? cfg.channel : '',
      events: Object.fromEntries(LOG_EVENTS.map(([key]) => [key, Boolean(cfg.events?.[key])])),
    }),
  },
  moderation: { normalise: (cfg) => normaliseModerationConfig(cfg) },
  polls: {
    normalise: (cfg) =>
      normalisePollsConfig({
        voteRoleMode: cfg.voteRoleMode,
        voteRoles: Array.isArray(cfg.voteRoles) ? cfg.voteRoles : [],
        pollMessage: cfg.pollMessage,
        resultsMessage: cfg.resultsMessage,
      }),
  },
  'quote-board': { normalise: (cfg) => normaliseQuoteBoardConfig(cfg) },
  rss: {
    normalise: (cfg) => normaliseRssConfig({ feeds: cfg.feeds }),
    // A feed that is no longer there forgets which items it posted, as when its row is removed in the form.
    after: async ({ guild, prev }, config) => {
      const kept = new Set(config.feeds.map((f) => f.id));
      for (const feed of Array.isArray(prev.feeds) ? prev.feeds : []) {
        if (!kept.has(feed.id)) await clearScope(guild.id, `rss:${feed.id}`);
      }
    },
  },
  'server-stats': {
    normalise: (cfg) => normaliseServerStats({ refreshMinutes: cfg.refreshMinutes, channels: cfg.channels }),
  },
  sticky: { normalise: (cfg, { prev }) => normaliseStickyConfig({ stickies: cfg.stickies }, prev) },
  suggestions: {
    normalise: (cfg, { prev }) =>
      normaliseSuggestionsConfig({ ...cfg, logMode: cfg.logMode ?? prev?.logMode }),
  },
  'temp-roles': { normalise: (cfg) => normaliseTempRolesConfig(cfg) },
  tickets: {
    normalise: (cfg, { guild }) => {
      const out = normaliseTicketsConfig(cfg);
      out.staffRoles = withoutEveryone(guild.id, out.staffRoles);
      return out;
    },
  },
  'twitch-alerts': { normalise: (cfg) => normaliseTwitchConfig({ alerts: cfg.alerts }) },
  verification: {
    normalise: (cfg, { prev }) =>
      normaliseVerificationConfig({
        mode: cfg.mode,
        verifiedRoleId: cfg.verifiedRoleId,
        channelId: cfg.channelId,
        messageId: prev.messageId, // bot-managed, not form-editable
        title: cfg.title,
        message: cfg.message,
        successMessage: cfg.successMessage,
        logChannelId: cfg.logChannelId,
        kickAfterMinutes: cfg.kickAfterMinutes,
      }),
    after: ({ guild }, config) => ensureVerifyMessage(guild, config),
  },
  welcome: {
    // Only Welcome's own settings: the auto-roles a Welcome save also sets live in the Roles module.
    normalise: (cfg, { guild, prev }) => normaliseWelcomeConfig({ ...cfg }, guild, { prev }),
  },
  'welcome-channel': {
    normalise: (cfg, { prev }) =>
      normaliseWelcomeChannelConfig({ channelId: cfg.channelId, messageId: prev.messageId, spec: cfg.spec }),
  },
};

/** What an audit action key is about: a module, the server settings, or nothing that can be restored. */
export function targetOf(action) {
  const key = String(action ?? '');
  if (key === 'settings:server') return { kind: 'settings' };
  if (key.startsWith('module:')) {
    const id = key.slice('module:'.length);
    if (id && id !== 'bulk') return { kind: 'module', id };
  }
  return null;
}

/** Whether the person asking may see and undo changes to this module (an operator-only one: operators). */
export const mayTouchModule = (id, isOperator) => !getModule(id)?.ownerOnly || isOperator;

/** The server settings the history keeps, in the form it keeps them. */
export async function readSettingsSnapshot(guild) {
  const row = await getGuildSettings(guild.id);
  const color = row?.embed_color;
  return {
    modlogChannelId: row?.modlog_channel_id ?? '',
    embedColor: Number.isInteger(color) ? `#${color.toString(16).padStart(6, '0')}` : '',
    botMasterRoleIds: await getBotMasterRoles(guild.id),
    commandPrefix: row?.command_prefix ?? '',
  };
}

/** The saved settings an entry is about, in the form the history keeps them. */
export async function currentSettingsFor(guild, target) {
  if (target.kind === 'settings') return readSettingsSnapshot(guild);
  return (await getGuildModule(guild.id, target.id)).config ?? {};
}

/** Why an undo is not offered for this kind of entry, or null when it is. */
export function undoRefusal(target) {
  if (!target) return 'This kind of entry has no saved settings to restore.';
  if (target.kind === 'settings') return null;
  if (!UNDOABLE[target.id]) {
    return 'Changes to this module cannot be undone from here yet. The difference is shown so you can set it back by hand.';
  }
  return null;
}

/**
 * Save the earlier settings of a module through the module's own normaliser and the guarded write.
 * @returns {Promise<{ config: object }>} what was saved
 */
export async function restoreModule(guild, moduleId, target) {
  const entry = UNDOABLE[moduleId];
  const prev = (await getGuildModule(guild.id, moduleId)).config ?? {};
  const config = await entry.normalise(target, { guild, prev });
  await setGuildModule(guild.id, moduleId, { config });
  if (entry.after) {
    Promise.resolve(entry.after({ guild, prev }, config)).catch((err) =>
      log.warn('history', `the work after an undo of ${moduleId} failed: ${err.message}`)
    );
  }
  return { config };
}

/** An error to answer with a status and a message (the route sends it as JSON). */
export class UndoError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UndoError';
    this.status = status;
  }
}

/**
 * Save the earlier server settings an entry kept. Each setting goes through the check its form save has:
 * the mod-log channel must be one Sylo can post in, the command prefix must be valid (and is a Fluxer
 * setting), and only someone who may change the bot master roles can restore those.
 * @param {import('express').Request} req
 * @param {any} guild
 * @param {Record<string, any>} wanted  the settings to put back (only the keys the change touched)
 */
export async function restoreSettings(req, guild, wanted) {
  const current = await readSettingsSnapshot(guild);
  if ('botMasterRoleIds' in wanted) {
    const shouldSave = await shouldSaveBotMasters(
      req,
      guild,
      wanted.botMasterRoleIds,
      current.botMasterRoleIds
    );
    if (shouldSave) await setBotMasterRoles(guild.id, wanted.botMasterRoleIds);
  }
  if ('modlogChannelId' in wanted) {
    const id = String(wanted.modlogChannelId ?? '');
    if (id === '') await setModlogChannel(guild.id, null);
    else if (id !== current.modlogChannelId) {
      if (!guildTextChannels(guild).some((c) => c.id === id)) {
        throw new UndoError('The mod-log channel it had no longer exists, so it was not restored.');
      }
      if (!canPostInChannel(guild, id)) {
        throw new UndoError(
          'Sylo needs View Channel, Send Messages and Embed Links in the mod-log channel it had.'
        );
      }
      await setModlogChannel(guild.id, id);
    }
  }
  if ('embedColor' in wanted) {
    const hex = String(wanted.embedColor ?? '').replace('#', '');
    if (hex === '') await setEmbedColor(guild.id, null);
    else if (/^[0-9a-fA-F]{6}$/.test(hex)) await setEmbedColor(guild.id, parseInt(hex, 16));
    else throw new UndoError('The embed colour it had is not a valid colour.');
  }
  if ('commandPrefix' in wanted && platformOfGuild(guild) !== 'discord') {
    const prefix = String(wanted.commandPrefix ?? '');
    if (prefix !== '') {
      const why = commandPrefixError(prefix);
      if (why) throw new UndoError(why);
    }
    if (prefix !== current.commandPrefix) await setCommandPrefix(guild.id, prefix || null);
  }
  return readSettingsSnapshot(guild);
}

/** Channel and role names for the ids in a stored change, so the diff can say #general instead of an id. */
export function namesFor(guild, ...values) {
  const names = {};
  const seen = new Set();
  const visit = (v, depth) => {
    if (seen.size >= 300 || depth > 8) return;
    if (typeof v === 'string') {
      if (isId(v) && !seen.has(v)) {
        seen.add(v);
        const channel = guild.channels?.cache?.get?.(v);
        const role = guild.roles?.cache?.get?.(v);
        if (channel?.name) names[v] = `#${channel.name}`;
        else if (role?.name) names[v] = `@${role.name}`;
      }
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v)) visit(x, depth + 1);
    }
  };
  for (const v of values) visit(v, 0);
  return names;
}
