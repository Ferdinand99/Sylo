// Suggestions: members post an idea with /suggest (or, when the server turns it on, by writing a
// plain message in the suggestions channel). Sylo posts it as an embed with 👍 / 👎 buttons and live
// counts, opens a discussion thread on Discord, and numbers it per server (#1, #2, ...). Staff
// approve, deny, mark as implemented or "considering" with an optional reason; the embed changes
// colour and status, the author gets an optional DM, and a decided suggestion goes to a log
// channel when the server sets one: either as a copy (the original stays and shows its status) or by
// moving (the original is deleted). One vote per member; pressing the same button again takes the
// vote back.
//
// config shape: { channel, logChannel, logMode, anonymous, dmAuthor, messagesToSuggestions, cooldownSeconds, staffRoles }
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
  listSuggestionsOutside,
  removeSuggestionVote,
  setSuggestionLog,
  setSuggestionMessage,
  setSuggestionVote,
  suggestionCount,
} from '../db/suggestions.js';
import { LIMITS as CEILINGS, checkLimit } from '../lib/limits.js';
import { isMessageGone, isPermissionDenied } from '../platform/messageErrors.js';
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
/** What a decided suggestion does when a log channel is set: keep the original and post a copy, or move it. */
export const LOG_MODES = ['copy', 'move'];

/** Decided: voting is closed and the post may go to the log channel. */
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
  const logChannel = idOrEmpty(raw.logChannel);
  return {
    channel: idOrEmpty(raw.channel),
    logChannel,
    // A config saved before the setting existed that has a log channel keeps moving, so nothing
    // changes silently. A new config (no log channel yet) copies.
    logMode: LOG_MODES.includes(raw.logMode) ? raw.logMode : logChannel ? 'move' : 'copy',
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

/**
 * Edit, delete or look up a message we posted, by id. Answers 'ok', 'gone' (the platform says it
 * does not exist), 'denied' (no access or permission, for good) or 'error' (anything else: a
 * timeout, a 5xx). Only 'gone' may be read as "the message is not there": on 'error' callers keep
 * their pointer and post nothing new. Editing and deleting by id needs no lookup first, and
 * Discord lets the bot do both to its own posts without Read Message History.
 * @param {'edit' | 'delete' | 'fetch'} action
 * @returns {Promise<'ok' | 'gone' | 'denied' | 'error'>}
 */
async function actOnMessage(guild, channelId, messageId, action, payload, what = 'message') {
  if (!channelId || !messageId) return 'gone';
  let channel = guild.channels.cache.get(channelId);
  try {
    channel ??= await guild.channels.fetch(channelId);
  } catch (err) {
    if (isMessageGone(err)) return 'gone';
    log.warn('suggestions', `could not look up the channel of ${what}:`, err.message);
    return isPermissionDenied(err) ? 'denied' : 'error';
  }
  if (!channel) return 'gone';
  if (!channel.isTextBased?.()) return 'denied';
  try {
    if (action === 'edit') await channel.messages.edit(messageId, payload);
    else if (action === 'delete') await channel.messages.delete(messageId);
    else if (!(await channel.messages.fetch(messageId))) return 'gone';
    return 'ok';
  } catch (err) {
    if (isMessageGone(err)) return 'gone';
    log.warn('suggestions', `could not ${action} ${what}:`, err.message);
    return isPermissionDenied(err) ? 'denied' : 'error';
  }
}

const editMessage = (guild, channelId, messageId, payload, what) =>
  actOnMessage(guild, channelId, messageId, 'edit', payload, what);
const deleteMessage = (guild, channelId, messageId, what) =>
  actOnMessage(guild, channelId, messageId, 'delete', undefined, what);
const probeMessage = (guild, channelId, messageId, what) =>
  actOnMessage(guild, channelId, messageId, 'fetch', undefined, what);

const pendingRefresh = new Map();

/** Edit the posted message to match the stored suggestion. Quiet when the message is gone. */
export async function refreshSuggestionMessage(id) {
  pendingRefresh.get(id)?.cancel();
  pendingRefresh.delete(id);
  const row = await getSuggestion(id);
  const guild = row && guildByKey(row.guild_id);
  if (!guild || !row.message_id) return false;
  const state = await editMessage(
    guild,
    row.channel_id,
    row.message_id,
    buildSuggestionPayload(row, row),
    `#${row.number}`
  );
  return state === 'ok';
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
  await setSuggestionMessage(row.id, logChannelId, sent.id);
  await deleteMessage(guild, row.channel_id, row.message_id, `the original of #${row.number}`);
  return true;
}

/**
 * Delete the copy in the log channel and forget where it was. The pointer is cleared when the copy
 * is deleted, confirmed gone, or out of reach for good (no access). After a failure that may pass
 * (a timeout, a 5xx) it stays, so a later call can still remove the copy, unless `force` says the
 * copy is in a retired channel and must not hold up the new one.
 * @returns {Promise<boolean>} whether the pointer is cleared
 */
async function dropLogCopy(row, guild, { force = false } = {}) {
  if (!row.log_message_id) return true;
  const state = await deleteMessage(
    guild,
    row.log_channel_id,
    row.log_message_id,
    `the log copy of #${row.number}`
  );
  if (state === 'error' && !force) return false;
  await setSuggestionLog(row.id);
  return true;
}

/**
 * Bring the copy in the log channel in line with the suggestion: only a decided suggestion in
 * "copy" mode has one. It is edited in place, posted again when it is gone, and deleted when the
 * suggestion goes back to open or considering (or the log channel is off or changed).
 * `adopted`: the copy is an old post that was just taken over as the copy, so it already shows the
 * suggestion as it is and needs no edit.
 * @returns {Promise<boolean>} whether a copy is in the log channel afterwards (or may be: when the
 *   platform could not be asked, the stored copy is kept and nothing new is posted)
 */
function syncLogCopy(id, guild, cfg, { adopted = false } = {}) {
  // One at a time per suggestion, so two quick decisions cannot post two copies.
  return withLock(`log:${id}`, async () => {
    const row = await getSuggestion(id);
    if (!row) return false;
    const wanted =
      cfg.logChannel &&
      cfg.logMode === 'copy' &&
      FINAL.has(row.status) &&
      // The post itself is already in the log channel (moved there earlier): no second one.
      row.channel_id !== cfg.logChannel;
    if (!wanted) {
      await dropLogCopy(row, guild);
      return false;
    }
    const payload = buildSuggestionPayload(row, row);
    if (row.log_message_id && row.log_channel_id === cfg.logChannel) {
      if (adopted) return true;
      const state = await editMessage(
        guild,
        row.log_channel_id,
        row.log_message_id,
        payload,
        `the log copy of #${row.number}`
      );
      // 'error': could not tell, so keep the copy and its pointer and do not post a second one.
      if (state !== 'gone') return true;
      // The platform says the copy is gone: post a new one below.
    } else {
      // A copy in another channel than the log channel set now: remove it if possible, but an
      // orphan in a retired channel is the smaller harm, so it does not stop the new copy.
      await dropLogCopy(row, guild, { force: true });
    }
    const target = await channelOf(guild, cfg.logChannel);
    try {
      if (!target?.isTextBased?.()) throw new Error('log channel not found');
      const sent = await target.send(payload);
      await setSuggestionLog(row.id, cfg.logChannel, sent.id);
      return true;
    } catch (err) {
      log.warn('suggestions', `could not post #${row.number} in the log channel:`, err.message);
      await setSuggestionLog(row.id);
      return false;
    }
  });
}

/**
 * Set a suggestion's status, update the post, and keep the log channel in line: in "move" mode a
 * final decision moves the post there, in "copy" mode the post stays and a copy is posted or
 * updated. The author is DMed. The caller has checked who may do this.
 * @param {object} row  the stored suggestion
 * @param {keyof typeof ACTIONS} action
 * @param {{ reason?: string, by: string }} opts
 * @returns {Promise<{ ok: true, status: string, moved: boolean, copied: boolean, dm: boolean } | { ok: false, error: string }>}
 */
export async function decide(row, action, { reason = '', by }) {
  const status = ACTIONS[action];
  if (!status) return fail('Unknown action.');
  const guild = guildByKey(row.guild_id);
  const cfg = normaliseSuggestionsConfig((await getGuildModule(row.guild_id, 'suggestions')).config);

  // Under the server's move lock, so a decision cannot land in the middle of a "move back" of the
  // same suggestion and leave the new post showing the old status.
  const { moved, copied } = await withLock(`move:${row.guild_id}`, async () => {
    await decideSuggestion(row.id, { status, reason: normaliseReason(reason), decidedBy: by });
    const current = await getSuggestion(row.id);
    let didMove = false;
    let didCopy = false;
    if (guild) {
      const movesToLog = cfg.logChannel && cfg.logMode === 'move';
      if (movesToLog && FINAL.has(status) && current.channel_id !== cfg.logChannel) {
        // A copy left from "copy" mode would double the post in the log channel.
        await dropLogCopy(current, guild);
        didMove = await moveToLog(current, guild, cfg.logChannel);
      }
      if (!didMove) await refreshSuggestionMessage(row.id).catch(() => {});
      // Copy mode keeps a copy; every other setup keeps none (this also tidies one left behind).
      didCopy = await syncLogCopy(row.id, guild, cfg).catch((err) => {
        log.warn('suggestions', `log copy of #${row.number} failed:`, err.message);
        return false;
      });
    }
    return { moved: didMove, copied: didCopy };
  });
  const fresh = await getSuggestion(row.id);
  const dm = guild && cfg.dmAuthor ? await sendDecisionDm(fresh, guild) : false;
  return { ok: true, status, moved, copied, dm };
}

// --- move back to the suggestions channel -------------------------------------------------------

/** "Move all back" does this many per call, so one request stays short; the caller asks again. */
export const MOVE_ALL_BATCH = 10;

/**
 * Whether the suggestion's own post is somewhere else than the suggestions channel (for example
 * after an earlier move to the log channel), so it can be moved back. False when no suggestions
 * channel is set.
 */
export const canMoveBack = (row, cfg) => Boolean(cfg.channel) && row.channel_id !== cfg.channel;

async function moveBackLocked(id) {
  const row = await getSuggestion(id);
  // Deleted since the caller looked: nothing to move (a "move all" goes on with the next one).
  if (!row) return fail('No such suggestion.', { skip: true });
  const guild = guildByKey(row.guild_id);
  if (!guild) return fail('Sylo is not connected to this server right now.', { stop: true });
  const cfg = normaliseSuggestionsConfig((await getGuildModule(row.guild_id, 'suggestions')).config);
  if (!cfg.channel) {
    return fail('Set the suggestions channel first: without it there is nowhere to move it back to.', {
      stop: true,
    });
  }
  if (!canMoveBack(row, cfg)) {
    return fail(`#${row.number} is already in the suggestions channel.`, { skip: true });
  }

  const target = await channelOf(guild, cfg.channel);
  if (!target?.isTextBased?.()) return fail('Sylo cannot find the suggestions channel.', { stop: true });

  // Look at the old post before anything is posted: if Sylo has no access to it for good, the move
  // cannot finish (the old post could not be removed), so skip it without a post that would only
  // be taken back. "Gone" is fine (nothing to remove); a lookup that fails for any other reason
  // goes on, and a refused delete later takes the new post back.
  const old = { channelId: row.channel_id, messageId: row.message_id };
  const oldState = await probeMessage(guild, old.channelId, old.messageId, `the old post of #${row.number}`);
  if (oldState === 'denied') {
    return fail(`Sylo has no access to the old post of #${row.number}, so it was not moved.`, {
      skip: true,
      report: true,
    });
  }

  let sent;
  try {
    sent = await target.send(buildSuggestionPayload(row, row));
  } catch (err) {
    log.warn('suggestions', `could not move #${row.number} back to ${cfg.channel}:`, err.message);
    return fail(
      'Sylo could not post in the suggestions channel. It needs View Channel, Send Messages and Embed Links there.',
      { stop: true }
    );
  }

  // The old post: in "copy" mode a decided one in the log channel is the log copy from now on, if it
  // is still there. In every other case it goes.
  let keepAsCopy = Boolean(
    cfg.logChannel &&
    cfg.logMode === 'copy' &&
    FINAL.has(row.status) &&
    old.messageId &&
    old.channelId === cfg.logChannel &&
    !row.log_message_id
  );
  if (keepAsCopy && oldState === 'gone') {
    keepAsCopy = false; // deleted meanwhile: a fresh copy is posted below
  }
  if (!keepAsCopy) {
    const state = await deleteMessage(guild, old.channelId, old.messageId, `the old post of #${row.number}`);
    if (state === 'error' || state === 'denied') {
      // Could not remove it: take the new post back so the suggestion has one post, as before.
      await deleteMessage(guild, cfg.channel, sent.id, `the new post of #${row.number}`);
      return state === 'denied'
        ? // For good (Sylo has no access to the old post): "move all" skips this one and reports it.
          fail(`Sylo has no access to the old post of #${row.number}, so it was not moved.`, {
            skip: true,
            report: true,
          })
        : fail(`Sylo could not remove the old post of #${row.number}, so it was not moved. Try again.`, {
            stop: true,
          });
    }
  }
  await setSuggestionMessage(row.id, cfg.channel, sent.id);
  if (keepAsCopy) await setSuggestionLog(row.id, old.channelId, old.messageId);
  // Brings the log copy in line with the setup: one for a decided suggestion in "copy" mode, none
  // otherwise. An adopted old post already shows the suggestion as it is.
  await syncLogCopy(row.id, guild, cfg, { adopted: Boolean(keepAsCopy) }).catch((err) =>
    log.warn('suggestions', `log copy of #${row.number} failed:`, err.message)
  );
  return { ok: true, number: row.number };
}

/**
 * Post a suggestion again in the suggestions channel (same embed: number, status, reason and the
 * vote counts) and point it at the new post. The caller has checked who may do this.
 * @param {number} id  the suggestion's id
 * @returns {Promise<{ ok: true, number: number } | { ok: false, error: string, stop?: boolean, skip?: boolean, report?: boolean }>}
 *   `stop` marks an error that may hit every suggestion (no permission, no channel, a timeout).
 *   `skip` means this one cannot be moved but the next may be; `report` says it should be listed.
 */
export async function moveSuggestionBack(id) {
  const row = await getSuggestion(id);
  if (!row) return fail('No such suggestion.', { skip: true });
  // One move at a time per server, so "move all" and a click cannot post the same suggestion twice.
  return withLock(`move:${row.guild_id}`, () => moveBackLocked(id));
}

/**
 * Move the server's suggestions that sit outside the suggestions channel back into it, oldest
 * first, at most `limit` handled (moved, skipped or reported) per call, starting after number `after`. Stops at the first error
 * that may hit every suggestion and says which one it was. A suggestion that cannot be moved for
 * good (no access to its old post) is skipped and listed in `failed`. `next` is the number to pass
 * as `after` for the next call.
 * @param {string} guildId  the server's key
 * @returns {Promise<{ ok: true, moved: number, remaining: number, failed: { number: number, error: string }[], next: number } | { ok: false, error: string, moved: number, remaining: number, failed: { number: number, error: string }[], next: number, number?: number }>}
 */
export async function moveAllSuggestionsBack(guildId, { limit = MOVE_ALL_BATCH, after = 0 } = {}) {
  const cfg = normaliseSuggestionsConfig((await getGuildModule(guildId, 'suggestions')).config);
  if (!cfg.channel) {
    return {
      ...fail('Set the suggestions channel first: without it there is nowhere to move them back to.'),
      moved: 0,
      remaining: 0,
      failed: [],
      next: after,
    };
  }
  const rows = (await listSuggestionsOutside(guildId, cfg.channel)).filter((r) => r.number > after);
  let moved = 0;
  let handled = 0; // moved, skipped or reported: every one counts against the batch
  let next = after;
  const failed = [];
  let i = 0;
  for (; i < rows.length && handled < limit; i += 1) {
    const row = rows[i];
    const result = await moveSuggestionBack(row.id);
    handled += 1;
    if (result.ok) {
      moved += 1;
    } else if (result.report) {
      failed.push({ number: row.number, error: result.error });
    } else if (!result.skip) {
      return {
        ok: false,
        error: `Stopped at #${row.number}: ${result.error}`,
        moved,
        remaining: rows.length - i,
        failed,
        next,
        number: row.number,
      };
    }
    next = row.number;
  }
  return { ok: true, moved, remaining: rows.length - i, failed, next };
}

/** Delete a suggestion, its votes and (best effort) its post and its copy in the log channel. */
export async function removeSuggestion(row) {
  const guild = guildByKey(row.guild_id);
  if (guild) {
    await deleteMessage(guild, row.channel_id, row.message_id, `the post of #${row.number}`);
    await deleteMessage(guild, row.log_channel_id, row.log_message_id, `the log copy of #${row.number}`);
  }
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
