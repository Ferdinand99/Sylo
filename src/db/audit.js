// Config audit log — a trail of who changed what from the dashboard. An entry for a settings save also
// keeps the settings that changed, before and after (change_json), which is what the dashboard's history
// view shows as a diff and what "Undo this change" restores. Secrets are masked before they are stored
// (src/lib/configSnapshot.js). The log keeps the newest 500 entries of a server, snapshots included, and
// goes with the server (GUILD_TABLES in purge.js).
import { prepare, registerPostgresBootstrap } from './driver.js';
import { takeModuleChange, takeOnlyModuleChange, takeSettingsChange } from './auditCapture.js';
import { changedSettings, parseChange, serialiseChange } from '../lib/configSnapshot.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS config_audit (
    id         SERIAL PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    change_json TEXT,
    reverts_id  INTEGER
  );
  ALTER TABLE config_audit ADD COLUMN IF NOT EXISTS change_json TEXT;
  ALTER TABLE config_audit ADD COLUMN IF NOT EXISTS reverts_id INTEGER;
  CREATE INDEX IF NOT EXISTS idx_config_audit_guild ON config_audit (guild_id, created_at DESC);
`);

const insertStmt = prepare(
  'INSERT INTO config_audit (guild_id, actor, action, detail, created_at, change_json, reverts_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
// A list never carries the snapshots (they can be large): only whether an entry has one.
const COLUMNS =
  'id, guild_id, actor, action, detail, created_at, reverts_id, CASE WHEN change_json IS NULL THEN 0 ELSE 1 END AS has_change';
const listStmt = prepare(
  `SELECT ${COLUMNS} FROM config_audit WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
);
const oneStmt = prepare('SELECT * FROM config_audit WHERE guild_id = ? AND id = ?');
// The rows whose copy or text may name a member: a cheap prefilter, then the exact test in JS (see boundedId).
const mentionsStmt = prepare(
  "SELECT id, action, detail, change_json, created_at FROM config_audit WHERE guild_id = ? AND (change_json LIKE '%' || ? || '%' OR detail LIKE '%' || ? || '%') ORDER BY id"
);
const setScrubbedStmt = prepare(
  'UPDATE config_audit SET change_json = ?, detail = ? WHERE guild_id = ? AND id = ?'
);
const copySizesStmt = prepare(
  'SELECT id, LENGTH(change_json) AS n FROM config_audit WHERE guild_id = ? AND change_json IS NOT NULL ORDER BY id DESC'
);
const dropCopyStmt = prepare('UPDATE config_audit SET change_json = NULL WHERE guild_id = ? AND id = ?');
// One page, newest first: `before` is the id of the last row of the previous page (0 = from the top). The
// order is the id's too, the same thing the cursor compares, so a page never skips or repeats a row.
const pageStmt = prepare(
  `SELECT ${COLUMNS} FROM config_audit WHERE guild_id = ? AND id < ? ORDER BY id DESC LIMIT ?`
);
const pageByActionStmt = prepare(
  `SELECT ${COLUMNS} FROM config_audit WHERE guild_id = ? AND action = ? AND id < ? ORDER BY id DESC LIMIT ?`
);
const actionsStmt = prepare(
  'SELECT action, COUNT(*) AS n FROM config_audit WHERE guild_id = ? GROUP BY action ORDER BY n DESC, action'
);
// Not a correlated subquery — the inner SELECT doesn't reference the outer
// query's columns, it's just the same table queried a second time in its own
// scope (picking the ids to keep), so there's no cross-scope ambiguity for
// Postgres to complain about here (unlike inviteTracker.js's `rank` query).
const pruneStmt = prepare(`
  DELETE FROM config_audit
  WHERE guild_id = ?
    AND id NOT IN (
      SELECT id FROM config_audit WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
    )
`);

const KEEP_PER_GUILD = 500;
// Together the saved copies of a server may hold this many characters (about 5 MB): when a new one pushes it
// over, the oldest copies are dropped (their entries stay, without the "Show changes"). With the cap on one
// copy (configSnapshot.js) a server's history never grows to the 500 x cap it could otherwise reach.
export const HISTORY_BUDGET_CHARS = 5_000_000;

async function keepCopiesInBudget(guildId) {
  let total = 0;
  for (const row of await copySizesStmt.all(guildId)) {
    total += Number(row.n) || 0;
    if (total > HISTORY_BUDGET_CHARS) await dropCopyStmt.run(guildId, row.id);
  }
}

/**
 * Write an entry. For a settings save the entry keeps the settings that changed: pass them as `change`
 * (`{ before, after }`, whole configs, not yet masked), or leave it out and the entry takes what the dashboard
 * request it is written in changed (auditCapture.js): a "module:<id>" entry the config of that module, a
 * "settings…" entry the server settings, any other entry the config of the one module the request wrote.
 * `revertsId` is the entry an undo undoes.
 * @param {string} guildId
 * @param {{ actor: string, action: string, detail?: string, change?: { before: object, after: object },
 *   revertsId?: number | null }} entry
 */
export async function recordAudit(guildId, { actor, action, detail = '', change, revertsId }) {
  const name = String(action).slice(0, 80);
  let picked = change;
  if (!picked) {
    if (name.startsWith('module:')) picked = takeModuleChange(guildId, name.slice('module:'.length));
    else if (name.startsWith('settings')) picked = takeSettingsChange(guildId);
    else picked = takeOnlyModuleChange(guildId);
  }
  const changed = picked ? changedSettings(picked.before, picked.after) : null;
  await insertStmt.run(
    guildId,
    String(actor).slice(0, 100),
    name,
    String(detail).slice(0, 500),
    Date.now(),
    changed ? serialiseChange(changed) : null,
    revertsId ?? null
  );
  await pruneStmt.run(guildId, guildId, KEEP_PER_GUILD);
  if (changed) await keepCopiesInBudget(guildId);
}

export async function listAudit(guildId, limit = 100) {
  return listStmt.all(guildId, limit);
}

const ID_MAX = 2147483647;

/**
 * One entry of one server, with its stored change parsed (`change`: `{ before, after }`, `{ tooLarge }`, or
 * null when it kept none). Null when the entry does not exist in this server.
 * @param {string} guildId
 * @param {number} id
 */
export async function getAuditEntry(guildId, id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1 || n > ID_MAX) return null;
  const row = await oneStmt.get(guildId, n);
  if (!row) return null;
  return {
    id: Number(row.id),
    actor: row.actor,
    action: row.action,
    detail: row.detail,
    createdAt: Number(row.created_at),
    revertsId: row.reverts_id == null ? null : Number(row.reverts_id),
    change: parseChange(row.change_json),
  };
}

// A member id is a whole run of digits: the id of a channel or a role that happens to contain these digits is
// not it. (A snowflake is 17 to 20 digits, so a shorter id can sit inside a longer one.)
const boundedId = (userId) => new RegExp(`(?<!\\d)${userId}(?!\\d)`, 'g');
const hasId = (text, userId) => typeof text === 'string' && boundedId(userId).test(text);

// A member id goes out of a stored change as an empty value: a list loses the entry, text loses the id.
function withoutId(value, userId) {
  if (typeof value === 'string') return value.replace(boundedId(userId), '');
  if (Array.isArray(value)) {
    return value.filter((v) => v !== userId).map((v) => withoutId(v, userId));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !hasId(k, userId))
        .map(([k, v]) => [k, withoutId(v, userId)])
    );
  }
  return value;
}

// The entries that name a member, in their saved copy or in their text.
async function entriesNaming(guildId, userId) {
  if (!/^\d{5,25}$/.test(String(userId))) return [];
  return (await mentionsStmt.all(guildId, userId, userId)).filter(
    (r) => hasId(r.change_json, userId) || hasId(r.detail, userId)
  );
}

/** How many entries of the history name this member (in what they changed or in their text). */
export async function countMemberInHistory(guildId, userId) {
  return (await entriesNaming(guildId, userId)).length;
}

/** Which entries those are: when, and what kind. Not the values (they are the server's settings). */
export async function memberHistoryRows(guildId, userId) {
  return (await entriesNaming(guildId, userId)).map((r) => ({
    id: Number(r.id),
    action: r.action,
    created_at: Number(r.created_at),
  }));
}

/**
 * Take a member's id out of the saved changes of the history (a setting can name a member: who an
 * auto-reaction targets, say). Used by /forget. The entry itself stays, with the id gone from what it kept.
 * @param {string} guildId
 * @param {string} userId
 * @returns {Promise<number>} how many entries were changed
 */
export async function scrubMemberFromHistory(guildId, userId) {
  let n = 0;
  for (const row of await entriesNaming(guildId, userId)) {
    let kept = row.change_json;
    if (hasId(kept, userId)) {
      try {
        kept = JSON.stringify(withoutId(JSON.parse(row.change_json), userId));
      } catch {
        kept = JSON.stringify({ tooLarge: true }); // damaged: nothing to show or restore
      }
    }
    const detail = hasId(row.detail, userId)
      ? row.detail.replace(boundedId(userId), 'a former member')
      : row.detail;
    if (kept !== row.change_json || detail !== row.detail) {
      await setScrubbedStmt.run(kept, detail, guildId, row.id);
      n += 1;
    }
  }
  return n;
}

const MAX_PAGE = 100;
// The id column is a 32-bit integer on Postgres: "from the top" is the largest value it holds.
const MAX_ID = 2147483647;

/**
 * A page of one server's audit rows, newest first, optionally only one action.
 * `before` is the id of the last row already shown (rows with a lower id follow). One extra row is read
 * to tell whether there is more.
 * @param {string} guildId
 * @param {{ limit?: number, before?: number, action?: string }} [opts]
 * @returns {Promise<{ rows: any[], hasMore: boolean }>}
 */
export async function listAuditPage(guildId, { limit = 50, before = 0, action = '' } = {}) {
  const size = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), MAX_PAGE);
  const from =
    Number.isSafeInteger(Number(before)) && Number(before) > 0 ? Math.min(Number(before), MAX_ID) : MAX_ID;
  const rows = action
    ? await pageByActionStmt.all(guildId, String(action).slice(0, 80), from, size + 1)
    : await pageStmt.all(guildId, from, size + 1);
  return { rows: rows.slice(0, size), hasMore: rows.length > size };
}

/** The kinds of change recorded for a server, with how many of each (most frequent first). */
export async function listAuditActions(guildId) {
  return (await actionsStmt.all(guildId)).map((r) => ({ action: r.action, count: Number(r.n) }));
}
