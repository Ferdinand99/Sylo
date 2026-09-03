// The `posted_keys.value` for a live "went live" alert packs three fields so the
// module can find (and clean up) the message it posted once the stream ends:
//
//   "<streamRef>|<channelId>|<messageId>"
//
// `streamRef` is the platform's per-broadcast id (Twitch stream id, YouTube
// video id, Kick start_time…). Pre-3.19 rows are just the bare ref with no `|`,
// so decode() still returns it correctly.

export const ON_END_MODES = ['delete', 'edit', 'keep'];

/** Clamp a user-supplied value to a valid onEnd mode (default: delete). */
export function normaliseOnEnd(value) {
  return ON_END_MODES.includes(value) ? value : 'delete';
}

/** @returns {string} the packed `posted_keys.value` */
export function encodeLiveValue(streamRef, channelId, messageId) {
  return [String(streamRef ?? ''), channelId || '', messageId || ''].join('|');
}

/** @returns {{ ref: string, channelId: string|null, messageId: string|null }} */
export function decodeLiveValue(value) {
  const [ref = '', channelId = '', messageId = ''] = String(value ?? '').split('|');
  return { ref, channelId: channelId || null, messageId: messageId || null };
}
