// Ticket (modmail) storage.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS tickets (
    id            SERIAL PRIMARY KEY,
    guild_id      TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'open',
    created_at    BIGINT NOT NULL,
    last_at       BIGINT NOT NULL,
    closed_at     BIGINT,
    closed_by     TEXT,
    staff_seen_at BIGINT NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_guild_status ON tickets (guild_id, status, last_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_open_user ON tickets (guild_id, user_id) WHERE status = 'open';

  CREATE TABLE IF NOT EXISTS ticket_messages (
    id          SERIAL PRIMARY KEY,
    ticket_id   INTEGER NOT NULL,
    author_id   TEXT NOT NULL,
    author_kind TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    delivered   INTEGER NOT NULL DEFAULT 1,
    created_at  BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages (ticket_id, created_at);
`);

const openByUserStmt = prepare(
  "SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open'"
);
const getStmt = prepare('SELECT * FROM tickets WHERE id = ?');
const createStmt = prepare(
  `
  INSERT INTO tickets (guild_id, user_id, status, created_at, last_at)
  VALUES (@guildId, @userId, 'open', @now, @now)
`,
  { returningId: true }
);
const touchStmt = prepare('UPDATE tickets SET last_at = ? WHERE id = ?');
const closeStmt = prepare("UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?");
const seenStmt = prepare('UPDATE tickets SET staff_seen_at = ? WHERE id = ?');
const listStmt = prepare(
  'SELECT * FROM tickets WHERE guild_id = ? AND status = ? ORDER BY last_at DESC LIMIT ?'
);
const openCountStmt = prepare("SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND status = 'open'");
const unreadCountStmt = prepare(
  "SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND status = 'open' AND last_at > staff_seen_at"
);

const addMsgStmt = prepare(`
  INSERT INTO ticket_messages (ticket_id, author_id, author_kind, content, attachments, delivered, created_at)
  VALUES (@ticketId, @authorId, @authorKind, @content, @attachments, @delivered, @now)
`);
const msgsStmt = prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at, id');
const msgsAfterStmt = prepare(
  'SELECT * FROM ticket_messages WHERE ticket_id = ? AND id > ? ORDER BY created_at, id'
);
const lastPreviewStmt = prepare(
  'SELECT content, author_kind FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
);

/** The user's open ticket in a guild, or undefined. */
export async function getOpenTicket(guildId, userId) {
  return openByUserStmt.get(guildId, userId);
}

export async function getTicket(id) {
  return getStmt.get(id);
}

/** Create an open ticket (caller must ensure there isn't one already). */
export async function createTicket(guildId, userId) {
  const now = Date.now();
  const info = await createStmt.run({ guildId, userId, now });
  return getStmt.get(Number(info.lastInsertRowid));
}

/**
 * @param {number} ticketId
 * @param {{ authorId: string, authorKind: 'user'|'staff'|'system', content?: string, attachments?: string[], delivered?: boolean }} m
 */
export async function addTicketMessage(ticketId, m) {
  const now = Date.now();
  await addMsgStmt.run({
    ticketId,
    authorId: m.authorId,
    authorKind: m.authorKind,
    content: m.content ?? '',
    attachments: JSON.stringify(m.attachments ?? []),
    delivered: m.delivered === false ? 0 : 1,
    now,
  });
  await touchStmt.run(now, ticketId);
}

export async function closeTicket(ticketId, staffUserId) {
  await closeStmt.run(Date.now(), staffUserId ?? null, ticketId);
}

export async function markStaffSeen(ticketId) {
  await seenStmt.run(Date.now(), ticketId);
}

export async function listTickets(guildId, status = 'open', limit = 100) {
  const rows = await listStmt.all(guildId, status, limit);
  const out = [];
  for (const t of rows) {
    const p = await lastPreviewStmt.get(t.id);
    out.push({ ...t, preview: p ? p.content.slice(0, 120) : '', previewKind: p?.author_kind ?? null });
  }
  return out;
}

export async function ticketMessages(ticketId, afterId = 0) {
  const rows = afterId ? await msgsAfterStmt.all(ticketId, afterId) : await msgsStmt.all(ticketId);
  return rows.map((r) => ({ ...r, attachments: safeArr(r.attachments) }));
}

export async function openTicketCount(guildId) {
  return Number((await openCountStmt.get(guildId))?.n) || 0;
}
export async function unreadTicketCount(guildId) {
  return Number((await unreadCountStmt.get(guildId))?.n) || 0;
}

function safeArr(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
