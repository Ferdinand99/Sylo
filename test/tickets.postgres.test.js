// Proves the driver shim's Postgres branch for tickets + ticket_messages: two
// SERIAL surrogate PKs (tickets.id read back via RETURNING id; ticket_messages.id
// never read back, so no returningId there), BIGINT timestamp columns, and the
// same partial-unique-index shape as appeals.js (one open ticket per
// guild+user) — though unlike appeals.js, createTicket() doesn't catch a
// violation itself (callers are expected to check getOpenTicket() first), so
// there's no cross-dialect error-message concern here.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'tickets against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      getOpenTicket,
      getTicket,
      createTicket,
      addTicketMessage,
      closeTicket,
      markStaffSeen,
      listTickets,
      ticketMessages,
      openTicketCount,
      unreadTicketCount,
    } = await import('../src/db/tickets.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-tickets-${Date.now()}`;

    await t.test('createTicket returns a real id via RETURNING id; getOpenTicket finds it', async () => {
      assert.equal(await getOpenTicket(G, 'u1'), undefined);
      const ticket = await createTicket(G, 'u1');
      assert.ok(Number.isInteger(ticket.id) && ticket.id > 0);
      assert.equal((await getOpenTicket(G, 'u1')).id, ticket.id);
      assert.equal((await getTicket(ticket.id)).id, ticket.id);
    });

    await t.test('addTicketMessage stores + orders messages; ticketMessages(after) filters', async () => {
      const ticket = await createTicket(G, 'u2');
      await addTicketMessage(ticket.id, { authorId: 'u2', authorKind: 'user', content: 'hello' });
      await addTicketMessage(ticket.id, {
        authorId: 'staff1',
        authorKind: 'staff',
        content: 'hi',
        attachments: ['http://x/y.png'],
      });
      const rows = await ticketMessages(ticket.id);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows[1].attachments, ['http://x/y.png']);
      const after = await ticketMessages(ticket.id, rows[0].id);
      assert.equal(after.length, 1);
    });

    await t.test('closeTicket, markStaffSeen, openTicketCount/unreadTicketCount, listTickets', async () => {
      const guild = `${G}-count`;
      const t1 = await createTicket(guild, 'u3');
      const t2 = await createTicket(guild, 'u4');
      await addTicketMessage(t1.id, { authorId: 'u3', authorKind: 'user', content: 'a' });
      await addTicketMessage(t2.id, { authorId: 'u4', authorKind: 'user', content: 'b' });

      assert.equal(await openTicketCount(guild), 2);
      assert.equal(await unreadTicketCount(guild), 2);

      await markStaffSeen(t1.id);
      assert.equal(await unreadTicketCount(guild), 1);

      await closeTicket(t2.id, 'mod1');
      const closed = await getTicket(t2.id);
      assert.equal(closed.status, 'closed');
      assert.equal(closed.closed_by, 'mod1');
      assert.equal(await openTicketCount(guild), 1);

      const openList = await listTickets(guild, 'open', 10);
      assert.ok(openList.some((r) => r.id === t1.id));
      const closedList = await listTickets(guild, 'closed', 10);
      assert.ok(closedList.some((r) => r.id === t2.id));
    });
  }
);
