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
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
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
import {
  changeKeys,
  laterChanges,
  maskSecrets,
  undoState,
  undoTarget,
  without,
} from '../../lib/configSnapshot.js';

const isId = (v) => /^\d{17,20}$/.test(v ?? '');
const keepId = (list, prev, key) => new Map((prev[list] ?? []).map((item) => [item[key], item]));

/**
 * The modules that can be undone: for each, the normalise step of its save route (`cfg` is the config to
 * restore, `prev` what is saved now, `guild` the server) and, if the route does something once saved,
 * `after`. Written to mirror the routes in src/web/routes/*.js; test/configUndo.test.js saves every one of
 * them back unchanged.
 * `keep` names the settings an undo leaves as they are saved now, with the reason the page gives: a setting the
 * bot manages (the id of a message it posted) or one that is saved together with another module's settings.
 * @type {Record<string, { normalise: (cfg: any, ctx: { guild: any, prev: any }) => any,
 *   after?: (ctx: { guild: any, prev: any }, config: any) => unknown,
 *   keep?: Record<string, string> }>}
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
    keep: {
      promptChannelId: 'It is the message Sylo posted, which Sylo keeps track of.',
      promptMessageId: 'It is the message Sylo posted, which Sylo keeps track of.',
    },
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
    keep: { messageId: 'It is the message Sylo posted, which Sylo keeps track of.' },
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
    // Only Welcome's own settings: the auto-roles a Welcome save also sets live in the Roles module, so the
    // switch that goes with them stays as it is (restoring it alone would leave the form showing "off" while
    // the bot still hands the role out, or the other way round).
    keep: {
      autoroleEnabled: 'It goes together with the auto-roles of the Roles page, which are not restored here.',
    },
    normalise: (cfg, { guild, prev }) => normaliseWelcomeConfig({ ...cfg }, guild, { prev }),
  },
  'welcome-channel': {
    keep: { messageId: 'It is the message Sylo posted, which Sylo keeps track of.' },
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

const SETTINGS_KEYS = ['modlogChannelId', 'embedColor', 'botMasterRoleIds', 'commandPrefix'];

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

/** An error to answer with a status and a message (the route sends it as JSON, with `extra` beside the message). */
export class UndoError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'UndoError';
    this.status = status;
    this.extra = extra;
  }
}

// One undo at a time for a server's module (or its settings): two at once would both read the same "now" and
// both run the module's after-save work (a second verification message, say).
const turns = new Map();
function inTurn(key, fn) {
  const run = (turns.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.then(
    () => {},
    () => {}
  );
  turns.set(key, tail);
  tail.then(() => {
    if (turns.get(key) === tail) turns.delete(key);
  });
  return run;
}

/**
 * Names the saved values the change touches (masked, as the history keeps them): a short digest that
 * changes when any of them does. The undo of settings that were changed again needs the digest the person
 * confirmed, so a confirmation is for what the page showed, not for whatever is saved by the time it arrives.
 */
export function stateToken(current, change) {
  const now = {};
  for (const key of changeKeys(change)) if (key in current) now[key] = maskSecrets(current[key], key);
  return createHash('sha256').update(JSON.stringify(now)).digest('hex').slice(0, 24);
}

const NOTHING = 'Nothing in this change can be restored: what is left of it is kept by Sylo itself.';

// Reads what an undo of `change` would do now. Nothing is written.
async function assess(guild, target, change) {
  const refusal = undoRefusal(target);
  if (!target) {
    return {
      available: false,
      reason: refusal,
      state: 'changed',
      current: {},
      notRestored: [],
      droppedSecrets: [],
      laterChanges: [],
      token: null,
    };
  }
  const current = await currentSettingsFor(guild, target);
  const keep = target?.kind === 'module' ? (UNDOABLE[target.id]?.keep ?? {}) : {};
  const notRestored = changeKeys(change)
    .filter((k) => k in keep)
    .map((key) => ({ key, reason: keep[key] }));
  const base = { current, notRestored, droppedSecrets: [], laterChanges: [], token: null };
  if (refusal) return { ...base, available: false, reason: refusal, state: undoState(current, change) };
  const effective = without(change, Object.keys(keep));
  if (!changeKeys(effective).length) return { ...base, available: false, reason: NOTHING, state: 'clean' };
  const state = undoState(current, effective);
  if (state === 'reverted') {
    return { ...base, available: false, reason: 'The settings already have the earlier values.', state };
  }
  const out = {
    ...base,
    effective,
    available: true,
    reason: null,
    state,
    laterChanges: state === 'changed' ? laterChanges(current, effective) : [],
    token: state === 'changed' ? stateToken(current, effective) : null,
  };
  if (target.kind === 'module') {
    const dropped = [];
    out.wanted = undoTarget(current, effective, { keep: Object.keys(keep), droppedSecrets: dropped });
    out.droppedSecrets = dropped;
    try {
      out.config = await UNDOABLE[target.id].normalise(out.wanted, { guild, prev: current });
    } catch {
      out.config = null; // refused by a limit: the undo itself answers with the reason
    }
    if (out.config && isDeepStrictEqual(out.config, current)) {
      return { ...out, available: false, reason: NOTHING };
    }
  } else {
    const restored = undoTarget(current, effective);
    out.wanted = {};
    for (const key of changeKeys(effective)) {
      if (SETTINGS_KEYS.includes(key) && key in effective.before) out.wanted[key] = restored[key];
    }
  }
  return out;
}

/** What the history page shows about an entry: whether it can be undone, why not, and what the undo leaves alone. */
export async function describeUndo(guild, target, change) {
  const a = await assess(guild, target, change);
  return {
    available: a.available,
    reason: a.reason,
    state: a.state,
    laterChanges: a.laterChanges,
    token: a.token,
    notRestored: a.notRestored,
    droppedSecrets: a.droppedSecrets,
  };
}

const MOVED = 'These settings were changed again after this entry. Undoing it will lose those later changes.';

// Settings changed since the page looked (or since the entry): ask for the confirmation of what is saved now.
function mustConfirm(a, { confirm, token }) {
  if (a.state !== 'changed') return;
  if (confirm === true && token && token === a.token) return;
  throw new UndoError(MOVED, 409, { code: 'changed-since', laterChanges: a.laterChanges, token: a.token });
}

function refuse(a) {
  throw new UndoError(a.reason, a.state === 'reverted' ? 409 : 400);
}

/**
 * Undo a change to a module's settings: the earlier values go through the module's own normaliser and the
 * guarded write, then the module's after-save work. One at a time per server and module. If what is saved
 * changed between the decision and the write, nothing is written and the person is asked again.
 * @returns {Promise<{ adjusted: string[], notRestored: object[] }>}
 */
export function undoModule(guild, moduleId, change, opts = {}) {
  const target = { kind: 'module', id: moduleId };
  return inTurn(`${guild.id}|${moduleId}`, async () => {
    const a = await assess(guild, target, change);
    if (!a.available) refuse(a);
    mustConfirm(a, opts);
    const entry = UNDOABLE[moduleId];
    // Not assessed before? (a limit refused it) run it again so the person gets the reason.
    const config = a.config ?? (await entry.normalise(a.wanted, { guild, prev: a.current }));
    const fresh = (await getGuildModule(guild.id, moduleId)).config ?? {};
    if (!isDeepStrictEqual(fresh, a.current)) {
      throw new UndoError(MOVED, 409, {
        code: 'changed-since',
        laterChanges: laterChanges(fresh, a.effective),
        token: stateToken(fresh, a.effective),
      });
    }
    await setGuildModule(guild.id, moduleId, { config });
    if (entry.after) {
      Promise.resolve(entry.after({ guild, prev: a.current }, config)).catch((err) =>
        log.warn('history', `the work after an undo of ${moduleId} failed: ${err.message}`)
      );
    }
    const differs = changeKeys(a.effective).filter(
      (k) => !isDeepStrictEqual(config[k], a.wanted[k]) || a.droppedSecrets.includes(k)
    );
    return { adjusted: [...new Set(differs)], notRestored: a.notRestored };
  });
}

// Checks every server setting an undo would put back, and says what to write. Writes nothing: a setting that
// cannot be restored refuses the whole undo before the first one is written, as the settings form does.
async function planSettings(req, guild, wanted, current) {
  const plan = {};
  if ('botMasterRoleIds' in wanted) {
    // Throws (403) when the person may not change the bot master roles and the list differs.
    if (await shouldSaveBotMasters(req, guild, wanted.botMasterRoleIds, current.botMasterRoleIds)) {
      plan.botMasterRoleIds = wanted.botMasterRoleIds;
    }
  }
  if ('modlogChannelId' in wanted) {
    const id = String(wanted.modlogChannelId ?? '');
    if (id === '') plan.modlogChannelId = null;
    else if (id !== current.modlogChannelId) {
      if (!guildTextChannels(guild).some((c) => c.id === id)) {
        throw new UndoError('The mod-log channel it had no longer exists, so nothing was restored.');
      }
      if (!canPostInChannel(guild, id)) {
        throw new UndoError(
          'Sylo needs View Channel, Send Messages and Embed Links in the mod-log channel it had, so nothing was restored.'
        );
      }
      plan.modlogChannelId = id;
    }
  }
  if ('embedColor' in wanted) {
    const hex = String(wanted.embedColor ?? '').replace('#', '');
    if (hex === '') plan.embedColor = null;
    else if (/^[0-9a-fA-F]{6}$/.test(hex)) plan.embedColor = parseInt(hex, 16);
    else throw new UndoError('The embed colour it had is not a valid colour, so nothing was restored.');
  }
  if ('commandPrefix' in wanted && platformOfGuild(guild) !== 'discord') {
    const prefix = String(wanted.commandPrefix ?? '');
    if (prefix !== '') {
      const why = commandPrefixError(prefix);
      if (why) throw new UndoError(`${why} Nothing was restored.`);
    }
    if (prefix !== current.commandPrefix) plan.commandPrefix = prefix || null;
  }
  return plan;
}

/**
 * Undo a change to the server settings. Each setting is checked the way the settings form checks it (the
 * mod-log channel must exist and be postable, the prefix valid and a Fluxer setting, the bot master roles only
 * for someone who may change them); only when all pass are they written. One at a time per server.
 * @returns {Promise<{ adjusted: string[], notRestored: object[] }>}
 */
export function undoSettings(req, guild, change, opts = {}) {
  const target = { kind: 'settings' };
  return inTurn(`${guild.id}|settings`, async () => {
    const a = await assess(guild, target, change);
    if (!a.available) refuse(a);
    mustConfirm(a, opts);
    const plan = await planSettings(req, guild, a.wanted, a.current);
    const fresh = await readSettingsSnapshot(guild);
    if (!isDeepStrictEqual(fresh, a.current)) {
      throw new UndoError(MOVED, 409, {
        code: 'changed-since',
        laterChanges: laterChanges(fresh, a.effective),
        token: stateToken(fresh, a.effective),
      });
    }
    if ('botMasterRoleIds' in plan) await setBotMasterRoles(guild.id, plan.botMasterRoleIds);
    if ('modlogChannelId' in plan) await setModlogChannel(guild.id, plan.modlogChannelId);
    if ('embedColor' in plan) await setEmbedColor(guild.id, plan.embedColor);
    if ('commandPrefix' in plan) await setCommandPrefix(guild.id, plan.commandPrefix);
    return { adjusted: [], notRestored: [] };
  });
}

/** Channel, role and member names for the ids in a stored change, so the diff can say #general instead of an id. */
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
        const member = guild.members?.cache?.get?.(v);
        if (channel?.name) names[v] = `#${channel.name}`;
        else if (role?.name) names[v] = `@${role.name}`;
        else if (member) names[v] = `@${member.displayName ?? member.user?.username ?? v}`;
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
