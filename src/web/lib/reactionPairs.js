// Turns the role rows of a reaction-role form into the stored pairs, with the checks and
// error wording the dashboard shows.
import { parseEmoji, LIMITS } from '../../modules/roles.js';

const MAX_PAIRS = LIMITS['reactionMessages[].pairs'].maxItems;
const MAX_LABEL = LIMITS['reactionMessages[].pairs[].label'].maxLength;

const BUTTON_STYLES = ['primary', 'secondary', 'success', 'danger'];

/**
 * @param {{ roleId?: string, emoji?: string, label?: string, btnStyle?: string }[]} rows
 * @param {'reaction'|'buttons'|'select'} style
 * @param {import('discord.js').Guild} guild
 * @returns {{ pairs: object[], errors: string[] }}
 */
export function buildReactionPairs(rows, style, guild) {
  const errors = [];
  if (rows.length > MAX_PAIRS) errors.push(`Use at most ${MAX_PAIRS} roles per message.`);

  const pairs = [];
  let hadRowError = false;
  rows.forEach((row, i) => {
    const rid = row.roleId;
    // A fully blank trailing row (the default empty one, or one added and
    // never filled in) is ignored, not an error.
    if (!rid && !row.emoji && !row.label) return;
    if (!/^\d{17,20}$/.test(rid ?? '')) {
      errors.push(`Row ${i + 1}: select a role.`);
      hadRowError = true;
      return;
    }
    const parsed = parseEmoji(row.emoji ?? '', guild);
    // The reaction style needs a usable emoji; button / select styles don't.
    if (style === 'reaction' && !parsed) {
      errors.push(`Row ${i + 1}: enter a valid emoji (required for the Reactions style).`);
      hadRowError = true;
      return;
    }
    pairs.push({
      ...(parsed || { key: '', display: '', react: '' }),
      roleId: rid,
      label: String(row.label ?? '').slice(0, MAX_LABEL),
      btnStyle: BUTTON_STYLES.includes(row.btnStyle) ? row.btnStyle : 'secondary',
    });
  });
  if (pairs.length === 0 && !hadRowError) errors.push('Add at least one role.');
  return { pairs, errors };
}
