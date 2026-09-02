// Ticket (modmail) storage.
import { db } from './index.js';

const openByUserStmt = db.prepare(
  "SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open'"
);
const getStmt = db.prepare('SELECT * FROM tickets WHERE id = ?');
const createStmt = db.prepare(`
  INSERT INTO tickets (guild_id, user_id, status, created_at, last_at)
  VALUES (@guildId, @userId, 'open', @now, @now)
`);
const touchStmt = db.prepare('UPDATE tickets SET last_at = ? WHERE id = ?');
const closeStmt = db.prepare(
  "UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?"
);
const seenStmt = db.prepare('UPDATE tickets SET staff_seen_at = ? WHERE id = ?');
const listStmt = db.prepare(
  'SELECT * FROM tickets WHERE guild_id = ? AND status = ? ORDER BY last_at DESC LIMIT ?'
);
const openCountStmt = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND status = 'open'");
const unreadCountStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND status = 'open' AND last_at > staff_seen_at"
);

const addMsgStmt = db.prepare(`
  INSERT INTO ticket_messages (ticket_id, author_id, author_kind, content, attachments, delivered, created_at)
  VALUES (@ticketId, @authorId, @authorKind, @content, @attachments, @delivered, @now)
`);
const msgsStmt = db.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at, id');
const msgsAfterStmt = db.prepare(
  'SELECT * FROM ticket_messages WHERE ticket_id = ? AND id > ? ORDER BY created_at, id'
);
const lastPreviewStmt = db.prepare(
  'SELECT content, author_kind FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
);

/** The user's open ticket in a guild, or undefined. */
export function getOpenTicket(guildId, userId) {
  return openByUserStmt.get(guildId, userId);
}

export function getTicket(id) {
  return getStmt.get(id);
}

/** Create an open ticket (caller must ensure there isn't one already). */
export function createTicket(guildId, userId) {
  const now = Date.now();
  const info = createStmt.run({ guildId, userId, now });
  return getStmt.get(Number(info.lastInsertRowid));
}

/**
 * @param {number} ticketId
 * @param {{ authorId: string, authorKind: 'user'|'staff'|'system', content?: string, attachments?: string[], delivered?: boolean }} m
 */
export function addTicketMessage(ticketId, m) {
  const now = Date.now();
  addMsgStmt.run({
    ticketId,
    authorId: m.authorId,
    authorKind: m.authorKind,
    content: m.content ?? '',
    attachments: JSON.stringify(m.attachments ?? []),
    delivered: m.delivered === false ? 0 : 1,
    now,
  });
  touchStmt.run(now, ticketId);
}

export function closeTicket(ticketId, staffUserId) {
  closeStmt.run(Date.now(), staffUserId ?? null, ticketId);
}

export function markStaffSeen(ticketId) {
  seenStmt.run(Date.now(), ticketId);
}

export function listTickets(guildId, status = 'open', limit = 100) {
  return listStmt.all(guildId, status, limit).map((t) => {
    const p = lastPreviewStmt.get(t.id);
    return { ...t, preview: p ? p.content.slice(0, 120) : '', previewKind: p?.author_kind ?? null };
  });
}

export function ticketMessages(ticketId, afterId = 0) {
  const rows = afterId ? msgsAfterStmt.all(ticketId, afterId) : msgsStmt.all(ticketId);
  return rows.map((r) => ({ ...r, attachments: safeArr(r.attachments) }));
}

export function openTicketCount(guildId) {
  return openCountStmt.get(guildId).n;
}
export function unreadTicketCount(guildId) {
  return unreadCountStmt.get(guildId).n;
}

function safeArr(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
