// The difference between two saved settings, for the change history (pages/AuditLog.jsx) and anything else
// that shows "what changes" (an import preview can use it too). Pure functions: no React, no network.
//
// `diffSettings(before, after)` takes the two sides of a stored change (only the settings that changed, a
// missing key meaning "did not exist") and returns the rows to show, changed fields only:
//   { path: ['rules', 'Welcome', 'channelId'], kind: 'changed', before, after }
//   { path: ['rules', 'Rules'], kind: 'added', after }            (an item of a list, or a setting)
//   { path: ['ignoreRoles'], kind: 'list', added: [...], removed: [...] }   (a list of plain values)
//   { path: ['feeds'], kind: 'hidden' }   (something changed that the history does not show: a secret)

/** What the server stores in place of a secret. */
export const MASK = '••••••';

/** How many rows a diff shows before it says "and n more". */
export const MAX_ROWS = 60;

// Readable names for settings, used where a key is known. A setting not listed here shows its own key.
const LABELS = {
  enabled: 'Enabled',
  channel: 'Channel',
  channelId: 'Channel',
  channels: 'Channels',
  roleId: 'Role',
  roles: 'Roles',
  message: 'Message',
  messages: 'Messages',
  title: 'Title',
  name: 'Name',
  description: 'Description',
  content: 'Message text',
  color: 'Colour',
  logChannel: 'Log channel',
  logChannelId: 'Log channel',
  logMode: 'Log mode',
  reviewChannelId: 'Review channel',
  notifyChannel: 'Notification channel',
  joinLogChannelId: 'Join log channel',
  promptText: 'Prompt text',
  cooldownSeconds: 'Cooldown (seconds)',
  cooldownDays: 'Cooldown (days)',
  graceHours: 'Grace period (hours)',
  timeoutMinutes: 'Timeout (minutes)',
  kickAfterMinutes: 'Kick after (minutes)',
  refreshMinutes: 'Refresh every (minutes)',
  staffRoles: 'Staff roles',
  exemptRoles: 'Exempt roles',
  exemptChannels: 'Exempt channels',
  ignoreChannels: 'Ignored channels',
  ignoreRoles: 'Ignored roles',
  greeting: 'Greeting',
  closeMessage: 'Close message',
  verifiedRoleId: 'Verified role',
  mode: 'Mode',
  rules: 'Rules',
  rewards: 'Rewards',
  boards: 'Boards',
  feeds: 'Feeds',
  alerts: 'Alerts',
  hubs: 'Hubs',
  stickies: 'Sticky messages',
  responders: 'Responders',
  questions: 'Questions',
  events: 'Events',
  trigger: 'Welcome trigger',
  triggerRoleIds: 'Trigger roles',
  joinEnabled: 'Welcome on join',
  joinChannel: 'Welcome channel',
  joinMessage: 'Welcome message',
  leaveEnabled: 'Goodbye message',
  leaveChannel: 'Goodbye channel',
  leaveMessage: 'Goodbye text',
  dmEnabled: 'Welcome by DM',
  dmMessage: 'DM text',
  useEmbed: 'Use an embed',
  card: 'Welcome card',
  cardBackground: 'Card background',
  autoroleEnabled: 'Give auto-roles',
  dmOnPunish: 'Tell members by DM',
  warnThresholds: 'Warning thresholds',
  infractionRetentionDays: 'Keep cases (days)',
  publicPage: 'Public page',
  publicLeaderboard: 'Public leaderboard',
  modlogChannelId: 'Mod-log channel',
  embedColor: 'Embed colour',
  botMasterRoleIds: 'Bot master roles',
  commandPrefix: 'Command prefix',
};

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The readable name of a setting: the known label, or the key itself. */
export const labelFor = (key) => LABELS[key] ?? key;

// How an item of a list is called in a path: its name, or "item 3".
function itemName(item, index) {
  if (isPlain(item)) {
    for (const k of ['name', 'title', 'label', 'trigger', 'id']) {
      if (typeof item[k] === 'string' && item[k] !== '') return item[k].slice(0, 40);
      if (typeof item[k] === 'number') return String(item[k]);
    }
  }
  return `item ${index + 1}`;
}

const hasIds = (list) =>
  list.length > 0 &&
  list.every((x) => isPlain(x) && (typeof x.id === 'string' || typeof x.id === 'number') && x.id !== '');

function walk(path, b, a, out) {
  if (b === undefined && a === undefined) return;
  if (b === undefined) return void out.push({ path, kind: 'added', after: a });
  if (a === undefined) return void out.push({ path, kind: 'removed', before: b });
  if (same(b, a)) return;

  if (Array.isArray(b) && Array.isArray(a)) {
    if ([...b, ...a].every(isScalar)) {
      const removed = b.filter((x) => !a.includes(x));
      const added = a.filter((x) => !b.includes(x));
      if (removed.length || added.length) out.push({ path, kind: 'list', added, removed });
      else out.push({ path, kind: 'changed', before: b, after: a }); // the same items in another order
      return;
    }
    if (hasIds(b) && hasIds(a)) {
      const was = new Map(b.map((x) => [String(x.id), x]));
      const now = new Map(a.map((x) => [String(x.id), x]));
      a.forEach((item, i) => {
        const old = was.get(String(item.id));
        const at = [...path, itemName(item, i)];
        if (!old) out.push({ path: at, kind: 'added', after: item });
        else walk(at, old, item, out);
      });
      b.forEach((item, i) => {
        if (!now.has(String(item.id))) {
          out.push({ path: [...path, itemName(item, i)], kind: 'removed', before: item });
        }
      });
      return;
    }
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      walk([...path, `#${i + 1}`], b[i], a[i], out);
    }
    return;
  }

  if (isPlain(b) && isPlain(a)) {
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      walk([...path, key], b[key], a[key], out);
    }
    return;
  }
  out.push({ path, kind: 'changed', before: b, after: a });
}

/**
 * The rows that differ between the two sides of a stored change.
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @returns {{ rows: object[], more: number }} `more` is how many rows were left out (over MAX_ROWS)
 */
export function diffSettings(before = {}, after = {}) {
  const rows = [];
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const found = [];
    walk([key], before?.[key], after?.[key], found);
    if (found.length) rows.push(...found);
    else rows.push({ path: [key], kind: 'hidden' });
  }
  return { rows: rows.slice(0, MAX_ROWS), more: Math.max(0, rows.length - MAX_ROWS) };
}

/** A row's path as one line: readable names joined with " › ". */
export function pathText(path) {
  return path.map(labelFor).join(' › ');
}

const MAX_TEXT = 200;

/**
 * A value as text. `names` maps channel and role ids to "#general" / "@Moderators".
 * @param {unknown} v
 * @param {Record<string, string>} [names]
 */
export function formatValue(v, names = {}) {
  if (v === undefined) return '(not set)';
  if (v === null || v === '') return '(empty)';
  if (v === MASK) return `${MASK} (hidden)`;
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (names[v]) return names[v];
    return v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v;
  }
  if (Array.isArray(v)) {
    if (!v.length) return '(empty list)';
    const shown = v.slice(0, 6).map((x) => formatValue(x, names));
    return v.length > 6 ? `${shown.join(', ')} and ${v.length - 6} more` : shown.join(', ');
  }
  const text = JSON.stringify(v);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}
