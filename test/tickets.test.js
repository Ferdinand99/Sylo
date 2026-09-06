import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
} from '../src/db/tickets.js';

const G = '333000000000000001';
const U = '444000000000000001';

test('createTicket opens a ticket; getOpenTicket finds it; second create is caller-guarded', async () => {
  assert.equal(await getOpenTicket(G, U), undefined);
  const ticket = await createTicket(G, U);
  assert.equal(ticket.guild_id, G);
  assert.equal(ticket.user_id, U);
  assert.equal(ticket.status, 'open');

  const open = await getOpenTicket(G, U);
  assert.equal(open.id, ticket.id);
  assert.equal((await getTicket(ticket.id)).id, ticket.id);
});

test('addTicketMessage stores + orders messages; touches last_at', async () => {
  const ticket = await createTicket(G, `${U}a`);
  await addTicketMessage(ticket.id, { authorId: U, authorKind: 'user', content: 'hello' });
  await addTicketMessage(ticket.id, {
    authorId: 'staff1',
    authorKind: 'staff',
    content: 'hi there',
    attachments: ['http://x/y.png'],
  });

  const rows = await ticketMessages(ticket.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].content, 'hello');
  assert.equal(rows[1].author_kind, 'staff');
  assert.deepEqual(rows[1].attachments, ['http://x/y.png']);

  const after = await ticketMessages(ticket.id, rows[0].id);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, rows[1].id);
});

test('closeTicket + markStaffSeen; openTicketCount/unreadTicketCount reflect state', async () => {
  const guild = `${G}-count`;
  const t1 = await createTicket(guild, 'u1');
  const t2 = await createTicket(guild, 'u2');
  await addTicketMessage(t1.id, { authorId: 'u1', authorKind: 'user', content: 'a' });
  await addTicketMessage(t2.id, { authorId: 'u2', authorKind: 'user', content: 'b' });

  assert.equal(await openTicketCount(guild), 2);
  assert.equal(await unreadTicketCount(guild), 2); // last_at > staff_seen_at (0) for both

  await markStaffSeen(t1.id);
  assert.equal(await unreadTicketCount(guild), 1);

  await closeTicket(t2.id, 'mod1');
  const closed = await getTicket(t2.id);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closed_by, 'mod1');
  assert.equal(await openTicketCount(guild), 1);

  const openList = await listTickets(guild, 'open', 10);
  assert.equal(openList.length, 1);
  assert.equal(openList[0].id, t1.id);
  assert.equal(openList[0].preview, 'a');

  const closedList = await listTickets(guild, 'closed', 10);
  assert.equal(closedList.length, 1);
  assert.equal(closedList[0].id, t2.id);
});
