// Slash commands are written into the dashboard's help text as `/name`. On a platform
// without slash commands they run from chat with a prefix (`!name`), so those references
// are rewritten for that platform. Discord text is never touched.

/** @param {'discord' | 'fluxer'} platform */
export function commandText(platform, text, prefix) {
  if (platform === 'discord') return text;
  return text.replace(/^\/(?=[a-z])/, prefix);
}

/**
 * Rewrite `<code>/name …</code>` references in rendered HTML to `<code>{prefix}name …</code>`
 * when `name` is a real command (or a `voice-*` style family). A path such as
 * `<code>/leaderboard/123</code>` and placeholders like `<code>/slash</code>` stay as they are.
 * @param {string} html
 * @param {{ prefix: string, names: Set<string> | Iterable<string> }} opts
 */
export function rewriteSlashCommands(html, { prefix, names }) {
  const known = names instanceof Set ? names : new Set(names);
  const family = (name) => [...known].some((n) => n.startsWith(name));
  return html.replace(/<code>\/([a-z][a-z0-9-]*)(?![\w/])(\*?)/g, (match, name, star) => {
    if (!(known.has(name) || (star && name.endsWith('-') && family(name)))) return match;
    return `<code>${prefix}${name}${star}`;
  });
}
