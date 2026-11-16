// What the Mirror to Fluxer page says about a mirror (pages/Mirror.jsx), kept apart from the markup so the
// wording and the decisions can be tested: the state of a pair in words, which steps of the wizard are done, how
// far a copy is, and how the preview is summed up.

/** The pair states the server uses (src/db/mirror.js), in plain words and with the tone of their pill. */
export const STATUS = {
  pending: { label: 'Waiting for the Fluxer server', tone: 'warning' },
  ready: { label: 'Agreed, not copied yet', tone: 'neutral' },
  copying: { label: 'Copying', tone: 'success' },
  live: { label: 'Mirroring', tone: 'success' },
  done: { label: 'Copied', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  stopped: { label: 'Stopped', tone: 'neutral' },
};

export const statusOf = (status) => STATUS[status] ?? { label: status ?? 'Unknown', tone: 'neutral' };

/** The wizard's steps on the Discord side, and which one a pair is at. */
export const STEPS = [
  ['ask', 'Ask'],
  ['agree', 'Agree'],
  ['preview', 'Preview'],
  ['copy', 'Copy'],
];

export function stepOf(pair) {
  if (!pair) return 'ask';
  if (pair.status === 'pending') return 'agree';
  if (pair.status === 'ready') return 'preview';
  return 'copy';
}

/** Is a copy or a sync running, so the page should keep asking for progress? */
export const isBusy = (pair, progress) =>
  pair?.status === 'copying' || (pair?.status === 'live' && (progress?.waitingChanges ?? 0) > 0);

const KIND = {
  guild: ['the server name, icon and banner', 'the server name, icon and banner'],
  role: ['role', 'roles'],
  channel: ['channel', 'channels'],
  emoji: ['emoji', 'emoji'],
  sticker: ['sticker', 'stickers'],
  module: ['module setup', 'module setups'],
};

/** Singular or plural by count: plural(3, 'role', 'roles') is "3 roles". */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The preview's summary as one line per kind: "Create 5 channels, update 1, skip 2". */
export function summaryLines(summary) {
  const lines = [];
  for (const [kind, names] of Object.entries(KIND)) {
    const s = summary?.[kind];
    if (!s) continue;
    const parts = [];
    if (s.create) parts.push(`create ${count(s.create, names[0], names[1])}`);
    if (s.update)
      parts.push(s.create ? `update ${s.update}` : `update ${count(s.update, names[0], names[1])}`);
    if (s.skip) parts.push(`skip ${s.skip}`);
    if (s.unchanged) parts.push(`${s.unchanged} already match`);
    if (parts.length) lines.push({ kind, text: parts.join(', ').replace(/^./, (c) => c.toUpperCase()) });
  }
  return lines;
}

/** Notes grouped by what they are about, so a long list reads as a few sections. */
export function groupNotes(notes) {
  const groups = new Map();
  for (const n of notes ?? []) {
    if (!groups.has(n.scope)) groups.set(n.scope, []);
    groups.get(n.scope).push(n);
  }
  const order = ['role', 'channel', 'emoji', 'sticker', 'module', 'guild'];
  return [...groups]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([scope, items]) => ({ scope, title: SCOPE_TITLE[scope] ?? scope, items }));
}

const SCOPE_TITLE = {
  role: 'Roles',
  channel: 'Channels and permissions',
  emoji: 'Emoji',
  sticker: 'Stickers',
  module: "Sylo's settings",
  guild: 'The server itself',
};

/** The progress line under the bar: "12 of 40 steps done, 1 failed". */
export function progressText(progress) {
  if (!progress || progress.total === 0) return 'Nothing queued.';
  const finished = progress.total - progress.waiting;
  const parts = [`${finished} of ${progress.total} steps done`];
  if (progress.failed) parts.push(`${progress.failed} failed`);
  if (progress.skipped) parts.push(`${progress.skipped} skipped`);
  return parts.join(', ');
}

/** What the options are called on the page, in order. `copy` ones can still change after a copy. */
export const OPTION_ROWS = [
  ['name', 'Server name'],
  ['icon', 'Server icon'],
  ['banner', 'Server banner'],
  ['roles', 'Roles'],
  ['channels', 'Channels and categories'],
  ['emoji', 'Emoji'],
  ['stickers', 'Stickers'],
  ['modules', "Sylo's own settings (welcome, tickets, moderation and the rest)"],
  ['continuous', 'Keep the Fluxer server in step afterwards'],
  ['mirrorDeletes', 'Delete on Fluxer what is deleted on Discord'],
];

/** The deletions that wait, as a short text for a confirmation: "lock channel #chat, delete role Mod, and 3 more". */
export function deleteSummary(items = [], count = items.length) {
  const verb = { lock: 'lock', delete: 'delete' };
  const shown = items.slice(0, 10).map((i) => `${verb[i.action] ?? i.action} ${i.kind} ${i.name}`);
  const more = count - shown.length;
  return shown.join(', ') + (more > 0 ? `, and ${more} more` : '');
}

/** What sits under an option row, when it needs a word of warning. */
export const OPTION_HINTS = {
  mirrorDeletes:
    'Off (the default): a channel or role deleted on Discord stays on Fluxer, locked and marked as removed, and its messages are kept. On: it is deleted on Fluxer too, with all its messages. Only what Sylo made is ever deleted. Turning it on only asks: the owner of the Fluxer server has to allow it in their dashboard.',
};

/** May this side resume a paused mirror? Only the side whose owner paused it can; a pause Sylo made is open to both. */
export const canResume = (pair) =>
  !pair.pausedBy || pair.pausedBy === 'system' || pair.pausedBy === pair.side;

/** Time left of a code, as "42 minutes", or null once it has run out. */
export function codeLeft(expiresAt, now = Date.now()) {
  const ms = expiresAt - now;
  if (!(ms > 0)) return null;
  const minutes = Math.ceil(ms / 60_000);
  return count(minutes, 'minute', 'minutes');
}

/** The id the person typed or picked as the Fluxer server: a raw id or "fluxer:<id>" is accepted. */
export const validTargetId = (text) => /^(fluxer:)?\d{17,20}$/.test(String(text ?? '').trim());
