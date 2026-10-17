// The new dashboard's and the Sylo app's ticket JSON carries real times (epoch milliseconds)
// next to the worded "ago", so the app can group and label a conversation like Messages does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { createTicket, addTicketMessage } = await import('../src/db/tickets.js');

test('the ticket list and a ticket carry epoch-millisecond times', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const before = Date.now();
  const ticket = await createTicket(D_GUILD, '800000000000000001');
  await addTicketMessage(ticket.id, { authorId: '800000000000000001', authorKind: 'user', content: 'Help' });

  const res = await b.get(`/api/v2/guilds/${D_GUILD}/tickets`);
  const list = await res.json();
  assert.equal(res.status, 200, JSON.stringify(list));
  const row = list.open.find((t) => t.id === ticket.id);
  assert.ok(row, 'the ticket is listed');
  assert.equal(typeof row.lastAt, 'number');
  assert.ok(row.lastAt >= before);

  const thread = await (await b.get(`/api/v2/guilds/${D_GUILD}/tickets/${ticket.id}`)).json();
  assert.equal(typeof thread.ticket.openedAt, 'number');
  assert.ok(thread.ticket.openedAt >= before);
  assert.equal(thread.messages.length, 1);
  assert.equal(typeof thread.messages[0].at, 'number');
  assert.ok(thread.messages[0].at >= before);

  const since = await (await b.get(`/api/v2/guilds/${D_GUILD}/tickets/${ticket.id}/messages?after=0`)).json();
  assert.equal(typeof since.messages[0].at, 'number');
});
