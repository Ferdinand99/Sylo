// The pure part of the bridge: turning one platform's message into text and attachments the other
// platform can show, with every ping made harmless on the way. Nothing here touches a platform, the
// database or the network, so the safety rules (no ping crosses, nothing breaks the other side's limits)
// are tested directly in test/bridgeText.test.js.
//
// Mentions: the relay posts with allowedMentions set to none, so nothing is pinged whatever the text says.
// This module also changes the text, so a person reads "@Alice" and "@moderators" on the other side
// instead of a raw id that means nothing there, and "@everyone" can never be turned into a ping by a
// later change to how the copy is sent.
import { createHash } from 'node:crypto';

/** What is left of the message limit of the platforms: Discord and Fluxer both allow 2000 characters. */
export const MESSAGE_LIMIT = 2000;
/** The most embeds one message carries, and the most files. */
export const EMBED_LIMIT = 10;
export const FILE_COUNT_LIMIT = 10;
/** A file is re-uploaded only up to this size, and only this much per message; bigger ones become a link. */
export const FILE_BYTES_LIMIT = 8 * 1024 * 1024;
export const TOTAL_BYTES_LIMIT = 8 * 1024 * 1024;

/** U+200B, the zero-width space: invisible, and enough to break a mention. */
export const ZWSP = String.fromCharCode(0x200b);

/** What each side of a link shares about itself. `bots` and `joinMessages` are off until a server asks. */
export const DEFAULT_OPTIONS = Object.freeze({ bots: false, joinMessages: false, uploadFiles: true });

/** The options of one side as stored or submitted, always the full shape with booleans. */
export function normaliseOptions(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    bots: o.bots === true,
    joinMessages: o.joinMessages === true,
    uploadFiles: o.uploadFiles === undefined ? DEFAULT_OPTIONS.uploadFiles : o.uploadFiles === true,
  };
}

/** A short stable hash of what was sent, so an edit event that changed nothing visible is skipped. */
export const hashContent = (text) =>
  createHash('sha256')
    .update(String(text ?? ''))
    .digest('hex')
    .slice(0, 24);

// --- text helpers ------------------------------------------------------------------------------------

/** Cut to `max` UTF-16 units without a half emoji at the end, ending in "…". */
export function clip(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  let out = text.slice(0, Math.max(0, max - 1));
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return `${out}…`;
}

/**
 * Control characters and invisible format characters (direction overrides and the like) out of a display
 * name or a quote. The zero-width joiner stays, because emoji sequences need it, and so does the
 * zero-width space: it is what keeps a mention broken once neutraliseMentions has put it there.
 */
const ZWJ = String.fromCharCode(0x200d);
const stripControl = (text) =>
  String(text ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === ZWJ || c === ZWSP ? c : ''))
    .trim();

/** A name that shows an @ but cannot ping: the zero-width space after the @ breaks the mention. */
export const inertAt = (text) => String(text ?? '').replace(/@/g, `@${ZWSP}`);

/**
 * Markdown out of a name that Sylo puts into its own text (a server, a channel, a member in a notice or a
 * quote): a name like "x](https://evil.example)[y" must not turn into a link under Sylo's identity.
 */
export const escapeMarkdown = (text) => String(text ?? '').replace(/([\\*_~`|[\]()>#<])/g, '\\$1');

/**
 * Replace the mentions in a message with plain text and break @everyone / @here. `names` looks up what
 * the other side should read for a user, a role or a channel; it may return nothing (then a neutral word).
 * @param {string} text
 * @param {{ user?: (id: string) => string | undefined, role?: (id: string) => string | undefined,
 *   channel?: (id: string) => string | undefined }} [names]
 */
export function neutraliseMentions(text, names = {}) {
  return String(text ?? '')
    .replace(/<@!?(\d{5,25})>/g, (_, id) => inertAt(`@${stripControl(names.user?.(id)) || 'user'}`))
    .replace(/<@&(\d{5,25})>/g, (_, id) => inertAt(`@${stripControl(names.role?.(id)) || 'role'}`))
    .replace(/<#(\d{5,25})>/g, (_, id) => `#${stripControl(names.channel?.(id)) || 'channel'}`)
    .replace(/<\/([^:>\s]{1,32}(?: [^:>\s]{1,32}){0,2}):\d{5,25}>/g, (_, name) => `/${name}`)
    .replace(/@(everyone|here)\b/gi, (_, word) => `@${ZWSP}${word}`);
}

/**
 * Custom emoji: the same name in the other server when it has one, otherwise ":name:". Unicode emoji
 * are plain text and cross as they are.
 * @param {string} text
 * @param {(name: string) => { id: string, name: string, animated?: boolean } | undefined} find
 */
export function mapEmoji(text, find) {
  return String(text ?? '').replace(/<(a?):([\w]{2,32}):(\d{5,25})>/g, (_, anim, name) => {
    const match = find?.(name);
    if (match?.id) return `<${match.animated ? 'a' : ''}:${match.name ?? name}:${match.id}>`;
    return `:${name}:`;
  });
}

/** `<t:1700000000:R>` is a Discord timestamp: the other platform may not render it, so say it in UTC. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
export function plainTimestamps(text) {
  return String(text ?? '').replace(/<t:(\d{1,13})(?::[a-zA-Z])?>/g, (_, seconds) => {
    const d = new Date(Number(seconds) * 1000);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  });
}

// --- the name and the picture of the sender ----------------------------------------------------------

export const PLATFORM_TAG = Object.freeze({ discord: 'Discord', fluxer: 'Fluxer' });

// Discord refuses a webhook name that contains these words, so a name from the other platform that has
// one gets a zero-width space inside it.
const FORBIDDEN_NAME = /(clyde|discord)/gi;

/**
 * The name a relayed message is posted under: the author's display name and where they are, so the
 * conversation says who is on the other platform ("Alice [Fluxer]"). At most 80 characters, never empty.
 */
export function senderName(displayName, platform, { forDiscord = false } = {}) {
  const tag = ` [${PLATFORM_TAG[platform] ?? platform}]`;
  let name = inertAt(stripControl(displayName)).replace(/\s+/g, ' ');
  if (forDiscord) name = name.replace(FORBIDDEN_NAME, (w) => `${w[0]}${ZWSP}${w.slice(1)}`);
  name = clip(name, 80 - tag.length);
  if (!name || name === ZWSP) name = 'Someone';
  return `${name}${tag}`;
}

// --- replies -----------------------------------------------------------------------------------------

/** The first line of a copy that answers another message: who, a short quote, and a link when it is mapped. */
export function replyHead({ name, snippet, url }) {
  const who = escapeMarkdown(inertAt(clip(stripControl(name) || 'someone', 40)));
  const text = clip(stripControl(String(snippet ?? '').replace(/\s+/g, ' ')).replace(/^>+\s*/, ''), 100);
  const label = url ? `[**${who}**](<${url}>)` : `**${who}**`;
  return text ? `> ↪ ${label}: ${text}` : `> ↪ ${label}`;
}

// --- stickers, polls, files --------------------------------------------------------------------------

/** One line per sticker: the name and its picture link, which both platforms show as an image. */
export function stickerLines(stickers) {
  return [...(stickers ?? [])]
    .filter((s) => s && (s.url || s.name))
    .slice(0, 3)
    .map((s) =>
      s.url
        ? `*sticker: ${clip(stripControl(s.name) || 'sticker', 40)}* ${s.url}`
        : `*sticker: ${clip(s.name, 40)}*`
    );
}

/**
 * A poll as text: Fluxer has no polls, and a bridge cannot make a vote on one side count on the other,
 * so the question and the answers are shown and the vote stays where the poll is.
 * @param {{ question?: string, answers?: Array<string | { text?: string, emoji?: string }>, multiselect?: boolean }} poll
 */
export function pollText(poll) {
  if (!poll) return '';
  const answers = [...(poll.answers ?? [])]
    .map((a) => (typeof a === 'string' ? { text: a } : a))
    .filter((a) => a?.text)
    .slice(0, 10);
  const lines = [`📊 **Poll:** ${clip(stripControl(poll.question) || 'Poll', 300)}`];
  for (const a of answers) lines.push(`• ${a.emoji ? `${a.emoji} ` : ''}${clip(stripControl(a.text), 100)}`);
  lines.push('*Vote on the original server: polls do not cross the bridge.*');
  return lines.join('\n');
}

/**
 * Decide which attachments are re-uploaded and which become a link. A file is uploaded when uploading is
 * on, it is not larger than the per-file limit, and the message stays within the count and total limits;
 * everything else is a link line.
 * @param {Array<{ name: string, url: string, size?: number }>} attachments
 * @param {{ upload?: boolean, perFile?: number, total?: number, count?: number }} [limits]
 */
export function planAttachments(
  attachments,
  { upload = true, perFile = FILE_BYTES_LIMIT, total = TOTAL_BYTES_LIMIT, count = FILE_COUNT_LIMIT } = {}
) {
  const toUpload = [];
  const links = [];
  let used = 0;
  for (const a of attachments ?? []) {
    if (!a?.url) continue;
    const size = Number(a.size);
    const fits =
      upload &&
      Number.isFinite(size) &&
      size > 0 &&
      size <= perFile &&
      used + size <= total &&
      toUpload.length < count;
    if (fits) {
      toUpload.push(a);
      used += size;
    } else {
      links.push(a);
    }
  }
  return { upload: toUpload, links };
}

/** The link lines for attachments that were not uploaded. */
export const fileLinkLines = (links) =>
  links.slice(0, 10).map((a) => `📎 ${clip(stripControl(a.name) || 'file', 60)}: ${a.url}`);

// --- embeds ------------------------------------------------------------------------------------------

/**
 * A rich embed from either SDK as the plain API shape both accept, with its text neutralised. Embeds that
 * are only a link preview are left out: the other platform makes its own preview of the link.
 * @param {any} embed  a discord.js Embed or a Fluxer MessageEmbed
 * @param {(text: string) => string} text  what to do to every piece of text (mentions, emoji)
 */
export function plainEmbed(embed, text = (t) => t) {
  const e = embed?.toJSON?.() ?? embed;
  if (!e) return null;
  const type = e.type ?? 'rich';
  if (type !== 'rich') return null;
  const pick = (v) => (typeof v === 'string' && v ? v : undefined);
  const clean = (o) => (o ? Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) : o);
  const url = (v) => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v : undefined);
  const out = {
    title: pick(text(clip(e.title ?? '', 256))),
    description: pick(text(clip(e.description ?? '', 4000))),
    url: url(e.url),
    color: Number.isFinite(e.color) ? e.color : undefined,
    timestamp: pick(
      typeof e.timestamp === 'string'
        ? e.timestamp
        : e.timestamp instanceof Date
          ? e.timestamp.toISOString()
          : undefined
    ),
    footer: e.footer?.text
      ? clean({
          text: text(clip(e.footer.text, 2048)),
          icon_url: url(e.footer.icon_url ?? e.footer.iconURL ?? e.footer.iconUrl),
        })
      : undefined,
    image: url(e.image?.url) ? { url: e.image.url } : undefined,
    thumbnail: url(e.thumbnail?.url) ? { url: e.thumbnail.url } : undefined,
    author: e.author?.name
      ? clean({
          name: text(clip(e.author.name, 256)),
          url: url(e.author.url),
          icon_url: url(e.author.icon_url ?? e.author.iconURL ?? e.author.iconUrl),
        })
      : undefined,
    fields: Array.isArray(e.fields)
      ? e.fields
          .filter((f) => f?.name && f?.value)
          .slice(0, 25)
          .map((f) => ({
            name: text(clip(f.name, 256)),
            value: text(clip(f.value, 1024)),
            inline: f.inline === true,
          }))
      : undefined,
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return Object.keys(out).length ? out : null;
}

/** The embeds of a message as plain API objects, at most ten, link previews left out. */
export function plainEmbeds(embeds, text) {
  return [...(embeds ?? [])]
    .map((e) => plainEmbed(e, text))
    .filter(Boolean)
    .slice(0, EMBED_LIMIT);
}

/** Joins the parts of a copy with a blank-free line break and keeps the whole within the message limit. */
export function joinParts(parts, limit = MESSAGE_LIMIT) {
  return clip(
    parts
      .map((p) => String(p ?? '').trim())
      .filter(Boolean)
      .join('\n'),
    limit
  );
}
