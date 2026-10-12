// Turns a discord.js-style message payload into one the Fluxer SDK accepts.
//
// The SDK's send body only copies the keys it knows, so unknown ones
// (`components`) vanish silently, but two things do break: a discord.js
// AttachmentBuilder is not its own AttachmentBuilder and throws, and the
// interaction-only keys (`ephemeral`, `flags`, `withResponse`) mean nothing to
// it. Everything else — content, embeds, allowedMentions — is already the same
// shape on both platforms, so it passes through unchanged.
import { MessageFlags } from 'discord.js';

const DISCORD_ONLY_KEYS = ['ephemeral', 'flags', 'withResponse', 'fetchReply', 'components'];

function toFile(file) {
  if (!file || typeof file !== 'object') return file;
  const source = file.attachment ?? null;
  if (source == null) return file; // already { name, data } / { name, url }
  const name = file.name ?? file.filename;
  if (typeof source === 'string') return { name, url: source };
  return { name, data: source };
}

// Discord renders <t:unix:style> everywhere, Fluxer only in markdown text (a description, a
// field value), not in a footer, title, author or field name, where it shows raw. Those
// get a fixed UTC rendering instead.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

function plainTimestamp(seconds, style) {
  const d = new Date(Number(seconds) * 1000);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (style === 't') return `${time} UTC`;
  if (style === 'T') return `${time}:${pad(d.getUTCSeconds())} UTC`;
  if (style === 'd' || style === 'D') return date;
  return `${date}, ${time} UTC`;
}

const plainTimestamps = (text) =>
  typeof text === 'string'
    ? text.replace(/<t:(\d+)(?::([a-zA-Z]))?>/g, (_, s, style) => plainTimestamp(s, style))
    : text;

function plainEmbedTimestamps(embed) {
  const e = { ...embed };
  if (e.title) e.title = plainTimestamps(e.title);
  if (e.author?.name) e.author = { ...e.author, name: plainTimestamps(e.author.name) };
  if (e.footer?.text) e.footer = { ...e.footer, text: plainTimestamps(e.footer.text) };
  if (e.fields) e.fields = e.fields.map((f) => ({ ...f, name: plainTimestamps(f.name) }));
  return e;
}

/**
 * @param {string | object} input
 * @param {{ edit?: boolean }} [opts]
 * @returns {{ payload: object, ephemeral: boolean, wantsResponse: boolean }}
 */
export function toFluxerPayload(input, { edit = false } = {}) {
  const payload = typeof input === 'string' ? { content: input } : { ...input };
  const flags = typeof payload.flags === 'number' ? payload.flags : 0;
  const ephemeral = Boolean(payload.ephemeral) || (flags & MessageFlags.Ephemeral) === MessageFlags.Ephemeral;
  const wantsResponse = Boolean(payload.withResponse);
  for (const key of DISCORD_ONLY_KEYS) delete payload[key];
  if (payload.content === '' && !edit) delete payload.content; // an edit may use '' to clear the text
  if (payload.embeds)
    payload.embeds = payload.embeds.map((e) =>
      plainEmbedTimestamps(typeof e?.toJSON === 'function' ? e.toJSON() : e)
    );
  if (payload.files) payload.files = payload.files.map(toFile);
  return { payload, ephemeral, wantsResponse };
}
