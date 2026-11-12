// Applications storage: the forms a server offers and what members submitted.
//
//   applications_forms        id, guild_id, name, enabled, fill_mode ('discord' | 'web' | 'both'),
//                             sort_order, config (JSON: description, questions, requirements, channels,
//                             roles, texts ... the shape and the rules are in modules/applications.js),
//                             created_at, updated_at (also the form's version: it only ever grows)
//   applications_submissions  one row per submission: the form (id and its name as it was), the member,
//                             status ('pending' | 'accepted' | 'denied' | 'withdrawn'), source ('dm' |
//                             'web'), questions (JSON snapshot of the questions as they were asked),
//                             answers (JSON { "<question id>": "<answer>" }), the post (channel_id /
//                             message_id) and an optional copy of it in the accepted or denied channel
//                             (copy_channel_id / copy_message_id), the staff thread, decided_by / reason /
//                             decided_at, roles_pending (JSON list of role changes that failed and wait
//                             for a retry), dm_note (which messages to the member could not be sent),
//                             history (JSON list of what happened), cleared (1: the answers were erased
//                             but the row stays, because a post could not be deleted yet)
//   applications_cooldowns    (guild, form, member) -> until_at: the cooldown after a denial. It is kept
//                             when a member is forgotten and when decided submissions are deleted, so
//                             neither is a way around the cooldown; it is pruned once it has run out.
//
// `guild_id` is the server key (a Discord id, or "fluxer:<id>"), like every other table, so the
// guild-leave purge and /forget find it. The tables are created here for Postgres (SQLite: migration 72).
// Only one submission per form and member may be pending: a partial unique index makes the database
// itself refuse a second one, whatever the code does.
import { prepare, registerPostgresBootstrap, transaction } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS applications_forms (
    id         BIGSERIAL PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    name       TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    fill_mode  TEXT NOT NULL DEFAULT 'both',
    sort_order INTEGER NOT NULL DEFAULT 0,
    config     TEXT NOT NULL DEFAULT '{}',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  ALTER TABLE applications_forms ADD COLUMN IF NOT EXISTS enabled INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE applications_forms ADD COLUMN IF NOT EXISTS fill_mode TEXT NOT NULL DEFAULT 'both';
  ALTER TABLE applications_forms ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE applications_forms ADD COLUMN IF NOT EXISTS config TEXT NOT NULL DEFAULT '{}';
  CREATE INDEX IF NOT EXISTS idx_applications_forms_guild ON applications_forms (guild_id, sort_order, id);
  CREATE TABLE IF NOT EXISTS applications_submissions (
    id              BIGSERIAL PRIMARY KEY,
    guild_id        TEXT NOT NULL,
    form_id         BIGINT NOT NULL,
    form_name       TEXT NOT NULL DEFAULT '',
    pending_role_id TEXT,
    user_id         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    source          TEXT NOT NULL DEFAULT 'dm',
    questions       TEXT NOT NULL DEFAULT '[]',
    answers         TEXT NOT NULL DEFAULT '{}',
    channel_id      TEXT,
    message_id      TEXT,
    copy_channel_id TEXT,
    copy_message_id TEXT,
    thread_id       TEXT,
    decided_by      TEXT,
    reason          TEXT NOT NULL DEFAULT '',
    decided_at      BIGINT,
    roles_pending   TEXT NOT NULL DEFAULT '[]',
    dm_note         TEXT NOT NULL DEFAULT '',
    history         TEXT NOT NULL DEFAULT '[]',
    cleared         INTEGER NOT NULL DEFAULT 0,
    created_at      BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL
  );
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS form_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS pending_role_id TEXT;
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'dm';
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS questions TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS answers TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS channel_id TEXT;
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS message_id TEXT;
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS copy_channel_id TEXT;
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS copy_message_id TEXT;
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS thread_id TEXT;
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS decided_by TEXT;
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS decided_at BIGINT;
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS roles_pending TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS dm_note TEXT NOT NULL DEFAULT '';
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS history TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE applications_submissions ADD COLUMN IF NOT EXISTS cleared INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_one_pending
    ON applications_submissions (guild_id, form_id, user_id) WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS idx_applications_sub_status ON applications_submissions (guild_id, status, id DESC);
  CREATE INDEX IF NOT EXISTS idx_applications_sub_user ON applications_submissions (guild_id, user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_applications_sub_form ON applications_submissions (guild_id, form_id, status);
  CREATE INDEX IF NOT EXISTS idx_applications_sub_message ON applications_submissions (guild_id, message_id);
  CREATE INDEX IF NOT EXISTS idx_applications_sub_decided ON applications_submissions (decided_at) WHERE status <> 'pending';
  CREATE TABLE IF NOT EXISTS applications_cooldowns (
    guild_id TEXT NOT NULL,
    form_id  BIGINT NOT NULL,
    user_id  TEXT NOT NULL,
    until_at BIGINT NOT NULL,
    PRIMARY KEY (guild_id, form_id, user_id)
  );
  ALTER TABLE applications_cooldowns ADD COLUMN IF NOT EXISTS until_at BIGINT NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_applications_cooldowns_until ON applications_cooldowns (until_at);
`);

export const STATUSES = ['pending', 'accepted', 'denied', 'withdrawn'];
export const SOURCES = ['dm', 'web'];
/** What a history list may hold, so a member cannot make it grow without end. */
export const HISTORY_CAP = 60;

const parse = (text, fallback) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
};

const formOf = (row) =>
  row && {
    id: Number(row.id),
    guildId: row.guild_id,
    name: row.name,
    enabled: Number(row.enabled) === 1,
    fillMode: row.fill_mode,
    sortOrder: Number(row.sort_order),
    config: parse(row.config, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };

/** A submission row as an object (JSON columns parsed, numbers as numbers). */
export const submissionOf = (row) =>
  row && {
    id: Number(row.id),
    guildId: row.guild_id,
    formId: Number(row.form_id),
    formName: row.form_name,
    pendingRoleId: row.pending_role_id ?? null,
    userId: row.user_id,
    status: row.status,
    source: row.source,
    questions: parse(row.questions, []),
    answers: (() => {
      const a = parse(row.answers, {});
      return Array.isArray(a) ? {} : a;
    })(),
    channelId: row.channel_id ?? null,
    messageId: row.message_id ?? null,
    copyChannelId: row.copy_channel_id ?? null,
    copyMessageId: row.copy_message_id ?? null,
    threadId: row.thread_id ?? null,
    decidedBy: row.decided_by ?? null,
    reason: row.reason ?? '',
    decidedAt: row.decided_at == null ? null : Number(row.decided_at),
    rolesPending: Array.isArray(parse(row.roles_pending, [])) ? parse(row.roles_pending, []) : [],
    dmNote: row.dm_note ?? '',
    history: Array.isArray(parse(row.history, [])) ? parse(row.history, []) : [],
    cleared: Number(row.cleared) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };

const s = {
  insertForm: prepare(
    `INSERT INTO applications_forms (guild_id, name, enabled, fill_mode, sort_order, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    { returningId: true }
  ),
  getForm: prepare('SELECT * FROM applications_forms WHERE guild_id = ? AND id = ?'),
  listForms: prepare('SELECT * FROM applications_forms WHERE guild_id = ? ORDER BY sort_order, id'),
  countForms: prepare('SELECT COUNT(*) AS n FROM applications_forms WHERE guild_id = ?'),
  maxOrder: prepare('SELECT MAX(sort_order) AS m FROM applications_forms WHERE guild_id = ?'),
  updateForm: prepare(
    `UPDATE applications_forms SET name = ?, enabled = ?, fill_mode = ?, config = ?,
       updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
     WHERE guild_id = ? AND id = ?`
  ),
  setFormOrder: prepare('UPDATE applications_forms SET sort_order = ? WHERE guild_id = ? AND id = ?'),
  deleteForm: prepare('DELETE FROM applications_forms WHERE guild_id = ? AND id = ?'),

  insertSubmission: prepare(
    `INSERT INTO applications_submissions
       (guild_id, form_id, form_name, pending_role_id, user_id, status, source, questions, answers, history, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    { returningId: true }
  ),
  getSubmission: prepare('SELECT * FROM applications_submissions WHERE guild_id = ? AND id = ?'),
  getSubmissionAny: prepare('SELECT * FROM applications_submissions WHERE id = ?'),
  pendingOf: prepare(
    "SELECT * FROM applications_submissions WHERE guild_id = ? AND form_id = ? AND user_id = ? AND status = 'pending'"
  ),
  pendingOfUser: prepare(
    "SELECT * FROM applications_submissions WHERE guild_id = ? AND user_id = ? AND status = 'pending' ORDER BY id"
  ),
  byMessage: prepare(
    'SELECT * FROM applications_submissions WHERE guild_id = ? AND (message_id = ? OR copy_message_id = ?)'
  ),
  ofUser: prepare(
    'SELECT * FROM applications_submissions WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?'
  ),
  allOfUser: prepare('SELECT * FROM applications_submissions WHERE guild_id = ? AND user_id = ? ORDER BY id'),
  pendingCount: prepare(
    "SELECT COUNT(*) AS n FROM applications_submissions WHERE guild_id = ? AND status = 'pending'"
  ),
  setPost: prepare(
    'UPDATE applications_submissions SET channel_id = ?, message_id = ?, updated_at = ? WHERE guild_id = ? AND id = ?'
  ),
  setCopy: prepare(
    'UPDATE applications_submissions SET copy_channel_id = ?, copy_message_id = ?, updated_at = ? WHERE guild_id = ? AND id = ?'
  ),
  setThread: prepare(
    'UPDATE applications_submissions SET thread_id = ?, updated_at = ? WHERE guild_id = ? AND id = ?'
  ),
  setRoles: prepare(
    'UPDATE applications_submissions SET roles_pending = ?, history = ?, updated_at = ? WHERE guild_id = ? AND id = ?'
  ),
  setDmNote: prepare(
    'UPDATE applications_submissions SET dm_note = ?, updated_at = ? WHERE guild_id = ? AND id = ?'
  ),
  setHistory: prepare(
    'UPDATE applications_submissions SET history = ?, updated_at = ? WHERE guild_id = ? AND id = ?'
  ),
  clearAnswers: prepare(
    "UPDATE applications_submissions SET answers = '{}', questions = '[]', cleared = 1, updated_at = ? WHERE guild_id = ? AND id = ?"
  ),
  deleteSubmission: prepare('DELETE FROM applications_submissions WHERE guild_id = ? AND id = ?'),
  // Rows whose answers were erased (cleared) are not here: they wait for their post in clearedRows, so a
  // row whose post keeps failing cannot hold up the newer ones.
  decidedBeforeInGuild: prepare(
    `SELECT * FROM applications_submissions WHERE guild_id = ? AND cleared = 0 AND status <> 'pending' AND decided_at IS NOT NULL AND decided_at < ?
     ORDER BY decided_at, id LIMIT ?`
  ),
  guildsDecidedBefore: prepare(
    `SELECT DISTINCT guild_id FROM applications_submissions WHERE cleared = 0 AND status <> 'pending' AND decided_at IS NOT NULL AND decided_at < ?`
  ),
  // The one tried longest ago first; a row that fails again is touched and goes to the back.
  clearedRows: prepare(
    'SELECT * FROM applications_submissions WHERE cleared = 1 ORDER BY updated_at, id LIMIT ?'
  ),
  touch: prepare('UPDATE applications_submissions SET updated_at = ? WHERE guild_id = ? AND id = ?'),

  getCooldown: prepare(
    'SELECT until_at FROM applications_cooldowns WHERE guild_id = ? AND form_id = ? AND user_id = ?'
  ),
  setCooldown: prepare(
    `INSERT INTO applications_cooldowns (guild_id, form_id, user_id, until_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, form_id, user_id) DO UPDATE SET until_at = excluded.until_at`
  ),
  pruneCooldowns: prepare('DELETE FROM applications_cooldowns WHERE until_at < ?'),
  deleteFormCooldowns: prepare('DELETE FROM applications_cooldowns WHERE guild_id = ? AND form_id = ?'),
};

// --- forms ----------------------------------------------------------------------------------------

/** @returns {Promise<ReturnType<typeof formOf>[]>} */
export const listForms = async (guildId) => (await s.listForms.all(guildId)).map(formOf);
export const getForm = async (guildId, id) => formOf(await s.getForm.get(guildId, Number(id))) ?? null;
export const formCount = async (guildId) => Number((await s.countForms.get(guildId)).n);

/**
 * @param {{ guildId: string, name: string, enabled: boolean, fillMode: string, config: object }} form
 * @returns {Promise<number>} the id
 */
export async function insertForm({ guildId, name, enabled, fillMode, config }) {
  const now = Date.now();
  const order = Number((await s.maxOrder.get(guildId))?.m ?? -1) + 1;
  const out = await s.insertForm.run(
    guildId,
    name,
    enabled ? 1 : 0,
    fillMode,
    order,
    JSON.stringify(config),
    now,
    now
  );
  return Number(out.lastInsertRowid);
}

/** Replace a form. The version (updated_at) always moves forward, even within one millisecond. */
export async function updateForm(guildId, id, { name, enabled, fillMode, config }) {
  const now = Date.now();
  return (
    await s.updateForm.run(
      name,
      enabled ? 1 : 0,
      fillMode,
      JSON.stringify(config),
      now,
      now,
      guildId,
      Number(id)
    )
  ).changes;
}

/** Put the forms in this order (ids not listed keep their place after the listed ones). */
export async function reorderForms(guildId, ids) {
  let n = 0;
  for (const id of ids) await s.setFormOrder.run(n++, guildId, Number(id));
  for (const form of await listForms(guildId)) {
    if (!ids.map(Number).includes(form.id)) await s.setFormOrder.run(n++, guildId, form.id);
  }
}

export async function deleteForm(guildId, id) {
  await s.deleteFormCooldowns.run(guildId, Number(id));
  return (await s.deleteForm.run(guildId, Number(id))).changes;
}

// --- submissions ----------------------------------------------------------------------------------

/** True for the error a database throws when a unique index refuses a row. */
export const isUniqueViolation = (err) =>
  err?.code === '23505' ||
  String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT') ||
  /unique constraint|duplicate key/i.test(String(err?.message ?? ''));

/**
 * Insert a pending submission. Throws (see isUniqueViolation) when the member already has one
 * pending for this form.
 * @returns {Promise<number>} the id
 */
export async function insertSubmission({
  guildId,
  formId,
  formName,
  pendingRoleId = null,
  userId,
  source,
  questions,
  answers,
}) {
  const now = Date.now();
  const history = [{ at: now, by: userId, action: 'submitted', note: source }];
  const out = await s.insertSubmission.run(
    guildId,
    Number(formId),
    formName,
    pendingRoleId || null,
    userId,
    source,
    JSON.stringify(questions),
    JSON.stringify(answers),
    JSON.stringify(history),
    now,
    now
  );
  return Number(out.lastInsertRowid);
}

export const getSubmission = async (guildId, id) =>
  submissionOf(await s.getSubmission.get(guildId, Number(id))) ?? null;
/** By id alone (a button carries only the id); the caller checks the server. */
export const getSubmissionAny = async (id) => submissionOf(await s.getSubmissionAny.get(Number(id))) ?? null;
export const pendingSubmission = async (guildId, formId, userId) =>
  submissionOf(await s.pendingOf.get(guildId, Number(formId), userId)) ?? null;
export const pendingOfUser = async (guildId, userId) =>
  (await s.pendingOfUser.all(guildId, userId)).map(submissionOf);
export const submissionByMessage = async (guildId, messageId) =>
  submissionOf(await s.byMessage.get(guildId, messageId, messageId)) ?? null;
export const submissionsOfUser = async (guildId, userId, limit = 100) =>
  (await s.ofUser.all(guildId, userId, limit)).map(submissionOf);
export const allSubmissionsOfUser = async (guildId, userId) =>
  (await s.allOfUser.all(guildId, userId)).map(submissionOf);
export const pendingCount = async (guildId) => Number((await s.pendingCount.get(guildId)).n);

/**
 * A filtered page of a server's submissions, newest first.
 * @param {{ guildId: string, formId?: number, status?: string, userId?: string, limit?: number, offset?: number }} q
 */
export async function listSubmissions({ guildId, formId, status, userId, limit = 25, offset = 0 }) {
  const where = ['guild_id = ?'];
  const args = [guildId];
  if (formId) {
    where.push('form_id = ?');
    args.push(Number(formId));
  }
  if (status && STATUSES.includes(status)) {
    where.push('status = ?');
    args.push(status);
  }
  if (userId) {
    where.push('user_id = ?');
    args.push(userId);
  }
  const clause = where.join(' AND ');
  const rows = await prepare(
    `SELECT * FROM applications_submissions WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...args, Math.min(Math.max(1, limit), 200), Math.max(0, offset));
  const total = Number(
    (await prepare(`SELECT COUNT(*) AS n FROM applications_submissions WHERE ${clause}`).get(...args)).n
  );
  return { rows: rows.map(submissionOf), total };
}

/** Every submission of a form (optionally of one status), oldest first, for the export. */
export async function exportSubmissions({ guildId, formId, status }) {
  const where = ['guild_id = ?', 'form_id = ?'];
  const args = [guildId, Number(formId)];
  if (status && STATUSES.includes(status)) {
    where.push('status = ?');
    args.push(status);
  }
  const rows = await prepare(
    `SELECT * FROM applications_submissions WHERE ${where.join(' AND ')} AND cleared = 0 ORDER BY id`
  ).all(...args);
  return rows.map(submissionOf);
}

const CLAIM_SQL = `UPDATE applications_submissions SET status = ?, decided_by = ?, reason = ?, decided_at = ?, history = ?, updated_at = ?
  WHERE guild_id = ? AND id = ? AND status = 'pending'`;
const COOLDOWN_SQL = `INSERT INTO applications_cooldowns (guild_id, form_id, user_id, until_at) VALUES (?, ?, ?, ?)
  ON CONFLICT (guild_id, form_id, user_id) DO UPDATE SET until_at = excluded.until_at`;

/**
 * Decide a pending submission, once: the update only matches a row that is still pending, so two
 * deciders at the same time (a double click, two staff) get one winner. A cooldown that goes with the
 * decision ({ formId, userId, until }) is written in the same transaction, so there is no moment when
 * the application is denied and the member may apply again.
 * @returns {Promise<boolean>} whether this call decided it
 */
export async function claimDecision(guildId, id, { status, by, reason, history, cooldown = null }) {
  const now = Date.now();
  return transaction(function* (tx) {
    const out = yield tx.run(
      CLAIM_SQL,
      status,
      by ?? null,
      reason ?? '',
      now,
      JSON.stringify(history),
      now,
      guildId,
      Number(id)
    );
    if (out.changes !== 1) return false;
    if (cooldown)
      yield tx.run(COOLDOWN_SQL, guildId, Number(cooldown.formId), cooldown.userId, cooldown.until);
    return true;
  });
}

export const setSubmissionPost = (guildId, id, channelId, messageId) =>
  s.setPost.run(channelId ?? null, messageId ?? null, Date.now(), guildId, Number(id));
export const setSubmissionCopy = (guildId, id, channelId, messageId) =>
  s.setCopy.run(channelId ?? null, messageId ?? null, Date.now(), guildId, Number(id));
export const setSubmissionThread = (guildId, id, threadId) =>
  s.setThread.run(threadId ?? null, Date.now(), guildId, Number(id));
export const setSubmissionRoles = (guildId, id, rolesPending, history) =>
  s.setRoles.run(
    JSON.stringify(rolesPending),
    JSON.stringify(history.slice(-HISTORY_CAP)),
    Date.now(),
    guildId,
    Number(id)
  );
export const setSubmissionDmNote = (guildId, id, note) =>
  s.setDmNote.run(note, Date.now(), guildId, Number(id));
export const setSubmissionHistory = (guildId, id, history) =>
  s.setHistory.run(JSON.stringify(history.slice(-HISTORY_CAP)), Date.now(), guildId, Number(id));
/** Erase the answers (and the questions they belong to) but keep the row and the ids of its posts. */
export const clearSubmissionAnswers = (guildId, id) => s.clearAnswers.run(Date.now(), guildId, Number(id));
export const deleteSubmission = async (guildId, id) =>
  (await s.deleteSubmission.run(guildId, Number(id))).changes;

/** Decided (not pending) submissions of a server older than `cutoff`, oldest first. */
export const decidedBeforeInGuild = async (guildId, cutoff, limit = 200) =>
  (await s.decidedBeforeInGuild.all(guildId, cutoff, limit)).map(submissionOf);
/** The servers that have a decided submission older than `cutoff`. */
export const guildsWithDecidedBefore = async (cutoff) =>
  (await s.guildsDecidedBefore.all(cutoff)).map((r) => r.guild_id);
/** Rows whose answers were erased but whose posts may still need deleting. */
/** Move a row to the back of the line for the retention sweep. */
export const touchSubmission = (guildId, id) => s.touch.run(Date.now(), guildId, Number(id));
export const clearedSubmissions = async (limit = 200) => (await s.clearedRows.all(limit)).map(submissionOf);

// --- cooldowns ------------------------------------------------------------------------------------

export const getCooldownUntil = async (guildId, formId, userId) =>
  Number((await s.getCooldown.get(guildId, Number(formId), userId))?.until_at ?? 0);
export const setCooldownUntil = (guildId, formId, userId, untilAt) =>
  s.setCooldown.run(guildId, Number(formId), userId, untilAt);
export const pruneCooldowns = async (now = Date.now()) => (await s.pruneCooldowns.run(now)).changes;
