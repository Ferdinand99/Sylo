// The most bridged channels a server can have, set by the operator with BRIDGE_MAX_LINKS (src/config.js).
//
// The real limits are the platforms' webhook limits and the relay queue, not this number: Sylo makes one
// webhook per bridged channel (Discord and Fluxer both allow 15 per channel, Fluxer 1000 per server), and the
// relay spaces the sends of each webhook inside what the platform allows (src/modules/lib/bridgeQueue.js).
// A server mirror links every copied text channel, so the default has to be well above a typical server.

export const BRIDGE_MAX_LINKS_DEFAULT = 100;
export const BRIDGE_MAX_LINKS_MIN = 1;
export const BRIDGE_MAX_LINKS_MAX = 500;

/**
 * Read BRIDGE_MAX_LINKS. Unset or blank gives the default.
 * @param {string | undefined | null} raw
 * @returns {{ value: number, error: null } | { value: null, error: string }}
 */
export function parseBridgeMaxLinks(raw) {
  const text = raw == null ? '' : String(raw).trim();
  if (text === '') return { value: BRIDGE_MAX_LINKS_DEFAULT, error: null };
  const n = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(n) || n < BRIDGE_MAX_LINKS_MIN || n > BRIDGE_MAX_LINKS_MAX) {
    return {
      value: null,
      error: `BRIDGE_MAX_LINKS must be a whole number from ${BRIDGE_MAX_LINKS_MIN} to ${BRIDGE_MAX_LINKS_MAX} (default ${BRIDGE_MAX_LINKS_DEFAULT}).`,
    };
  }
  return { value: n, error: null };
}
