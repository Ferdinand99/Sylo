// The rules for a Fluxer chat-command prefix, shared by the COMMAND_PREFIX setting
// (src/config.js) and the per-server prefix (the dashboard's Settings page).

export const COMMAND_PREFIX_MAX = 5;

/**
 * Why a value can't be a command prefix, or null when it can: 1 to 5 characters (counted as
 * UTF-16 units, so an emoji counts as two), none of them whitespace, a backtick (help and usage
 * texts wrap the prefix in a code span) or an invisible / control character. Any other
 * character is allowed, including `@` and `/`: a mention (`<@id> ping`) is recognised before
 * the prefix, so it keeps working. A prefix is case-sensitive; the command name after it is not.
 * @param {unknown} value
 * @returns {string | null}
 */
export function commandPrefixError(value) {
  if (typeof value !== 'string' || value.length < 1) {
    return `The command prefix must be 1 to ${COMMAND_PREFIX_MAX} characters long.`;
  }
  if (/\s/.test(value)) return 'The command prefix can not contain spaces.';
  if (value.includes('`')) return 'The command prefix can not contain a backtick (`).';
  // Control, format (zero-width joiner, bidi marks), private-use, unassigned and lone surrogates.
  if (/\p{C}/u.test(value)) return 'The command prefix can not contain invisible or control characters.';
  if (value.length > COMMAND_PREFIX_MAX) {
    return `The command prefix must be 1 to ${COMMAND_PREFIX_MAX} characters long. Emoji and some symbols count as two.`;
  }
  return null;
}
