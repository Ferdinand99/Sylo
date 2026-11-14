// The permission and role-hierarchy health check as the dashboard shows it: the "Needs attention" items
// (one per module), the notes under a role or channel picker, and a module page's own list. Pure
// functions over the server's answer (GET /guilds/:id/health, or `attention.health` of the overview),
// so the wording is tested without rendering anything.
import { v2Href } from './moduleForms/index.js';

const hrefOf = (id, guildId) => v2Href({ id }, guildId);

const ROLE_REASON = {
  above: "move Sylo's role above it in the server's role settings",
  managed: 'it is managed by an integration, so pick another role',
};

/** The checks of the answer, or none (an older server, a failed call, a bot that is not in the server). */
export const checksOf = (health) => (Array.isArray(health?.checks) ? health.checks : []);

/** The checks that concern one module. */
export const moduleChecks = (health, moduleId) => checksOf(health).filter((c) => c.module === moduleId);

/** Why Sylo cannot give this role, as a sentence for a picker, or null when it can. */
export function roleWarning(health, roleId) {
  const roles = health?.targets?.roles;
  if (!roles || !roleId) return null;
  if (roles.blockedAll) return roles.blockedAll;
  const block = roles.blocked?.[roleId];
  return block && ROLE_REASON[block] ? `Sylo can't give this role: ${ROLE_REASON[block]}.` : null;
}

/** Why Sylo cannot post in this channel, as a sentence for a picker, or null when it can. */
export function channelWarning(health, channelId) {
  const missing = health?.targets?.channels?.blocked?.[channelId];
  if (!Array.isArray(missing) || !missing.length) return null;
  return `Sylo can't post in this channel: it is missing ${missing.join(', ')}.`;
}

/**
 * The notes for one picked role or channel, or for a list of them (a multi-select shows the name of each
 * one that fails, because the picker itself only shows chips).
 * @param {object|null} health
 * @param {'role'|'channel'} kind
 * @param {string|string[]} value  the picked id, or the picked ids
 * @param {Array<{ id: string, name: string }>} [items]  to name each failing id of a list
 * @returns {string[]}
 */
export function pickerWarnings(health, kind, value, items = []) {
  const warn = kind === 'channel' ? channelWarning : roleWarning;
  if (Array.isArray(value)) {
    return value.flatMap((id) => {
      const text = warn(health, id);
      if (!text) return [];
      const name = items.find((i) => String(i.id) === String(id))?.name;
      return [name ? `${kind === 'channel' ? '#' : ''}${name}: ${text}` : text];
    });
  }
  const text = value ? warn(health, value) : null;
  return text ? [text] : [];
}

/**
 * The "Needs attention" items of the health check, one per module, errors before warnings. The item's
 * `lines` are every problem of the module with what to do about it; `href` is the module's page.
 * @returns {Array<{ key: string, kind: 'health', severity: 'error'|'warning', moduleId: string, title: string, detail: string, href: string, lines: Array<{ message: string, fix: string, severity: string }> }>}
 */
export function healthItems(health, guildId) {
  const byModule = new Map();
  for (const c of checksOf(health)) {
    if (!byModule.has(c.module)) byModule.set(c.module, { name: c.moduleName ?? c.module, checks: [] });
    byModule.get(c.module).checks.push(c);
  }
  const items = [...byModule].map(([moduleId, { name, checks }]) => {
    const severity = checks.some((c) => c.severity === 'error') ? 'error' : 'warning';
    const n = checks.length;
    return {
      key: `health-${moduleId}`,
      kind: 'health',
      severity,
      moduleId,
      title: `${name}: Sylo can't do everything it needs`,
      detail: n === 1 ? checks[0].message : `${checks[0].message} And ${n - 1} more.`,
      href: hrefOf(moduleId, guildId),
      lines: checks.map((c) => ({ message: c.message, fix: c.fix, severity: c.severity })),
    };
  });
  return items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}
