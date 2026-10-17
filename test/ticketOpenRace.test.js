// A member who sends text and an image right after each other makes two DMs arrive together.
// Both found no open ticket and both tried to create one; the partial unique index refused the
// second, and its message was lost. The second now joins the ticket the first one made.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openOrCreateTicket } from '../src/db/tickets.js';

test('two DMs at once land in one ticket', async () => {
  const G = '900000000000000901';
  const U = '900000000000000902';
  const [a, b] = await Promise.all([openOrCreateTicket(G, U), openOrCreateTicket(G, U)]);
  assert.equal(a.ticket.id, b.ticket.id);
  assert.deepEqual([a.created, b.created].sort(), [false, true]);
});
