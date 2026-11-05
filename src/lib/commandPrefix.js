// The rules for a Fluxer chat-command prefix, shared by the COMMAND_PREFIX setting
// (src/config.js) and the per-server prefix (the dashboard's Settings page).

export const COMMAND_PREFIX_MAX = 5;

/**
 * Why a value can't be a command prefix, or null when it can: 1 to 5 characters, none of
 * them whitespace or a control character. Any other character is allowed, including `@`
 * and `/`: a mention (`<@id> ping`) is recognised before the prefix, so it keeps working.
 * @param {unknown} value
 * @returns {string | null}
 */
export function commandPrefixError(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > COMMAND_PREFIX_MAX) {
    return `The command prefix must be 1 to ${COMMAND_PREFIX_MAX} characters.`;
  }
  if (/[\s\p{C}]/u.test(value)) return 'The command prefix can not contain spaces.';
  return null;
}
