// Pushes the mappable Automod rules onto Discord's native AutoModeration, so they
// are enforced by Discord before a message is ever posted — and keep working
// while Sylo is offline. Only four Sylo checks have a native equivalent:
//
//   words     -> Keyword rule (each term as a *substring* wildcard)
//   mentions  -> MentionSpam rule (mention_total_limit)
//   spam      -> Spam rule (Discord's own classifier)
//   presets   -> KeywordPreset rule (profanity / sexual-content / slurs)
//
// The other checks (repeat, zalgo, caps, emojis, spoilers, invites, links) have
// no native form and stay in the in-process scanner.
//
// Sylo owns exactly the rules it names `Sylo: …`. It creates / edits / deletes
// those to match the config and never touches a rule it did not create. A hand
// edit to a `Sylo:`-named rule is overwritten on the next dashboard save — edit
// those from the dashboard, not in Discord.
import {
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  AutoModerationActionType,
  AutoModerationRuleKeywordPresetType,
  PermissionFlagsBits,
} from 'discord.js';
import { getGuildSettings } from '../../db/guildSettings.js';
import { log } from '../../lib/log.js';

export const SYLO_PREFIX = 'Sylo: ';

/** Sylo rule key -> the exact AutoMod rule name Sylo manages for it. */
export const RULE_NAMES = {
  words: `${SYLO_PREFIX}bad words`,
  mentions: `${SYLO_PREFIX}mention limit`,
  spam: `${SYLO_PREFIX}spam`,
  preset: `${SYLO_PREFIX}word presets`,
};

/** Native keyword-preset choices exposed in the dashboard. */
export const PRESET_KEYS = ['profanity', 'sexual', 'slurs'];
const PRESET_ENUM = {
  profanity: AutoModerationRuleKeywordPresetType.Profanity,
  sexual: AutoModerationRuleKeywordPresetType.SexualContent,
  slurs: AutoModerationRuleKeywordPresetType.Slurs,
};

// Discord limits.
const KEYWORD_FILTER_MAX = 1000; // entries per Keyword rule
const KEYWORD_ENTRY_MAX = 60; // characters per entry, wildcards included
const MENTION_LIMIT_MAX = 50;
const TIMEOUT_MAX_SECONDS = 2_419_200; // 28 days
const EXEMPT_ROLES_MAX = 20;
const EXEMPT_CHANNELS_MAX = 50;

const BLOCK_MESSAGE = 'Blocked by Sylo auto-moderation.';

/** Is this a rule Sylo manages? */
export function isSyloRule(rule) {
  return typeof rule?.name === 'string' && rule.name.startsWith(SYLO_PREFIX);
}

function clampTimeoutSeconds(minutes) {
  const secs = Math.round((Number(minutes) || 10) * 60);
  return Math.min(TIMEOUT_MAX_SECONDS, Math.max(60, secs));
}

/**
 * Build the action list for one native rule.
 * @param {object} cfg           normalised automod config
 * @param {string} syloRuleKey   which in-process rule's `action` to mirror
 * @param {{ allowTimeout: boolean }} opts  Spam triggers cannot carry a Timeout action
 * @param {{ alertChannelId: string | null }} ctx
 */
function buildActions(cfg, syloRuleKey, { allowTimeout }, ctx) {
  const actions = [
    { type: AutoModerationActionType.BlockMessage, metadata: { customMessage: BLOCK_MESSAGE } },
  ];
  if (ctx.alertChannelId) {
    actions.push({
      type: AutoModerationActionType.SendAlertMessage,
      metadata: { channel: ctx.alertChannelId },
    });
  }
  if (allowTimeout && cfg.rules?.[syloRuleKey]?.action === 'timeout') {
    actions.push({
      type: AutoModerationActionType.Timeout,
      metadata: { durationSeconds: clampTimeoutSeconds(cfg.timeoutMinutes) },
    });
  }
  return actions;
}

/**
 * The full set of native rules the config asks for, keyed by Sylo rule key.
 * Empty when native enforcement is off.
 * @param {object} cfg  normalised automod config
 * @param {{ alertChannelId?: string | null }} [ctx]
 * @returns {Map<string, object>}  key -> rule payload (create/edit shape, with `name`)
 */
export function desiredRules(cfg, ctx = {}) {
  const out = new Map();
  const n = cfg?.native;
  if (!n?.enabled) return out;

  const base = {
    eventType: AutoModerationRuleEventType.MessageSend,
    enabled: true,
    exemptRoles: (cfg.exemptRoles ?? []).slice(0, EXEMPT_ROLES_MAX),
    exemptChannels: (cfg.exemptChannels ?? []).slice(0, EXEMPT_CHANNELS_MAX),
  };
  const alertChannelId = ctx.alertChannelId ?? null;

  if (n.words && cfg.rules?.words?.enabled) {
    const keywordFilter = (cfg.rules.words.list ?? [])
      .map((w) => `*${w}*`)
      .filter((w) => w.length <= KEYWORD_ENTRY_MAX)
      .slice(0, KEYWORD_FILTER_MAX);
    if (keywordFilter.length) {
      out.set('words', {
        ...base,
        name: RULE_NAMES.words,
        triggerType: AutoModerationRuleTriggerType.Keyword,
        triggerMetadata: { keywordFilter },
        actions: buildActions(cfg, 'words', { allowTimeout: true }, { alertChannelId }),
      });
    }
  }

  if (n.mentions && cfg.rules?.mentions?.enabled) {
    out.set('mentions', {
      ...base,
      name: RULE_NAMES.mentions,
      triggerType: AutoModerationRuleTriggerType.MentionSpam,
      triggerMetadata: {
        mentionTotalLimit: Math.min(MENTION_LIMIT_MAX, Math.max(1, cfg.rules.mentions.max || 5)),
      },
      actions: buildActions(cfg, 'mentions', { allowTimeout: true }, { alertChannelId }),
    });
  }

  if (n.spam && cfg.rules?.spam?.enabled) {
    out.set('spam', {
      ...base,
      name: RULE_NAMES.spam,
      triggerType: AutoModerationRuleTriggerType.Spam,
      triggerMetadata: {},
      actions: buildActions(cfg, 'spam', { allowTimeout: false }, { alertChannelId }),
    });
  }

  const presets = (n.presets ?? []).map((p) => PRESET_ENUM[p]).filter(Boolean);
  if (presets.length) {
    out.set('preset', {
      ...base,
      name: RULE_NAMES.preset,
      triggerType: AutoModerationRuleTriggerType.KeywordPreset,
      triggerMetadata: { presets, allowList: [] },
      // Mirror the words rule's action preference for the preset lists too.
      actions: buildActions(cfg, 'words', { allowTimeout: true }, { alertChannelId }),
    });
  }

  return out;
}

/** Ids from either a string[] or a discord.js Collection. */
function toIds(x) {
  if (!x) return [];
  if (typeof x.keys === 'function') return [...x.keys()];
  return Array.isArray(x) ? [...x] : [];
}

/** A comparable projection of the fields Sylo manages, for a rule or a payload. */
function project(ruleOrPayload) {
  const tm = ruleOrPayload.triggerMetadata ?? {};
  const actions = (ruleOrPayload.actions ?? [])
    .map((a) => {
      const m = a.metadata ?? {};
      return {
        type: a.type,
        channelId: m.channel ?? m.channelId ?? null,
        durationSeconds: m.durationSeconds ?? null,
        customMessage: m.customMessage ?? null,
      };
    })
    .sort((a, b) => a.type - b.type);
  return JSON.stringify({
    enabled: ruleOrPayload.enabled !== false,
    keywordFilter: [...(tm.keywordFilter ?? [])].sort(),
    presets: [...(tm.presets ?? [])].sort(),
    mentionTotalLimit: tm.mentionTotalLimit ?? null,
    exemptRoles: toIds(ruleOrPayload.exemptRoles).sort(),
    exemptChannels: toIds(ruleOrPayload.exemptChannels).sort(),
    actions,
  });
}

/** True when a live rule needs an edit to match the desired payload. */
export function payloadsDiffer(rule, payload) {
  return project(rule) !== project(payload);
}

/**
 * Diff the desired native rules against the Sylo-owned rules that already exist.
 * Pure — the caller does the API calls.
 * @param {Map<string, object>} desired   from desiredRules()
 * @param {Array<object>} existing         Sylo-owned rules only (isSyloRule filtered)
 * @returns {{ create: Array<{key,payload}>, edit: Array<{rule,payload}>, remove: Array<object> }}
 */
export function planSync(desired, existing) {
  const byName = new Map(existing.map((r) => [r.name, r]));
  const create = [];
  const edit = [];
  const wanted = new Set();

  for (const [key, payload] of desired) {
    wanted.add(payload.name);
    const current = byName.get(payload.name);
    if (!current) create.push({ key, payload });
    else if (payloadsDiffer(current, payload)) edit.push({ rule: current, payload });
  }

  const remove = existing.filter((r) => !wanted.has(r.name));
  return { create, edit, remove };
}

/** `.edit()` rejects triggerType — it cannot change after creation. */
function forEdit(payload) {
  const rest = { ...payload };
  delete rest.triggerType;
  return rest;
}

/**
 * Reconcile a guild's native AutoMod rules with its automod config. Never throws.
 * @param {import('discord.js').Guild} guild
 * @param {object} cfg  normalised automod config
 * @returns {Promise<{ ok: boolean, skipped?: string, created: number, edited: number,
 *   removed: number, errors: string[] }>}
 */
export async function syncGuildAutomod(guild, cfg) {
  const result = { ok: true, created: 0, edited: 0, removed: 0, errors: [] };

  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return { ...result, ok: false, skipped: 'missing-permission' };
  }

  const alertChannelId = getGuildSettings(guild.id)?.modlog_channel_id || null;
  const desired = desiredRules(cfg, { alertChannelId });

  let existing;
  try {
    const all = await guild.autoModerationRules.fetch();
    existing = [...all.values()].filter(isSyloRule);
  } catch (err) {
    log.error('module:automod', 'native rule fetch failed:', err.message);
    return { ...result, ok: false, skipped: 'fetch-failed', errors: [err.message] };
  }

  const plan = planSync(desired, existing);

  for (const { payload } of plan.create) {
    try {
      await guild.autoModerationRules.create({ ...payload, reason: 'Sylo automod: native enforcement' });
      result.created += 1;
    } catch (err) {
      result.errors.push(`create "${payload.name}": ${err.message}`);
    }
  }
  for (const { rule, payload } of plan.edit) {
    try {
      await rule.edit({ ...forEdit(payload), reason: 'Sylo automod: sync' });
      result.edited += 1;
    } catch (err) {
      result.errors.push(`edit "${payload.name}": ${err.message}`);
    }
  }
  for (const rule of plan.remove) {
    try {
      await rule.delete('Sylo automod: native enforcement disabled');
      result.removed += 1;
    } catch (err) {
      result.errors.push(`delete "${rule.name}": ${err.message}`);
    }
  }

  if (result.errors.length) {
    result.ok = false;
    log.warn('module:automod', `native sync incomplete: ${result.errors.join('; ')}`);
  }
  return result;
}
