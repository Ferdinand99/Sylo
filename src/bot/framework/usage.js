// One-line usage hints for a prefix command, built from its schema — shown
// when the arguments don't parse. Required options are <angle>, optional [square].
import { ApplicationCommandOptionType as T } from 'discord.js';

const args = (options) =>
  (options ?? [])
    .filter((o) => o.type !== T.Subcommand)
    .map((o) => (o.required ? `<${o.name}>` : `[${o.name}]`));

/**
 * @param {string} prefix
 * @param {{ name: string, options?: any[] }} schema  a command's `data.toJSON()`
 * @returns {string[]}  one line per subcommand, or a single line
 */
export function usageLines(prefix, schema) {
  const base = `${prefix}${schema.name}`;
  const subs = (schema.options ?? []).filter((o) => o.type === T.Subcommand);
  if (!subs.length) return [[base, ...args(schema.options)].join(' ')];
  return subs.map((s) => [base, s.name, ...args(s.options)].join(' '));
}
