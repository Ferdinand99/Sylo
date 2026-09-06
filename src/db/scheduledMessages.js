// Reminders (internally still the "scheduled_messages" table). One row per
// reminder; the loop in modules/scheduledMessages.js polls dueReminders() and
// advances next_run_at (recurring) or disables the row (single).
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS scheduled_messages (
    id               SERIAL PRIMARY KEY,
    guild_id         TEXT NOT NULL,
    channel_id       TEXT NOT NULL,
    content          TEXT NOT NULL DEFAULT '',
    interval_minutes INTEGER NOT NULL,
    next_run_at      BIGINT NOT NULL,
    last_run_at      BIGINT,
    enabled          INTEGER NOT NULL DEFAULT 1,
    created_at       BIGINT NOT NULL,
    name             TEXT NOT NULL DEFAULT '',
    spec             TEXT,
    mode             TEXT NOT NULL DEFAULT 'multiple',
    days             TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
    start_at         BIGINT,
    end_at           BIGINT,
    run_at           BIGINT
  );
  CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled_messages (enabled, next_run_at);
  CREATE INDEX IF NOT EXISTS idx_sched_guild ON scheduled_messages (guild_id, created_at);
`);

const listStmt = prepare('SELECT * FROM scheduled_messages WHERE guild_id = ? ORDER BY created_at DESC');
const getStmt = prepare('SELECT * FROM scheduled_messages WHERE id = ? AND guild_id = ?');
const dueStmt = prepare(`
  SELECT * FROM scheduled_messages
  WHERE enabled = 1 AND (
    (mode = 'multiple' AND next_run_at IS NOT NULL AND next_run_at <= @now) OR
    (mode = 'single'   AND run_at      IS NOT NULL AND run_at      <= @now)
  )
  ORDER BY created_at LIMIT 50
`);
const insertStmt = prepare(
  `
  INSERT INTO scheduled_messages
    (guild_id, name, channel_id, content, spec, mode, days, interval_minutes, start_at, end_at, run_at, next_run_at, enabled, created_at)
  VALUES
    (@guildId, @name, @channelId, @content, @spec, @mode, @days, @intervalMinutes, @startAt, @endAt, @runAt, @nextRunAt, 1, @createdAt)
`,
  { returningId: true }
);
const updateStmt = prepare(`
  UPDATE scheduled_messages SET
    name = @name, channel_id = @channelId, content = @content, spec = @spec, mode = @mode, days = @days,
    interval_minutes = @intervalMinutes, start_at = @startAt, end_at = @endAt, run_at = @runAt, next_run_at = @nextRunAt
  WHERE id = @id AND guild_id = @guildId
`);
const deleteStmt = prepare('DELETE FROM scheduled_messages WHERE id = ? AND guild_id = ?');
const setEnabledStmt = prepare('UPDATE scheduled_messages SET enabled = ? WHERE id = ? AND guild_id = ?');
const advanceStmt = prepare(
  'UPDATE scheduled_messages SET last_run_at = @now, next_run_at = @nextRunAt WHERE id = @id'
);
const firedSingleStmt = prepare(
  'UPDATE scheduled_messages SET last_run_at = @now, enabled = 0 WHERE id = @id'
);

const ALL_DAYS = '0,1,2,3,4,5,6';

function hydrate(row) {
  if (!row) return null;
  let spec = null;
  if (row.spec) {
    try {
      spec = JSON.parse(row.spec);
    } catch {
      spec = null;
    }
  }
  if (!spec) spec = { content: row.content ?? '', embeds: [] };
  const days = String(row.days || ALL_DAYS)
    .split(',')
    .map((n) => Number(n))
    .filter((n) => n >= 0 && n <= 6);
  return { ...row, spec, dayList: days.length ? days : [0, 1, 2, 3, 4, 5, 6] };
}

export async function listScheduled(guildId) {
  return (await listStmt.all(guildId)).map(hydrate);
}
export async function getScheduled(guildId, id) {
  return hydrate(await getStmt.get(id, guildId));
}
export async function dueScheduled(now = Date.now()) {
  return (await dueStmt.all({ now })).map(hydrate);
}

/**
 * @param {string} guildId
 * @param {object} r  { name, channelId, spec, mode, days:number[], intervalMinutes, startAt, endAt, runAt }
 */
export async function createReminder(guildId, r) {
  const now = Date.now();
  // next_run_at is NOT NULL on the table; for single-mode it's unused (the loop
  // keys off run_at) so park it at the run time or the far future.
  const firstRun =
    r.mode === 'single'
      ? (r.runAt ?? Number.MAX_SAFE_INTEGER)
      : Math.max(now + r.intervalMinutes * 60_000, r.startAt ?? 0);
  const result = await insertStmt.run({
    guildId,
    name: String(r.name ?? '').slice(0, 100),
    channelId: r.channelId,
    content: String(r.spec?.content ?? '').slice(0, 2000),
    spec: JSON.stringify(r.spec ?? { content: '', embeds: [] }),
    mode: r.mode === 'single' ? 'single' : 'multiple',
    days: (Array.isArray(r.days) && r.days.length ? r.days : [0, 1, 2, 3, 4, 5, 6]).join(','),
    intervalMinutes: r.intervalMinutes ?? 60,
    startAt: r.startAt ?? null,
    endAt: r.endAt ?? null,
    runAt: r.mode === 'single' ? (r.runAt ?? null) : null,
    nextRunAt: firstRun,
    createdAt: now,
  });
  return result.lastInsertRowid;
}

export async function updateReminder(guildId, id, r) {
  const now = Date.now();
  // next_run_at is NOT NULL on the table; for single-mode it's unused (the loop
  // keys off run_at) so park it at the run time or the far future.
  const firstRun =
    r.mode === 'single'
      ? (r.runAt ?? Number.MAX_SAFE_INTEGER)
      : Math.max(now + r.intervalMinutes * 60_000, r.startAt ?? 0);
  await updateStmt.run({
    guildId,
    id,
    name: String(r.name ?? '').slice(0, 100),
    channelId: r.channelId,
    content: String(r.spec?.content ?? '').slice(0, 2000),
    spec: JSON.stringify(r.spec ?? { content: '', embeds: [] }),
    mode: r.mode === 'single' ? 'single' : 'multiple',
    days: (Array.isArray(r.days) && r.days.length ? r.days : [0, 1, 2, 3, 4, 5, 6]).join(','),
    intervalMinutes: r.intervalMinutes ?? 60,
    startAt: r.startAt ?? null,
    endAt: r.endAt ?? null,
    runAt: r.mode === 'single' ? (r.runAt ?? null) : null,
    nextRunAt: firstRun,
  });
}

export async function deleteScheduled(guildId, id) {
  await deleteStmt.run(id, guildId);
}
export async function setScheduledEnabled(guildId, id, enabled) {
  await setEnabledStmt.run(enabled ? 1 : 0, id, guildId);
}

/** Recurring reminder fired — bump next_run_at by one interval. */
export async function advanceReminder(id, intervalMinutes, now = Date.now()) {
  await advanceStmt.run({ id, now, nextRunAt: now + intervalMinutes * 60_000 });
}
/** Single reminder fired — mark it done. */
export async function markSingleFired(id, now = Date.now()) {
  await firedSingleStmt.run({ id, now });
}
