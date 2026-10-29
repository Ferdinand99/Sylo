// Events storage: a row per event, a row per member who signed up. Finished and cancelled events
// are kept (the dashboard lists recent past events) until the guild is purged.
//
//   state     'scheduled' (upcoming or running) | 'ended' | 'cancelled'
//   start_at  epoch ms (UTC); the creator's IANA zone is kept only to show the time as they set it
//   end_at    epoch ms or NULL; with no end the event counts as over END_GRACE_MS after the start
//   status    'join' | 'maybe' (leaving deletes the row)
//   host_id   NULL after the host used /forget: the event stays, the person does not
import { prepare, registerPostgresBootstrap, registerPostgresMigration } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS guild_events (
    id               SERIAL PRIMARY KEY,
    guild_id         TEXT NOT NULL,
    channel_id       TEXT NOT NULL,
    message_id       TEXT,
    title            TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    location         TEXT NOT NULL DEFAULT '',
    image_url        TEXT NOT NULL DEFAULT '',
    start_at         BIGINT NOT NULL,
    end_at           BIGINT,
    time_zone        TEXT NOT NULL DEFAULT 'UTC',
    capacity         INTEGER,
    role_id          TEXT,
    reminder_minutes INTEGER NOT NULL DEFAULT 0,
    reminder_sent    INTEGER NOT NULL DEFAULT 0,
    host_id          TEXT,
    state            TEXT NOT NULL DEFAULT 'scheduled',
    created_at       BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_guild_events_guild ON guild_events (guild_id, state, start_at);
  CREATE TABLE IF NOT EXISTS guild_event_participants (
    event_id   INTEGER NOT NULL,
    user_id    TEXT NOT NULL,
    status     TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (event_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_guild_event_participants_user ON guild_event_participants (user_id);
`);

// Mirrors SQLite migration 58: a host can be taken off an event (/forget), so host_id may be NULL.
registerPostgresMigration(58, 'ALTER TABLE guild_events ALTER COLUMN host_id DROP NOT NULL;');

/** An event with no end time is treated as over this long after it starts. */
export const END_GRACE_MS = 2 * 3_600_000;

const s = {
  create: prepare(
    `
    INSERT INTO guild_events (guild_id, channel_id, title, description, location, image_url, start_at, end_at,
      time_zone, capacity, role_id, reminder_minutes, reminder_sent, host_id, created_at)
    VALUES (@guildId, @channelId, @title, @description, @location, @imageUrl, @startAt, @endAt,
      @timeZone, @capacity, @roleId, @reminderMinutes, @reminderSent, @hostId, @createdAt)
  `,
    { returningId: true }
  ),
  setMessage: prepare('UPDATE guild_events SET message_id = ? WHERE id = ?'),
  get: prepare('SELECT * FROM guild_events WHERE id = ?'),
  getInGuild: prepare('SELECT * FROM guild_events WHERE id = ? AND guild_id = ?'),
  upcoming: prepare(
    "SELECT * FROM guild_events WHERE guild_id = ? AND state = 'scheduled' ORDER BY start_at ASC"
  ),
  past: prepare(
    "SELECT * FROM guild_events WHERE guild_id = ? AND state <> 'scheduled' ORDER BY start_at DESC LIMIT ?"
  ),
  countScheduled: prepare(
    "SELECT COUNT(*) AS n FROM guild_events WHERE guild_id = ? AND state = 'scheduled'"
  ),
  dueEnd: prepare(
    `SELECT * FROM guild_events WHERE state = 'scheduled' AND COALESCE(end_at, start_at + ${END_GRACE_MS}) <= ?`
  ),
  dueReminders: prepare(`
    SELECT * FROM guild_events
    WHERE state = 'scheduled' AND reminder_minutes > 0 AND reminder_sent = 0
      AND start_at - reminder_minutes * 60000 <= ?
  `),
  claimReminder: prepare('UPDATE guild_events SET reminder_sent = 1 WHERE id = ? AND reminder_sent = 0'),
  claimState: prepare("UPDATE guild_events SET state = ? WHERE id = ? AND state = 'scheduled'"),
  update: prepare(`
    UPDATE guild_events SET title = @title, description = @description, location = @location,
      image_url = @imageUrl, start_at = @startAt, end_at = @endAt, time_zone = @timeZone,
      capacity = @capacity, reminder_minutes = @reminderMinutes, reminder_sent = @reminderSent
    WHERE id = @id
  `),
  del: prepare('DELETE FROM guild_events WHERE id = ?'),
  delParticipants: prepare('DELETE FROM guild_event_participants WHERE event_id = ?'),
  delGuildParticipants: prepare(
    'DELETE FROM guild_event_participants WHERE event_id IN (SELECT id FROM guild_events WHERE guild_id = ?)'
  ),
  delGuild: prepare('DELETE FROM guild_events WHERE guild_id = ?'),

  setParticipant: prepare(`
    INSERT INTO guild_event_participants (event_id, user_id, status, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (event_id, user_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
  `),
  removeParticipant: prepare('DELETE FROM guild_event_participants WHERE event_id = ? AND user_id = ?'),
  getParticipant: prepare('SELECT * FROM guild_event_participants WHERE event_id = ? AND user_id = ?'),
  countByStatus: prepare(
    'SELECT COUNT(*) AS n FROM guild_event_participants WHERE event_id = ? AND status = ?'
  ),
  countAll: prepare('SELECT COUNT(*) AS n FROM guild_event_participants WHERE event_id = ?'),
  roleElsewhere: prepare(`
    SELECT 1 FROM guild_event_participants p JOIN guild_events e ON e.id = p.event_id
    WHERE p.user_id = ? AND p.status = 'join' AND e.guild_id = ? AND e.role_id = ?
      AND e.state = 'scheduled' AND e.id <> ?
    LIMIT 1
  `),
  idsByStatus: prepare(
    'SELECT user_id FROM guild_event_participants WHERE event_id = ? AND status = ? ORDER BY updated_at ASC, user_id ASC'
  ),
};

const hydrate = (row) => {
  if (!row) return null;
  // Postgres hands BIGINT back as text on some paths; everything downstream treats them as numbers.
  return {
    ...row,
    start_at: Number(row.start_at),
    end_at: row.end_at == null ? null : Number(row.end_at),
    created_at: Number(row.created_at),
    capacity: row.capacity == null ? null : Number(row.capacity),
    reminder_minutes: Number(row.reminder_minutes),
    reminder_sent: row.reminder_sent === 1 || row.reminder_sent === '1',
  };
};

/**
 * @param {{ guildId: string, channelId: string, title: string, description?: string, location?: string,
 *   imageUrl?: string, startAt: number, endAt?: number|null, timeZone?: string, capacity?: number|null,
 *   roleId?: string|null, reminderMinutes?: number, reminderSent?: boolean, hostId: string, createdAt?: number }} e
 * @returns {Promise<{ id: number }>}
 */
export async function createEvent(e) {
  const info = await s.create.run({
    guildId: e.guildId,
    channelId: e.channelId,
    title: e.title,
    description: e.description ?? '',
    location: e.location ?? '',
    imageUrl: e.imageUrl ?? '',
    startAt: e.startAt,
    endAt: e.endAt ?? null,
    timeZone: e.timeZone || 'UTC',
    capacity: e.capacity ?? null,
    roleId: e.roleId || null,
    reminderMinutes: e.reminderMinutes ?? 0,
    reminderSent: e.reminderSent ? 1 : 0,
    hostId: e.hostId,
    createdAt: e.createdAt ?? Date.now(),
  });
  return { id: Number(info.lastInsertRowid) };
}

export const setEventMessage = async (id, messageId) => s.setMessage.run(messageId, id);
export const getEvent = async (id) => hydrate(await s.get.get(id));
export const getEventInGuild = async (id, guildId) => hydrate(await s.getInGuild.get(id, guildId));
export const upcomingEvents = async (guildId) => (await s.upcoming.all(guildId)).map(hydrate);
export const pastEvents = async (guildId, limit = 10) => (await s.past.all(guildId, limit)).map(hydrate);
export const scheduledEventCount = async (guildId) => Number((await s.countScheduled.get(guildId))?.n) || 0;
export const dueEndEvents = async (now) => (await s.dueEnd.all(now)).map(hydrate);
export const dueReminderEvents = async (now) => (await s.dueReminders.all(now)).map(hydrate);
/** Mark the reminder sent: true only for the one caller that may send it. */
export const claimEventReminder = async (id) => (await s.claimReminder.run(id)).changes === 1;
/** Move a scheduled event to 'ended' or 'cancelled': true only for the one caller that may. */
export const claimEventState = async (id, state) => (await s.claimState.run(state, id)).changes === 1;

/** Save the editable fields of an event (the posted message and role are not editable). */
export async function updateEventRow(id, e) {
  await s.update.run({
    id,
    title: e.title,
    description: e.description ?? '',
    location: e.location ?? '',
    imageUrl: e.imageUrl ?? '',
    startAt: e.startAt,
    endAt: e.endAt ?? null,
    timeZone: e.timeZone || 'UTC',
    capacity: e.capacity ?? null,
    reminderMinutes: e.reminderMinutes ?? 0,
    reminderSent: e.reminderSent ? 1 : 0,
  });
}

/** Remove an event and its sign-ups (a create whose message could not be posted). */
export async function deleteEvent(id) {
  await s.delParticipants.run(id);
  await s.del.run(id);
}

export const setEventParticipant = async (id, userId, status) =>
  s.setParticipant.run(id, userId, status, Date.now());
export const removeEventParticipant = async (id, userId) => s.removeParticipant.run(id, userId);
export const getEventParticipant = async (id, userId) => {
  const row = await s.getParticipant.get(id, userId);
  return row ? { userId: row.user_id, status: row.status } : null;
};
export const eventParticipantCount = async (id) => Number((await s.countAll.get(id))?.n) || 0;
export const eventStatusCount = async (id, status) => Number((await s.countByStatus.get(id, status))?.n) || 0;
/**
 * Is this member going to another upcoming event of the server that hands out the same role? Then
 * the role stays when they leave or the first event ends.
 */
export const holdsEventRoleElsewhere = async (guildId, roleId, userId, exceptEventId) =>
  Boolean(await s.roleElsewhere.get(userId, guildId, roleId, exceptEventId));

/** User ids with the given status ('join' or 'maybe'), in the order they signed up. */
export const eventParticipantIds = async (id, status) =>
  (await s.idsByStatus.all(id, status)).map((r) => r.user_id);

export async function clearGuildEvents(guildId) {
  await s.delGuildParticipants.run(guildId);
  await s.delGuild.run(guildId);
}
