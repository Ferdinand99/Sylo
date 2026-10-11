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

/**
 * @param {string | object} input
 * @returns {{ payload: object, ephemeral: boolean, wantsResponse: boolean }}
 */
export function toFluxerPayload(input) {
  const payload = typeof input === 'string' ? { content: input } : { ...input };
  const flags = typeof payload.flags === 'number' ? payload.flags : 0;
  const ephemeral = Boolean(payload.ephemeral) || (flags & MessageFlags.Ephemeral) === MessageFlags.Ephemeral;
  const wantsResponse = Boolean(payload.withResponse);
  for (const key of DISCORD_ONLY_KEYS) delete payload[key];
  if (payload.content === '') delete payload.content;
  if (payload.embeds)
    payload.embeds = payload.embeds.map((e) => (typeof e?.toJSON === 'function' ? e.toJSON() : e));
  if (payload.files) payload.files = payload.files.map(toFile);
  return { payload, ephemeral, wantsResponse };
}
