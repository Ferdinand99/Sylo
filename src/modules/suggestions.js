// Suggestions: members post an idea with /suggest (or, when the server turns it on, by writing a
// plain message in the suggestions channel). Sylo posts it as an embed with 👍 / 👎 buttons and live
// counts, opens a discussion thread on Discord, and numbers it per server (#1, #2, ...). Staff
// approve, deny, mark as implemented or "considering" with an optional reason; the embed changes
// colour and status, the author gets an optional DM, and a decided suggestion can move to a log
// channel. One vote per member; pressing the same button again takes the vote back.
//
// config shape: { channel, logChannel, anonymous, dmAuthor, messagesToSuggestions, cooldownSeconds, staffRoles }
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { clientOfGuild, guildByKey, guildKey, guildSupports } from '../platform/platformOf.js';
import { registerComponent } from '../bot/lib/components.js';
import { getGuildModule, isModuleEnabled } from '../db/modules.js';
import {
  createSuggestion as insertSuggestion,
  decideSuggestion,
  deleteSuggestion,
  getSuggestion,
  getSuggestionVote,
  lastSuggestionAtOf,
  openSuggestionCountOf,
  removeSuggestionVote,
  setSuggestionMessage,
  setSuggestionVote,
  suggestionCount,
} from '../db/suggestions.js';
import { LIMITS as CEILINGS, checkLimit } from '../lib/limits.js';
import { log } from '../lib/log.js';
import { idList } from '../web/lib/idList.js';
import { on } from './dispatch.js';
import { after } from './schedule.js';

/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  title: { maxLength: 100 },
  text: { maxLength: 1000 },
  reason: { maxLength: 500 },
  // 0 turns the cooldown off
  cooldownSeconds: { min: 0, max: 3600 },
  staffRoles: { maxItems: 25 },
};

const DEFAULT_COOLDOWN = 60;
/** A burst of votes produces one message edit per this long. */
const REFRESH_MS = 3000;
const DM_QUOTE = 200;

/** What each status looks like, and which action sets it. */
export const STATUS_META = {
  open: { label: 'Open', emoji: '⏳', color: 0x5865f2 },
  considering: { label: 'Considering', emoji: '🤔', color: 0xfaa61a },
  approved: { label: 'Approved', emoji: '✅', color: 0x57f287 },
  denied: { label: 'Denied', emoji: '❌', color: 0xed4245 },
  implemented: { label: 'Implemented', emoji: '🚀', color: 0x9b59b6 },
};
/** Staff action -> the status it sets. */
export const ACTIONS = {
  approve: 'approved',
  deny: 'denied',
  implement: 'implemented',
  consider: 'considering',
};
/** Decided: voting is closed and the post may move to the log channel. */
const FINAL = new Set(['approved', 'denied', 'implemented']);
export const isFinalStatus = (status) => FINAL.has(status);

const text = (v, max) =>
  String(v ?? '')
    .trim()
    .slice(0, max);
const idOrEmpty = (v) => (/^\d{17,20}$/.test(v ?? '') ? v : '');

/** Server-wide settings. */
export function normaliseSuggestionsConfig(raw = {}) {
  const cooldown = Math.floor(Number(raw.cooldownSeconds));
  return {
    channel: idOrEmpty(raw.channel),
    logChannel: idOrEmpty(raw.logChannel),
    anonymous: Boolean(raw.anonymous),
    // on unless switched off
    dmAuthor: raw.dmAuthor === undefined ? true : Boolean(raw.dmAuthor),
    messagesToSuggestions: Boolean(raw.messagesToSuggestions),
    cooldownSeconds: Number.isFinite(cooldown)
      ? Math.max(LIMITS.cooldownSeconds.min, Math.min(cooldown, LIMITS.cooldownSeconds.max))
      : DEFAULT_COOLDOWN,
    staffRoles: idList(raw.staffRoles, LIMITS.staffRoles.maxItems),
  };
}

/** The text of a suggestion, cut to the limits. Whether it is enough to post is parseSuggestionInput's job. */
export function normaliseSuggestionFields(raw = {}) {
  return { title: text(raw.title, LIMITS.title.maxLength), text: text(raw.text, LIMITS.text.maxLength) };
}

/** A staff reason, cut to the limit. */
export const normaliseReason = (v) => text(v, LIMITS.reason.maxLength);

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

/** @returns {{ ok: true, value: { title: string, text: string } } | { ok: false, error: string }} */
export function parseSuggestionInput(raw = {}) {
  const value = normaliseSuggestionFields(raw);
  if (!value.text) return fail('Write what you suggest.');
  return { ok: true, value };
}

// --- who may decide ---------------------------------------------------------------------------

const hasPermission = (permissions, name) => {
  try {
    return Boolean(permissions?.has?.(name));
  } catch {
    return false;
  }
};

/**
 * Staff = Manage Server or Administrator (who can already use the dashboard), or one of the staff
 * roles set on the module's page.
 * @param {{ roles?: { cache?: { has(id: string): boolean } } } | null} member
 * @param {any} permissions  the member's permissions in the guild
 * @param {{ staffRoles?: string[] }} cfg
 */
export function canManageSuggestions(member, permissions, cfg = {}) {
  if (['ManageGuild', 'Administrator'].some((p) => hasPermission(permissions, p))) return true;
  const roles = Array.isArray(cfg.staffRoles) ? cfg.staffRoles : [];
  return roles.some((id) => member?.roles?.cache?.has?.(id));
}

// --- the posted message -----------------------------------------------------------------------

/**
 * The message for a suggestion in its current state.
 * @param {object} row  a stored suggestion (db/suggestions.js)
 * @param {{ up?: number, down?: number }} [tally]
 */
export function buildSuggestionPayload(row, { up = 0, down = 0 } = {}) {
  const meta = STATUS_META[row.status] ?? STATUS_META.open;
  const closed = FINAL.has(row.status);
  const fields = [];
  if (!row.anonymous && row.author_id)
    fields.push({ name: 'Suggested by', value: `<@${row.author_id}>`, inline: true });
  fields.push({
    name: 'Status',
    value: `${meta.emoji} ${meta.label}${row.decided_by && row.status !== 'open' ? ` by <@${row.decided_by}>` : ''}`,
    inline: true,
  });
  if (row.reason) fields.push({ name: 'Reason from staff', value: row.reason });
  fields.push({ name: closed ? 'Final votes' : 'Votes', value: `👍 ${up} · 👎 ${down}` });

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`💡 Suggestion #${row.number}${row.title ? `: ${row.title}` : ''}`)
    .setDescription(row.body)
    .addFields(fields)
    .setTimestamp(row.created_at);

  const payload = { embeds: [embed], components: [], allowedMentions: { parse: [] } };
  if (!closed) {
    payload.components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`sug:up:${row.id}`)
          .setStyle(ButtonStyle.Success)
          .setLabel(`👍 ${up}`),
        new ButtonBuilder()
          .setCustomId(`sug:down:${row.id}`)
          .setStyle(ButtonStyle.Danger)
          .setLabel(`👎 ${down}`)
      ),
    ];
  }
  return payload;
}

async function channelOf(guild, channelId) {
  return guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
}

async function fetchMessage(guild, channelId, messageId) {
  const channel = await channelOf(guild, channelId);
  if (!channel?.isTextBased?.() || !messageId) return null;
  return channel.messages.fetch(messageId).catch(() => null);
}

const pendingRefresh = new Map();

/** Edit the posted message to match the stored suggestion. Quiet when the message is gone. */
export async function refreshSuggestionMessage(id) {
  pendingRefresh.get(id)?.cancel();
  pendingRefresh.delete(id);
  const row = await getSuggestion(id);
  const guild = row && guildByKey(row.guild_id);
  if (!guild || !row.message_id) return false;
  const msg = await fetchMessage(guild, row.channel_id, row.message_id);
  if (!msg) return false;
  await msg
    .edit(buildSuggestionPayload(row, row))
    .catch((err) => log.warn('suggestions', `edit #${row.number} failed:`, err.message));
  return true;
}

/** Queue a trailing refresh: a burst of votes yields one edit. */
function scheduleRefresh(id) {
  if (pendingRefresh.has(id)) return;
  const handle = after('suggestions', REFRESH_MS, () => {
    pendingRefresh.delete(id);
    return refreshSuggestionMessage(id).catch((err) =>
      log.error('suggestions', 'refresh failed:', err.message)
    );
  });
  pendingRefresh.set(id, handle);
}

// --- create -----------------------------------------------------------------------------------

/** One create at a time per server, so the ceilings, the cooldown and the numbering cannot interleave. */
const chains = new Map();
async function withLock(key, fn) {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  try {
    return await run;
  } finally {
    if (chains.get(key) === tail) chains.delete(key);
  }
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Post a new suggestion. Checks the cooldown and the ceilings first.
 * @param {{ guild: any, channelId: string, authorId: string, input: { title?: string, text: string }, cfg: object }} args
 *   `input` is the `value` of a successful parseSuggestionInput().
 * @returns {Promise<{ ok: true, id: number, number: number, channelId: string } | { ok: false, error: string, cooldown?: boolean }>}
 */
export async function createSuggestion({ guild, channelId, authorId, input, cfg }) {
  const guildId = guildKey(guild);
  const channel = await channelOf(guild, channelId);
  if (!channel?.isTextBased?.()) return fail('Sylo cannot find the suggestions channel.');

  const made = await withLock(guildId, async () => {
    const cooldownMs = (cfg.cooldownSeconds ?? 0) * 1000;
    if (cooldownMs > 0) {
      const wait = (await lastSuggestionAtOf(guildId, authorId)) + cooldownMs - Date.now();
      if (wait > 0)
        return fail(`Wait ${Math.ceil(wait / 1000)} s before your next suggestion.`, { cooldown: true });
    }
    try {
      checkLimit(
        await openSuggestionCountOf(guildId, authorId),
        CEILINGS.openSuggestionsPerMember,
        'open suggestions per member'
      );
      checkLimit(await suggestionCount(guildId), CEILINGS.suggestions, 'stored suggestions');
    } catch (err) {
      return fail(
        err.message.includes('per member')
          ? `You already have ${CEILINGS.openSuggestionsPerMember} open suggestions. Wait until staff have decided on some.`
          : `${err.message} Staff can delete old ones on the dashboard.`
      );
    }
    return {
      ok: true,
      ...(await insertSuggestion({
        guildId,
        channelId,
        authorId,
        anonymous: cfg.anonymous,
        title: input.title ?? '',
        body: input.text,
      })),
    };
  });
  if (!made.ok) return made;

  try {
    const row = await getSuggestion(made.id);
    const message = await channel.send(buildSuggestionPayload(row));
    await setSuggestionMessage(made.id, channelId, message.id);
    if (guildSupports(guild, 'threads') && typeof message.startThread === 'function') {
      // The thread is a nicety: no permission or an old channel type must not undo the post.
      await message
        .startThread({
          name: `#${row.number} ${oneLine(row.title || row.body)}`.slice(0, 100),
          autoArchiveDuration: 1440,
        })
        .catch((err) => log.debug?.('suggestions', `no thread for #${row.number}:`, err.message));
    }
    return { ok: true, id: made.id, number: row.number, channelId, message };
  } catch (err) {
    await deleteSuggestion(made.id);
    log.warn('suggestions', `could not post in ${channelId}:`, err.message);
    return fail(
      'Sylo could not post in that channel. It needs View Channel, Send Messages and Embed Links there.'
    );
  }
}

// --- staff decisions --------------------------------------------------------------------------

async function sendDecisionDm(row, guild) {
  if (!row.author_id) return false;
  const meta = STATUS_META[row.status];
  const quote = oneLine(row.body).slice(0, DM_QUOTE);
  const lines = [
    `💡 Your suggestion **#${row.number}** in **${guild.name}** is now **${meta.label.toLowerCase()}** ${meta.emoji}`,
    `> ${quote}${row.body.length > DM_QUOTE ? '…' : ''}`,
  ];
  if (row.reason) lines.push(`**Reason:** ${row.reason}`);
  try {
    const user = await clientOfGuild(guild).users.fetch(row.author_id);
    await user.send({ content: lines.join('\n'), allowedMentions: { parse: [] } });
    return true;
  } catch {
    return false; // DMs closed, or the person left: nothing to report
  }
}

/** Repost a decided suggestion in the log channel and delete the original. False when it stayed. */
async function moveToLog(row, guild, logChannelId) {
  const target = await channelOf(guild, logChannelId);
  if (!target?.isTextBased?.()) return false;
  let sent;
  try {
    sent = await target.send(buildSuggestionPayload(row, row));
  } catch (err) {
    log.warn('suggestions', `could not move #${row.number} to the log channel:`, err.message);
    return false;
  }
  const original = await fetchMessage(guild, row.channel_id, row.message_id);
  await setSuggestionMessage(row.id, logChannelId, sent.id);
  await original?.delete?.().catch(() => {});
  return true;
}

/**
 * Set a suggestion's status, update the post, and (on a final decision) move it to the log
 * channel and DM the author. The caller has checked who may do this.
 * @param {object} row  the stored suggestion
 * @param {keyof typeof ACTIONS} action
 * @param {{ reason?: string, by: string }} opts
 * @returns {Promise<{ ok: true, status: string, moved: boolean, dm: boolean } | { ok: false, error: string }>}
 */
export async function decide(row, action, { reason = '', by }) {
  const status = ACTIONS[action];
  if (!status) return fail('Unknown action.');
  const guild = guildByKey(row.guild_id);
  const cfg = normaliseSuggestionsConfig((await getGuildModule(row.guild_id, 'suggestions')).config);

  await decideSuggestion(row.id, { status, reason: normaliseReason(reason), decidedBy: by });
  let fresh = await getSuggestion(row.id);

  let moved = false;
  if (guild) {
    if (FINAL.has(status) && cfg.logChannel && fresh.channel_id !== cfg.logChannel) {
      moved = await moveToLog(fresh, guild, cfg.logChannel);
    }
    if (!moved) await refreshSuggestionMessage(row.id).catch(() => {});
  }
  fresh = await getSuggestion(row.id);
  const dm = guild && cfg.dmAuthor ? await sendDecisionDm(fresh, guild) : false;
  return { ok: true, status, moved, dm };
}

/** Delete a suggestion, its votes and (best effort) its post. */
export async function removeSuggestion(row) {
  const guild = guildByKey(row.guild_id);
  const msg = guild && (await fetchMessage(guild, row.channel_id, row.message_id));
  await msg?.delete?.().catch(() => {});
  await deleteSuggestion(row.id);
}

// --- voting -----------------------------------------------------------------------------------

const eph = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

const ARROW = { up: '👍', down: '👎' };

async function handleVote(interaction, dir, id) {
  const row = await getSuggestion(id);
  if (!row || row.guild_id !== interaction.guildId)
    return eph(interaction, 'This suggestion no longer exists.');
  if (!(await isModuleEnabled(interaction.guildId, 'suggestions'))) {
    return eph(interaction, 'Suggestions are disabled in this server.');
  }
  if (FINAL.has(row.status)) return eph(interaction, 'Voting on this suggestion is closed.');

  const userId = interaction.user.id;
  const want = dir === 'up' ? 1 : -1;
  const current = await getSuggestionVote(id, userId);
  let reply;
  if (current === want) {
    await removeSuggestionVote(id, userId);
    reply = `Your ${ARROW[dir]} vote on #${row.number} is taken back.`;
  } else {
    await setSuggestionVote(id, userId, want);
    reply = current
      ? `Changed your vote on #${row.number} to ${ARROW[dir]}.`
      : `You voted ${ARROW[dir]} on #${row.number}.`;
  }
  scheduleRefresh(id);
  return eph(interaction, reply);
}

registerComponent('suggestions', 'sug:', (interaction) => {
  const [, dir, id] = interaction.customId.split(':');
  if (!['up', 'down'].includes(dir) || !/^\d+$/.test(id ?? '')) return undefined;
  return handleVote(interaction, dir, Number(id));
});

// --- plain messages in the suggestions channel -------------------------------------------------

const NOTICE_MS = 10_000;

on('suggestions', 'messageCreate', async (message, config, guildId) => {
  const cfg = normaliseSuggestionsConfig(config);
  if (!cfg.messagesToSuggestions || !cfg.channel || message.channelId !== cfg.channel) return;
  if (message.author?.bot || !message.guild) return;
  // A message with attachments would lose them when it is replaced by the embed: leave it alone.
  if (message.attachments?.size) return;
  const parsed = parseSuggestionInput({ text: message.content });
  if (!parsed.ok) return;

  const notice = async (content) => {
    const sent = await message
      .reply({ content, allowedMentions: { parse: [], repliedUser: false } })
      .catch(() => null);
    if (sent) after('suggestions', NOTICE_MS, () => sent.delete?.().catch(() => {}));
  };
  if (String(message.content).trim().length > LIMITS.text.maxLength) {
    return notice(`Suggestions can be at most ${LIMITS.text.maxLength} characters. Please shorten yours.`);
  }
  const result = await createSuggestion({
    guild: message.guild,
    channelId: cfg.channel,
    authorId: message.author.id,
    input: parsed.value,
    cfg,
  });
  if (!result.ok) return notice(result.error);
  await message.delete().catch(() => {}); // needs Manage Messages; without it the original just stays
  log.debug?.('suggestions', `#${result.number} created from a message in ${guildId}`);
});
