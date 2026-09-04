import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { setGuildModule } from '../src/db/modules.js';
import { sweepRetention } from '../src/db/retention.js';

const G1 = '700000000000000001'; // retention configured
const G2 = '700000000000000002'; // retention 0 / unset — keep forever
const DAY = 86_400_000;

function ticket(guildId, { status, ageDays, msgs = 1 }) {
  const at = Date.now() - ageDays * DAY;
  const closedAt = status === 'closed' ? at : null;
  const r = db
    .prepare(
      'INSERT INTO tickets (guild_id, user_id, status, created_at, last_at, closed_at) VALUES (?,?,?,?,?,?)'
    )
    .run(guildId, 'u1', status, at, at, closedAt);
  for (let i = 0; i < msgs; i++) {
    db.prepare(
      'INSERT INTO ticket_messages (ticket_id, author_id, author_kind, content, created_at) VALUES (?,?,?,?,?)'
    ).run(r.lastInsertRowid, 'u1', 'user', 'hi', at);
  }
  return r.lastInsertRowid;
}

function kase(guildId, caseNumber, { active, ageDays, action = 'warn' }) {
  db.prepare(
    'INSERT INTO infractions (guild_id, case_number, user_id, moderator_id, action, reason, active, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(guildId, caseNumber, 'u1', 'mod', action, 'x', active ? 1 : 0, Date.now() - ageDays * DAY);
}

const ticketExists = (id) => !!db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(id);
const msgCount = (id) =>
  db.prepare('SELECT COUNT(*) AS n FROM ticket_messages WHERE ticket_id = ?').get(id).n;
const caseExists = (g, n) =>
  !!db.prepare('SELECT 1 FROM infractions WHERE guild_id = ? AND case_number = ?').get(g, n);

test('sweepRetention prunes only past-cutoff closed tickets / inactive cases', () => {
  setGuildModule(G1, 'tickets', { enabled: true, config: { transcriptRetentionDays: 30 } });
  setGuildModule(G1, 'moderation', { enabled: true, config: { infractionRetentionDays: 30 } });
  setGuildModule(G2, 'tickets', { enabled: true, config: { transcriptRetentionDays: 0 } });
  setGuildModule(G2, 'moderation', { enabled: true, config: {} });

  const oldClosed = ticket(G1, { status: 'closed', ageDays: 60, msgs: 3 });
  const recentClosed = ticket(G1, { status: 'closed', ageDays: 5 });
  const oldOpen = ticket(G1, { status: 'open', ageDays: 90 });
  const g2OldClosed = ticket(G2, { status: 'closed', ageDays: 400, msgs: 2 });

  kase(G1, 1, { active: false, ageDays: 60 }); // old + inactive -> pruned
  kase(G1, 2, { active: false, ageDays: 5 }); // recent inactive -> kept
  kase(G1, 3, { active: true, ageDays: 400 }); // old but active -> kept
  kase(G2, 1, { active: false, ageDays: 400 }); // other guild, no window -> kept

  const r = sweepRetention(Date.now());
  assert.deepEqual(r, { closedTickets: 1, ticketMessages: 3, inactiveCases: 1 });

  assert.equal(ticketExists(oldClosed), false);
  assert.equal(msgCount(oldClosed), 0);
  assert.equal(ticketExists(recentClosed), true);
  assert.equal(ticketExists(oldOpen), true, 'open tickets are never pruned');
  assert.equal(ticketExists(g2OldClosed), true, 'retention 0 keeps everything');

  assert.equal(caseExists(G1, 1), false);
  assert.equal(caseExists(G1, 2), true);
  assert.equal(caseExists(G1, 3), true, 'active cases are never pruned');
  assert.equal(caseExists(G2, 1), true, 'guild with no window untouched');
});

test('sweepRetention is a no-op with nothing left to prune', () => {
  assert.deepEqual(sweepRetention(Date.now()), {
    closedTickets: 0,
    ticketMessages: 0,
    inactiveCases: 0,
  });
});
