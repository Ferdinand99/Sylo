// Quote board: members save funny or memorable messages with the "Save quote" message menu
// (Discord) or /quote save <message link or reply> (Discord and Fluxer). Each quote is numbered
// per server (#1, #2, ...; a number is never reused), keeps the author's name, the text (cut to
// 2000 characters), the message's date and a count of its attachments (the files themselves are
// never copied), and can be shown again with /quote random|search|user|show. A quote can be
// removed by its author, by whoever saved it, and by staff. An optional public page lists the
// latest quotes (src/web/routes/quotes.js).
//
// config shape: { publicPage, saveMode: 'everyone' | 'roles', saveRoles, staffRoles }
import { EmbedBuilder } from 'discord.js';
import { guildKey } from '../platform/platformOf.js';
import { fluxerEndpoints } from '../platform/instance.js';
import { splitPlatformGuildId } from '../lib/platformId.js';
import { deleteQuote, getQuoteByMessage, getQuoteByNumber, insertQuote, quoteCount } from '../db/quotes.js';
import { LIMITS as CEILINGS, checkLimit } from '../lib/limits.js';
import { idList } from '../web/lib/idList.js';

/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  // the saved text of a quote
  text: { maxLength: 2000 },
  // what /quote search and the dashboard search look for
  query: { maxLength: 100 },
  saveRoles: { maxItems: 25 },
  staffRoles: { maxItems: 25 },
};

const NAME_MAX = 100;
const EMBED_COLOR = 0x5865f2;
const DESCRIPTION_MAX = 4096;

/** Cut to `max` UTF-16 units without leaving half of an emoji at the end. */
function cut(value, max) {
  const out = String(value ?? '').slice(0, max);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
}

/** A quote's text: trimmed and cut to the limit. */
export const normaliseQuoteText = (v) => cut(String(v ?? '').trim(), LIMITS.text.maxLength);

/** A search query: whitespace collapsed, cut to the limit. */
export const normaliseQuoteQuery = (v) =>
  cut(
    String(v ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
    LIMITS.query.maxLength
  );

const SAVE_MODES = ['everyone', 'roles'];

/** Server-wide settings. */
export function normaliseQuoteBoardConfig(raw = {}) {
  return {
    publicPage: raw.publicPage === true,
    saveMode: SAVE_MODES.includes(raw.saveMode) ? raw.saveMode : 'everyone',
    saveRoles: idList(raw.saveRoles, LIMITS.saveRoles.maxItems),
    staffRoles: idList(raw.staffRoles, LIMITS.staffRoles.maxItems),
  };
}

// --- who may do what ----------------------------------------------------------------------------

const hasPermission = (permissions, name) => {
  try {
    return Boolean(permissions?.has?.(name));
  } catch {
    return false;
  }
};
const hasRole = (member, ids) =>
  (Array.isArray(ids) ? ids : []).some((id) => member?.roles?.cache?.has?.(id));

/**
 * Staff = Manage Messages, Manage Server or Administrator, or one of the staff roles set on the
 * module's page.
 * @param {{ roles?: { cache?: { has(id: string): boolean } } } | null} member
 * @param {any} permissions  the member's permissions in the guild
 * @param {{ staffRoles?: string[] }} cfg
 */
export function canManageQuotes(member, permissions, cfg = {}) {
  if (['ManageMessages', 'ManageGuild', 'Administrator'].some((p) => hasPermission(permissions, p))) {
    return true;
  }
  return hasRole(member, cfg.staffRoles);
}

/** May this member save a quote? Everyone, or (saveMode "roles") staff and the listed roles. */
export function canSaveQuotes(member, permissions, cfg = {}) {
  if (cfg.saveMode !== 'roles') return true;
  return canManageQuotes(member, permissions, cfg) || hasRole(member, cfg.saveRoles);
}

/** May this member remove this quote? Its author, whoever saved it, or staff. */
export function canRemoveQuote(row, userId, member, permissions, cfg = {}) {
  if (userId && (row.author_id === userId || row.saved_by === userId)) return true;
  return canManageQuotes(member, permissions, cfg);
}

// --- message links --------------------------------------------------------------------------------

/**
 * The ids in a message link (`https://discord.com/channels/<server>/<channel>/<message>`, also the
 * canary / ptb / Fluxer forms), or null. Only the path counts: the caller checks that the server is
 * its own, and the message is fetched by id, so the host decides nothing.
 * @param {string} text
 * @returns {{ guildId: string, channelId: string, messageId: string } | null}
 */
export function parseMessageLink(text) {
  const m =
    /^<?https?:\/\/[^\s/<>]+\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})(?:[/?#][^\s<>]*)?>?$/i.exec(
      String(text ?? '').trim()
    );
  return m ? { guildId: m[1], channelId: m[2], messageId: m[3] } : null;
}

/** The link that opens a quote's message on the platform of the server `key` (a guild key). */
export function jumpUrl(key, channelId, messageId) {
  const split = splitPlatformGuildId(key);
  if (split?.platform === 'fluxer') {
    return `${fluxerEndpoints().webapp}/channels/${split.rawId}/${channelId}/${messageId}`;
  }
  return `https://discord.com/channels/${split?.rawId ?? key}/${channelId}/${messageId}`;
}

// --- saving ----------------------------------------------------------------------------------------

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

/** One save at a time per server, so the duplicate check, the ceiling and the numbering cannot interleave. */
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

/** Could @everyone read this channel (and is it not age-restricted)? Unknown counts as no. */
export function isPublicSource(guild, channel) {
  try {
    if (channel?.nsfw) return false;
    const everyone = guild?.roles?.everyone;
    return Boolean(everyone && channel?.permissionsFor?.(everyone)?.has?.('ViewChannel'));
  } catch {
    return false;
  }
}

const displayNameOf = (message) =>
  cut(
    String(
      message.member?.displayName ??
        message.author?.globalName ??
        message.author?.displayName ??
        message.author?.username ??
        ''
    ).trim(),
    NAME_MAX
  );

/**
 * Save a message as a quote. Saving the same message again returns the quote it already has.
 * @param {{ guild: any, message: any, savedBy: string }} args  `message` is a fetched message of `guild`
 * @returns {Promise<{ ok: true, existing: boolean, quote: object } | { ok: false, error: string }>}
 */
export async function saveQuote({ guild, message, savedBy }) {
  const key = guildKey(guild);
  const text = normaliseQuoteText(message.content);
  const attachments = Number(message.attachments?.size) || 0;
  if (!text && !attachments) {
    return fail('That message has no text or attachments, so there is nothing to save.');
  }
  if (!message.author?.id) return fail('Sylo cannot tell who wrote that message.');

  return withLock(key, async () => {
    const existing = await getQuoteByMessage(key, message.id);
    if (existing) return { ok: true, existing: true, quote: existing };
    try {
      checkLimit(await quoteCount(key), CEILINGS.quotes, 'quotes');
    } catch (err) {
      return fail(`${err.message} Remove some on the dashboard or with /quote remove first.`);
    }
    const channel = message.channel ?? guild.channels?.cache?.get?.(message.channelId);
    const { number } = await insertQuote({
      guildId: key,
      channelId: message.channelId ?? channel?.id,
      messageId: message.id,
      authorId: message.author.id,
      authorName: displayNameOf(message),
      body: text,
      attachments,
      messageAt: Number(message.createdTimestamp) || Date.now(),
      savedBy,
      publicSource: isPublicSource(guild, channel),
    });
    return { ok: true, existing: false, quote: await getQuoteByNumber(key, number) };
  });
}

/** Can this member see the channel? A check that cannot be made counts as no. */
export function canView(channel, member) {
  try {
    return Boolean(member && channel.permissionsFor?.(member)?.has?.('ViewChannel'));
  } catch {
    return false;
  }
}

/**
 * Fetch the message behind a link (or a reply) for saving. The person asking has to be able to
 * see the channel, or a link could be used to read a hidden one.
 * @returns {Promise<{ ok: true, message: any } | { ok: false, error: string }>}
 */
export async function fetchQuotable({ guild, member, channelId, messageId }) {
  const channel =
    guild.channels?.cache?.get?.(channelId) ?? (await guild.channels?.fetch?.(channelId).catch(() => null));
  if (!channel?.isTextBased?.() || !channel.messages?.fetch) {
    return fail('Sylo cannot find that channel.');
  }
  if (!canView(channel, member)) return fail('You cannot see that channel, so you cannot quote from it.');
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message)
    return fail('Sylo could not read that message. Is the link right, and can Sylo see the channel?');
  return { ok: true, message };
}

/**
 * May a quote be posted into this channel? Quotes from a public source may go anywhere; any other
 * only into the channel it was saved from (a quote of a staff channel must not turn up in a public one).
 */
export const quoteFitsChannel = (row, channelId) => row.public_source === 1 || row.channel_id === channelId;

/** Delete a quote. Its number stays used. */
export const removeQuote = async (row) => deleteQuote(row.id);

// --- showing ----------------------------------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One quote as an embed: the text, the author and the date, the attachment count and a jump link. */
export function buildQuoteEmbed(row, key) {
  const quoted = row.body
    ? row.body
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join('\n')
    : '*(no text)*';
  const tail = [`— **${row.author_name || 'Unknown'}**, <t:${Math.floor(row.message_at / 1000)}:D>`];
  if (row.attachments > 0) tail.push(`📎 ${plural(row.attachments, 'attachment')}`);
  tail.push(`[Jump to the message](${jumpUrl(key, row.channel_id, row.message_id)})`);
  const rest = tail.join('\n\n');
  // The "> " in front of every line can push 2000 one-letter lines past an embed's 4096.
  const room = DESCRIPTION_MAX - rest.length - 2;
  const shown = quoted.length > room ? `${cut(quoted, room - 1)}…` : quoted;
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setDescription(`${shown}\n\n${rest}`)
    .setFooter({ text: `Quote #${row.number}` });
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

/** A short line for a list: "#12 Name: the start of the text". */
export function quoteLine(row, max = 110) {
  const text = oneLine(row.body) || (row.attachments ? `📎 ${plural(row.attachments, 'attachment')}` : '');
  const shown = text.length > max ? `${cut(text, max - 1)}…` : text;
  return `**#${row.number}** ${row.author_name || 'Unknown'}: ${shown}`;
}

// --- the public page ---------------------------------------------------------------------------------

/**
 * A quote's text for the public page: no ids. Mentions, channels, custom emoji and message links
 * carry numeric ids, so they become words.
 */
export function publicText(text) {
  return String(text ?? '')
    .replace(/https?:\/\/[^\s/<>]+\/channels\/\d+\/\d+(?:\/\d+)?\S*/gi, '[message link]')
    .replace(/<@&\d+>/g, '@role')
    .replace(/<@!?\d+>/g, '@member')
    .replace(/<#\d+>/g, '#channel')
    .replace(/<a?:(\w{2,32}):\d+>/g, ':$1:')
    .replace(/<\/[^:>\s]+:\d+>/g, '/command')
    .replace(/<t:-?\d+(?::[a-zA-Z])?>/g, '')
    .replace(/\d{17,20}/g, '…');
}
