// The server mirror's data (src/mirror/): which Discord server is copied to which Fluxer server, the map
// between their channels, roles, emoji and stickers, and the queue of work that keeps them in step.
//
//   mirror_pairs  one row per mirror: the Discord server (source_guild, a bare id) and the Fluxer server
//                 (target_guild, "fluxer:<id>"), the state (status), who agreed on each side, the hashed
//                 one-time code that asks the other side, the copy options and the last error.
//   mirror_ids    the id map of a pair: for each source id the id Sylo made (or adopted) on the target.
//                 `owned` is 1 for what Sylo created, and only owned items are ever deleted on the target.
//                 `spec_hash` is a fingerprint of what was last sent, so an unchanged item is not sent again.
//   mirror_links  the bridge links the mirror made for the channel pairs of a pair (see src/mirror/bridgeLink.js):
//                 which Discord channel and Fluxer channel, and the id of the bridge link. A row that stays after
//                 its link is gone means somebody unlinked that channel on purpose, so the mirror does not link
//                 it again.
//   mirror_jobs   the queue: one row per piece of work (copy one channel, update one role, delete one
//                 emoji ...). The queue is what makes a copy resumable: after a restart the unfinished rows
//                 are still there. Event rows coalesce: one open row per item.
//
// None of these tables has a guild_id column: a pair belongs to two servers, and purgeMirrorOf() (called
// from purge.js) removes every pair a server is part of, with its map and queue.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS mirror_pairs (
    id                SERIAL PRIMARY KEY,
    source_guild      TEXT NOT NULL,
    target_guild      TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    resume_status     TEXT NOT NULL DEFAULT '',
    options           TEXT NOT NULL DEFAULT '{}',
    code_hash         TEXT NOT NULL DEFAULT '',
    code_expires_at   BIGINT NOT NULL DEFAULT 0,
    code_attempts     INTEGER NOT NULL DEFAULT 0,
    requested_by      TEXT NOT NULL DEFAULT '',
    source_consent_by TEXT NOT NULL DEFAULT '',
    source_consent_at BIGINT NOT NULL DEFAULT 0,
    target_consent_by TEXT NOT NULL DEFAULT '',
    target_consent_at BIGINT NOT NULL DEFAULT 0,
    source_consent_user TEXT NOT NULL DEFAULT '',
    target_consent_user TEXT NOT NULL DEFAULT '',
    pause_kind        TEXT NOT NULL DEFAULT '',
    paused_by         TEXT NOT NULL DEFAULT '',
    copy_run          INTEGER NOT NULL DEFAULT 0,
    copied_at         BIGINT NOT NULL DEFAULT 0,
    failures          INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT NOT NULL DEFAULT '',
    created_at        BIGINT NOT NULL,
    updated_at        BIGINT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mirror_pairs_source ON mirror_pairs (source_guild);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mirror_pairs_target ON mirror_pairs (target_guild);

  CREATE TABLE IF NOT EXISTS mirror_ids (
    pair_id    INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    source_id  TEXT NOT NULL,
    target_id  TEXT NOT NULL,
    owned      INTEGER NOT NULL DEFAULT 1,
    spec_hash  TEXT NOT NULL DEFAULT '',
    label      TEXT NOT NULL DEFAULT '',
    removed_at BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (pair_id, kind, source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_mirror_ids_target ON mirror_ids (pair_id, kind, target_id);

  CREATE TABLE IF NOT EXISTS mirror_jobs (
    id         SERIAL PRIMARY KEY,
    pair_id    INTEGER NOT NULL,
    run        INTEGER NOT NULL DEFAULT 0,
    phase      TEXT NOT NULL,
    op         TEXT NOT NULL,
    kind       TEXT NOT NULL,
    source_id  TEXT NOT NULL DEFAULT '',
    step_key   TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    attempts   INTEGER NOT NULL DEFAULT 0,
    next_at    BIGINT NOT NULL DEFAULT 0,
    recovering INTEGER NOT NULL DEFAULT 0,
    first_claim_at BIGINT NOT NULL DEFAULT 0,
    payload    TEXT NOT NULL DEFAULT '{}',
    detail     TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '[]',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mirror_jobs_pair ON mirror_jobs (pair_id, status, id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mirror_jobs_open ON mirror_jobs (pair_id, step_key) WHERE status = 'pending';

  CREATE TABLE IF NOT EXISTS mirror_links (
    pair_id        INTEGER NOT NULL,
    source_channel TEXT NOT NULL,
    target_channel TEXT NOT NULL,
    link_id        INTEGER NOT NULL,
    created_at     BIGINT NOT NULL,
    PRIMARY KEY (pair_id, source_channel)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mirror_links_link ON mirror_links (link_id);
`);

/** Pair states. `pending`: waiting for both servers to agree. `ready`: agreed, not copied yet. */
export const PAIR_STATUS = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  COPYING: 'copying',
  LIVE: 'live',
  DONE: 'done',
  PAUSED: 'paused',
  STOPPED: 'stopped',
});

/** The states in which a mirror runs, and so do the bridge links it made. */
export const PAIR_RUNNING = Object.freeze([PAIR_STATUS.COPYING, PAIR_STATUS.LIVE, PAIR_STATUS.DONE]);

const num = (v) => Number(v ?? 0);

const parseJson = (text, fallback) => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
};

const toPair = (row) =>
  row
    ? {
        id: num(row.id),
        sourceGuild: row.source_guild,
        targetGuild: row.target_guild,
        status: row.status,
        resumeStatus: row.resume_status,
        options: parseJson(row.options, {}),
        codeHash: row.code_hash,
        codeExpiresAt: num(row.code_expires_at),
        codeAttempts: num(row.code_attempts),
        requestedBy: row.requested_by,
        sourceConsentBy: row.source_consent_by,
        sourceConsentAt: num(row.source_consent_at),
        targetConsentBy: row.target_consent_by,
        targetConsentAt: num(row.target_consent_at),
        sourceConsentUser: row.source_consent_user,
        targetConsentUser: row.target_consent_user,
        pauseKind: row.pause_kind,
        pausedBy: row.paused_by,
        copyRun: num(row.copy_run),
        copiedAt: num(row.copied_at),
        failures: num(row.failures),
        lastError: row.last_error,
        createdAt: num(row.created_at),
        updatedAt: num(row.updated_at),
      }
    : null;

const toJob = (row) =>
  row
    ? {
        id: num(row.id),
        pairId: num(row.pair_id),
        run: num(row.run),
        phase: row.phase,
        op: row.op,
        kind: row.kind,
        sourceId: row.source_id,
        stepKey: row.step_key,
        status: row.status,
        attempts: num(row.attempts),
        nextAt: num(row.next_at),
        recovering: num(row.recovering) === 1,
        firstClaimAt: num(row.first_claim_at),
        payload: parseJson(row.payload, {}),
        detail: row.detail,
        notes: Array.isArray(parseJson(row.notes, [])) ? parseJson(row.notes, []) : [],
        createdAt: num(row.created_at),
        updatedAt: num(row.updated_at),
      }
    : null;

const s = {
  insertPair: prepare(
    `INSERT INTO mirror_pairs (source_guild, target_guild, status, options, code_hash, code_expires_at,
       requested_by, source_consent_by, source_consent_at, target_consent_by, target_consent_at,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { returningId: true }
  ),
  pair: prepare('SELECT * FROM mirror_pairs WHERE id = ?'),
  bySource: prepare('SELECT * FROM mirror_pairs WHERE source_guild = ?'),
  byTarget: prepare('SELECT * FROM mirror_pairs WHERE target_guild = ?'),
  ofGuild: prepare('SELECT * FROM mirror_pairs WHERE source_guild = ? OR target_guild = ? ORDER BY id'),
  inStatus: prepare('SELECT * FROM mirror_pairs WHERE status = ? ORDER BY id'),
  allPairs: prepare('SELECT * FROM mirror_pairs ORDER BY id'),
  deletePair: prepare('DELETE FROM mirror_pairs WHERE id = ?'),
  deleteIds: prepare('DELETE FROM mirror_ids WHERE pair_id = ?'),
  deleteJobs: prepare('DELETE FROM mirror_jobs WHERE pair_id = ?'),
  deleteLinks: prepare('DELETE FROM mirror_links WHERE pair_id = ?'),
  linksOfPair: prepare('SELECT * FROM mirror_links WHERE pair_id = ? ORDER BY source_channel'),
  linkRow: prepare('SELECT * FROM mirror_links WHERE pair_id = ? AND source_channel = ?'),
  putLink: prepare(
    `INSERT INTO mirror_links (pair_id, source_channel, target_channel, link_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (pair_id, source_channel) DO NOTHING`
  ),
  pairOfLink: prepare('SELECT pair_id FROM mirror_links WHERE link_id = ?'),

  getId: prepare('SELECT * FROM mirror_ids WHERE pair_id = ? AND kind = ? AND source_id = ?'),
  getIdByTarget: prepare('SELECT * FROM mirror_ids WHERE pair_id = ? AND kind = ? AND target_id = ?'),
  listIds: prepare('SELECT * FROM mirror_ids WHERE pair_id = ? AND kind = ? ORDER BY source_id'),
  putId: prepare(`
    INSERT INTO mirror_ids (pair_id, kind, source_id, target_id, owned, spec_hash, label, removed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT (pair_id, kind, source_id) DO UPDATE SET
      target_id = excluded.target_id, owned = excluded.owned, spec_hash = excluded.spec_hash,
      label = excluded.label, removed_at = 0, updated_at = excluded.updated_at
  `),
  markRemoved: prepare(
    'UPDATE mirror_ids SET removed_at = ?, updated_at = ? WHERE pair_id = ? AND kind = ? AND source_id = ?'
  ),
  listRemoved: prepare(
    'SELECT * FROM mirror_ids WHERE pair_id = ? AND removed_at > 0 ORDER BY removed_at, source_id'
  ),
  countIds: prepare('SELECT COUNT(*) AS n FROM mirror_ids WHERE pair_id = ?'),
  recentDeletes: prepare(
    "SELECT COUNT(*) AS n FROM mirror_jobs WHERE pair_id = ? AND op = 'delete' AND created_at >= ?"
  ),
  pendingDeletes: prepare(
    "SELECT * FROM mirror_jobs WHERE pair_id = ? AND op = 'delete' AND status = 'pending' ORDER BY id LIMIT ?"
  ),
  countPendingDeletes: prepare(
    "SELECT COUNT(*) AS n FROM mirror_jobs WHERE pair_id = ? AND op = 'delete' AND status = 'pending'"
  ),
  deleteId: prepare('DELETE FROM mirror_ids WHERE pair_id = ? AND kind = ? AND source_id = ?'),

  insertJob: prepare(
    `INSERT INTO mirror_jobs (pair_id, run, phase, op, kind, source_id, step_key, status, payload, next_at,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`
  ),
  job: prepare('SELECT * FROM mirror_jobs WHERE id = ?'),
  nextJob: prepare(
    "SELECT * FROM mirror_jobs WHERE pair_id = ? AND status = 'pending' AND next_at <= ? ORDER BY id LIMIT 1"
  ),
  nextDue: prepare("SELECT MIN(next_at) AS at FROM mirror_jobs WHERE pair_id = ? AND status = 'pending'"),
  claimJob: prepare(
    `UPDATE mirror_jobs SET status = 'running', updated_at = ?,
       first_claim_at = CASE WHEN first_claim_at = 0 THEN ? ELSE first_claim_at END
     WHERE id = ? AND status = 'pending'`
  ),
  finishJob: prepare(
    'UPDATE mirror_jobs SET status = ?, detail = ?, notes = ?, recovering = 0, updated_at = ? WHERE id = ?'
  ),
  requeueJob: prepare(
    "UPDATE mirror_jobs SET status = 'pending', attempts = ?, next_at = ?, detail = ?, recovering = ?, updated_at = ? WHERE id = ?"
  ),
  twin: prepare(
    "SELECT id FROM mirror_jobs WHERE pair_id = ? AND step_key = ? AND status = 'pending' AND id <> ?"
  ),
  running: prepare("SELECT * FROM mirror_jobs WHERE status = 'running' ORDER BY id"),
  skipOpenFor: prepare(
    `UPDATE mirror_jobs SET status = 'skipped', detail = ?, updated_at = ?
     WHERE pair_id = ? AND kind = ? AND source_id = ? AND op = ? AND status = 'pending'`
  ),
  dropOpen: prepare(
    "UPDATE mirror_jobs SET status = 'skipped', detail = ?, updated_at = ? WHERE pair_id = ? AND status IN ('pending', 'running')"
  ),
  countByStatus: prepare(
    'SELECT status, COUNT(*) AS n FROM mirror_jobs WHERE pair_id = ? AND run = ? AND phase = ? GROUP BY status'
  ),
  countOpenSync: prepare(
    "SELECT COUNT(*) AS n FROM mirror_jobs WHERE pair_id = ? AND phase = 'sync' AND status IN ('pending', 'running')"
  ),
  countOpen: prepare(
    "SELECT COUNT(*) AS n FROM mirror_jobs WHERE pair_id = ? AND run = ? AND phase = 'copy' AND status IN ('pending', 'running')"
  ),
  jobsOfRun: prepare(
    'SELECT * FROM mirror_jobs WHERE pair_id = ? AND run = ? AND phase = ? ORDER BY id LIMIT ? OFFSET ?'
  ),
  failedJobs: prepare(
    "SELECT * FROM mirror_jobs WHERE pair_id = ? AND status = 'failed' ORDER BY id DESC LIMIT ?"
  ),
  pruneJobs: prepare(
    "DELETE FROM mirror_jobs WHERE status IN ('done', 'skipped') AND phase = 'sync' AND updated_at < ?"
  ),
  pruneOldRuns: prepare("DELETE FROM mirror_jobs WHERE pair_id = ? AND phase = 'copy' AND run < ?"),
};

// --- pairs ----------------------------------------------------------------------------------------

/**
 * Create a pair. The caller has checked that neither server is in another pair.
 * @param {{ sourceGuild: string, targetGuild: string, status?: string, options?: object, codeHash?: string,
 *   codeExpiresAt?: number, requestedBy?: string, sourceConsentBy?: string, targetConsentBy?: string,
 *   now?: number }} p
 */
export async function createPair(p) {
  const now = p.now ?? Date.now();
  const res = await s.insertPair.run(
    p.sourceGuild,
    p.targetGuild,
    p.status ?? PAIR_STATUS.PENDING,
    JSON.stringify(p.options ?? {}),
    p.codeHash ?? '',
    p.codeExpiresAt ?? 0,
    p.requestedBy ?? '',
    p.sourceConsentBy ?? '',
    p.sourceConsentBy ? now : 0,
    p.targetConsentBy ?? '',
    p.targetConsentBy ? now : 0,
    now,
    now
  );
  return getPair(Number(res.lastInsertRowid));
}

export const getPair = async (id) => toPair(await s.pair.get(id));
export const getPairBySource = async (key) => toPair(await s.bySource.get(key));
export const getPairByTarget = async (key) => toPair(await s.byTarget.get(key));
/** Every pair a server is part of, on either side. */
export const pairsOfGuild = async (key) => (await s.ofGuild.all(key, key)).map(toPair);
export const listPairsIn = async (status) => (await s.inStatus.all(status)).map(toPair);
export const listAllPairs = async () => (await s.allPairs.all()).map(toPair);

const COLUMNS = {
  status: 'status',
  resumeStatus: 'resume_status',
  options: 'options',
  codeHash: 'code_hash',
  codeExpiresAt: 'code_expires_at',
  codeAttempts: 'code_attempts',
  requestedBy: 'requested_by',
  sourceConsentBy: 'source_consent_by',
  sourceConsentAt: 'source_consent_at',
  targetConsentBy: 'target_consent_by',
  targetConsentAt: 'target_consent_at',
  sourceConsentUser: 'source_consent_user',
  targetConsentUser: 'target_consent_user',
  pauseKind: 'pause_kind',
  pausedBy: 'paused_by',
  copyRun: 'copy_run',
  copiedAt: 'copied_at',
  failures: 'failures',
  lastError: 'last_error',
};

/**
 * Change some fields of a pair. Only the listed fields exist; the SQL is built from fixed column names.
 * @param {number} id
 * @param {Partial<ReturnType<typeof toPair>>} patch
 */
export async function updatePair(id, patch, now = Date.now()) {
  const sets = [];
  const args = [];
  for (const [key, column] of Object.entries(COLUMNS)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    args.push(key === 'options' ? JSON.stringify(patch[key]) : patch[key]);
  }
  sets.push('updated_at = ?');
  args.push(now, id);
  await prepare(`UPDATE mirror_pairs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return getPair(id);
}

/** Delete a pair with its id map and queue. */
export async function deletePair(id) {
  await s.deleteIds.run(id);
  await s.deleteJobs.run(id);
  await s.deleteLinks.run(id);
  await s.deletePair.run(id);
}

/** Remove every pair a server is part of (the server was purged, or Sylo left it). Returns the pairs removed. */
export async function purgeMirrorOf(key) {
  const pairs = await pairsOfGuild(key);
  for (const p of pairs) await deletePair(p.id);
  return pairs;
}

// --- the bridge links of a pair ---------------------------------------------------------------------

const toMirrorLink = (row) =>
  row
    ? {
        pairId: num(row.pair_id),
        sourceChannel: row.source_channel,
        targetChannel: row.target_channel,
        linkId: num(row.link_id),
        createdAt: num(row.created_at),
      }
    : null;

/** The bridge links the mirror of a pair made (or tried to make and then lost: see the file header). */
export const listMirrorLinks = async (pairId) => (await s.linksOfPair.all(pairId)).map(toMirrorLink);
export const getMirrorLink = async (pairId, sourceChannel) =>
  toMirrorLink(await s.linkRow.get(pairId, sourceChannel));
/** Remember that a bridge link belongs to a pair's mirror. A channel that already has a row keeps it. */
export const putMirrorLink = (pairId, sourceChannel, targetChannel, linkId, now = Date.now()) =>
  s.putLink.run(pairId, sourceChannel, targetChannel, Number(linkId), now);
/** The pair a bridge link was made for, or null (a link somebody made by hand). */
export async function mirrorPairOfLink(linkId) {
  const row = await s.pairOfLink.get(Number(linkId));
  return row ? num(row.pair_id) : null;
}

// --- the id map -----------------------------------------------------------------------------------

const toMapping = (row) =>
  row
    ? {
        pairId: num(row.pair_id),
        kind: row.kind,
        sourceId: row.source_id,
        targetId: row.target_id,
        owned: num(row.owned) === 1,
        specHash: row.spec_hash,
        label: row.label,
        removedAt: num(row.removed_at),
      }
    : null;

export const getMapping = async (pairId, kind, sourceId) =>
  toMapping(await s.getId.get(pairId, kind, sourceId));
export const getMappingByTarget = async (pairId, kind, targetId) =>
  toMapping(await s.getIdByTarget.get(pairId, kind, targetId));
export const listMappings = async (pairId, kind) => (await s.listIds.all(pairId, kind)).map(toMapping);

export async function putMapping({
  pairId,
  kind,
  sourceId,
  targetId,
  owned = true,
  specHash = '',
  label = '',
  now,
}) {
  const at = now ?? Date.now();
  await s.putId.run(
    pairId,
    kind,
    sourceId,
    targetId,
    owned ? 1 : 0,
    specHash,
    String(label).slice(0, 100),
    at,
    at
  );
}

/** Note that the Discord original is gone while the Fluxer copy stays (it was locked, or left alone). */
export const markRemoved = (pairId, kind, sourceId, now = Date.now()) =>
  s.markRemoved.run(now, now, pairId, kind, sourceId);

/** The copies whose Discord original was deleted, oldest first. */
export async function listRemoved(pairId) {
  return (await s.listRemoved.all(pairId)).map(toMapping);
}

/** How many items a pair has in its id map (a stopped pair that made something is not thrown away). */
export async function countMappings(pairId) {
  return num((await s.countIds.get(pairId))?.n);
}

/** How many delete jobs a pair queued since `since`: what the burst brake counts. */
export async function countRecentDeletes(pairId, since) {
  return num((await s.recentDeletes.get(pairId, since))?.n);
}

export const deleteMapping = (pairId, kind, sourceId) => s.deleteId.run(pairId, kind, sourceId);

// --- the queue ------------------------------------------------------------------------------------

/**
 * Add a job unless an identical one is already waiting (same pair and step_key): a burst of events about
 * one item is one job, because the job reads the item as it is when it runs.
 * @returns {Promise<boolean>} whether a job was added
 */
export async function enqueueJob({
  pairId,
  run = 0,
  phase,
  op,
  kind,
  sourceId = '',
  stepKey,
  payload = {},
  now,
}) {
  const at = now ?? Date.now();
  const res = await s.insertJob.run(
    pairId,
    run,
    phase,
    op,
    kind,
    sourceId,
    stepKey,
    JSON.stringify(payload),
    at,
    at,
    at
  );
  return res.changes > 0;
}

export const getJob = async (id) => toJob(await s.job.get(id));

/** The oldest waiting job of a pair that is due. */
export const nextDueJob = async (pairId, now = Date.now()) => toJob(await s.nextJob.get(pairId, now));

/** When the next waiting job of a pair is due, or null when none is waiting. */
export async function nextDueAt(pairId) {
  const row = await s.nextDue.get(pairId);
  return row?.at == null ? null : num(row.at);
}

/** Take a waiting job. False when someone else took it first. */
export async function claimJob(id, now = Date.now()) {
  return (await s.claimJob.run(now, now, id)).changes === 1;
}

/** @param {'done'|'failed'|'skipped'} status */
export const finishJob = (id, status, detail = '', notes = [], now = Date.now()) =>
  s.finishJob.run(status, String(detail).slice(0, 500), JSON.stringify(notes ?? []), now, id);

/**
 * Put a running job back in the queue. If a newer job for the same step is already waiting (a change came in
 * while this one ran), that one will read the item as it is now, so this one is dropped instead: two waiting jobs
 * for one step are not allowed.
 */
async function requeue(job, { attempts, nextAt, detail, recovering, now }) {
  const twin = await s.twin.get(job.pairId, job.stepKey, job.id);
  if (twin) {
    await s.finishJob.run('skipped', 'a newer change replaced it', '[]', now, job.id);
    return;
  }
  await s.requeueJob.run(attempts, nextAt, String(detail).slice(0, 500), recovering ? 1 : 0, now, job.id);
}

/**
 * Put a job back in the queue to run again at `nextAt`. `maybeDone`: the call may have gone through before it
 * failed (a timeout), so the next run looks for what the last one made before it makes anything.
 */
export async function retryJob(
  id,
  attempts,
  nextAt,
  detail = '',
  now = Date.now(),
  { maybeDone = false } = {}
) {
  const job = await getJob(id);
  if (job) await requeue(job, { attempts, nextAt, detail, recovering: job.recovering || maybeDone, now });
}

/** After a restart: a job that was running when the process stopped waits again, marked as recovering. */
export async function recoverRunningJobs(now = Date.now()) {
  for (const row of await s.running.all()) {
    const job = toJob(row);
    await requeue(job, {
      attempts: job.attempts,
      nextAt: job.nextAt,
      detail: job.detail,
      recovering: true,
      now,
    });
  }
}

/** Skip the waiting jobs of one item and operation (a delete replaces a pending sync). */
export const skipWaitingJobs = (pairId, kind, sourceId, op, detail, now = Date.now()) =>
  s.skipOpenFor.run(detail, now, pairId, kind, sourceId, op);

/** Stop all unfinished work of a pair. */
export const dropOpenJobs = (pairId, detail, now = Date.now()) => s.dropOpen.run(detail, now, pairId);

/** Counts of a pair's jobs by status for one copy run, e.g. { pending: 3, done: 40 }. */
export async function jobCounts(pairId, run, phase = 'copy') {
  const out = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
  for (const row of await s.countByStatus.all(pairId, run, phase)) out[row.status] = num(row.n);
  return out;
}

export const openSyncCount = async (pairId) => num((await s.countOpenSync.get(pairId))?.n);
export const openCopyCount = async (pairId, run) => num((await s.countOpen.get(pairId, run))?.n);

/** The jobs of a copy run in order, a page at a time. */
export async function listRunJobs(pairId, run, { phase = 'copy', limit = 1000, offset = 0 } = {}) {
  return (await s.jobsOfRun.all(pairId, run, phase, limit, offset)).map(toJob);
}

/** The latest failed jobs of a pair. */
export async function listFailedJobs(pairId, limit = 50) {
  return (await s.failedJobs.all(pairId, limit)).map(toJob);
}

/** Housekeeping: finished event jobs older than `before`, and the jobs of copy runs before `keepRun`. */
export async function pruneMirrorJobs({ before, pairId, keepRun }) {
  if (before) await s.pruneJobs.run(before);
  if (pairId && keepRun) await s.pruneOldRuns.run(pairId, keepRun);
}

/** The deletes still waiting in a pair's queue: how many, and the first `limit` of them. */
export async function listPendingDeletes(pairId, limit = 50) {
  return {
    count: num((await s.countPendingDeletes.get(pairId))?.n),
    jobs: (await s.pendingDeletes.all(pairId, limit)).map(toJob),
  };
}
