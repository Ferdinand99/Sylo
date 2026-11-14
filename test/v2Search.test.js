// The command palette's lookup of an inbox item by number: the query it reads, what it finds, that a
// number of another server is never found, who may ask and the rate limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, OTHER_D_GUILD, startOAuthApp } from './helpers/oauthApp.js';
import { anonymous, session } from './helpers/v2Guarded.js';

await startOAuthApp();

const { parseInboxQuery } = await import('../src/web/routes/v2Search.js');
const { createTicket } = await import('../src/db/tickets.js');
const { createSuggestion } = await import('../src/db/suggestions.js');
const { createAppeal } = await import('../src/db/appeals.js');
const { insertForm, insertSubmission } = await import('../src/db/applications.js');

const search = (who, guildId, q) => who.get(`/guilds/${guildId}/search/inbox?q=${encodeURIComponent(q)}`);

test('parseInboxQuery reads a number with an optional kind and nothing else', () => {
  assert.deepEqual(parseInboxQuery('12'), { kind: null, number: 12 });
  assert.deepEqual(parseInboxQuery(' #12 '), { kind: null, number: 12 });
  assert.deepEqual(parseInboxQuery('Ticket #12'), { kind: 'ticket', number: 12 });
  assert.deepEqual(parseInboxQuery('suggestion 5'), { kind: 'suggestion', number: 5 });
  assert.deepEqual(parseInboxQuery('applications3'), { kind: 'application', number: 3 });
  for (const bad of [
    '',
    'ticket',
    '0',
    '-3',
    '1.5',
    'ticket #x',
    '12 34',
    '1234567890',
    'drop table',
    undefined,
  ])
    assert.equal(parseInboxQuery(bad), null, String(bad));
});

test('the admin finds the items of the server by number, and only those', async () => {
  const admin = await session();
  const ticket = await createTicket(D_GUILD, '800000000000000042');
  const suggestion = await createSuggestion({
    guildId: D_GUILD,
    channelId: '1',
    authorId: 'a',
    body: 'Idea',
  });
  const appealId = await createAppeal(D_GUILD, {
    userId: '800000000000000043',
    answers: [{ q: 'Why', a: 'Sorry' }],
  });

  const t = await (await search(admin, D_GUILD, `ticket ${ticket.id}`)).json();
  assert.deepEqual(t.items, [
    {
      kind: 'ticket',
      number: ticket.id,
      status: 'open',
      href: `/guilds/${D_GUILD}/tickets/${ticket.id}`,
    },
  ]);
  const s = await (await search(admin, D_GUILD, `suggestion #${suggestion.number}`)).json();
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].href, `/guilds/${D_GUILD}/m/suggestions`);
  const a = await (await search(admin, D_GUILD, `appeal ${appealId}`)).json();
  assert.equal(a.items[0].kind, 'appeal');
  // A bare number asks every kind.
  const bare = await (await search(admin, D_GUILD, String(ticket.id))).json();
  assert.ok(bare.items.some((i) => i.kind === 'ticket'));
  // No text of the item leaves the server.
  assert.deepEqual(Object.keys(t.items[0]).sort(), ['href', 'kind', 'number', 'status']);
  // Nothing found is an empty list, not an error.
  assert.deepEqual(await (await search(admin, D_GUILD, 'ticket 999999')).json(), { items: [] });
  assert.deepEqual(await (await search(admin, D_GUILD, 'banana')).json(), { items: [] });
});

test('a number of another server is not found, whatever the kind', async () => {
  const admin = await session();
  // The other server gets items the home server does not have: suggestion numbers count per server, so the
  // third one exists only there; ticket, appeal and application ids are global, so any of them is foreign.
  const foreignTicket = await createTicket(OTHER_D_GUILD, '800000000000000077');
  let foreignSuggestion;
  for (let i = 0; i < 3; i += 1)
    foreignSuggestion = await createSuggestion({
      guildId: OTHER_D_GUILD,
      channelId: '1',
      authorId: 'a',
      body: 'Not yours',
    });
  const foreignAppeal = await createAppeal(OTHER_D_GUILD, {
    userId: '800000000000000078',
    answers: [{ q: 'Why', a: 'Sorry' }],
  });
  const formId = await insertForm({
    guildId: OTHER_D_GUILD,
    name: 'Staff',
    enabled: true,
    fillMode: 'both',
    config: {},
  });
  const foreignApplication = await insertSubmission({
    guildId: OTHER_D_GUILD,
    formId,
    formName: 'Staff',
    userId: '800000000000000079',
    source: 'web',
    questions: [],
    answers: {},
  });
  assert.ok(foreignSuggestion.number >= 3);

  // The same numbers are found when the server that owns them asks (so the lookups work at all)...
  const owner = await session({ guilds: [{ id: OTHER_D_GUILD, owner: true, permissions: '0' }] });
  const found = async (who, guildId, q) => (await (await search(who, guildId, q)).json()).items;
  assert.equal((await found(owner, OTHER_D_GUILD, `ticket ${foreignTicket.id}`)).length, 1);
  assert.equal((await found(owner, OTHER_D_GUILD, `suggestion ${foreignSuggestion.number}`)).length, 1);
  assert.equal((await found(owner, OTHER_D_GUILD, `appeal ${foreignAppeal}`)).length, 1);
  assert.equal((await found(owner, OTHER_D_GUILD, `application ${foreignApplication}`)).length, 1);

  // ...and nothing when the home server asks.
  assert.deepEqual(await found(admin, D_GUILD, `ticket ${foreignTicket.id}`), []);
  assert.deepEqual(await found(admin, D_GUILD, `suggestion ${foreignSuggestion.number}`), []);
  assert.deepEqual(await found(admin, D_GUILD, `appeal ${foreignAppeal}`), []);
  assert.deepEqual(await found(admin, D_GUILD, `application ${foreignApplication}`), []);
  // A bare number asks every kind and still finds nothing foreign.
  for (const n of [foreignTicket.id, foreignAppeal, foreignApplication]) {
    const items = await found(admin, D_GUILD, String(n));
    assert.ok(
      items.every((i) => i.href.startsWith(`/guilds/${D_GUILD}/`)),
      `#${n}`
    );
  }
});

test('someone who does not manage the server, the admin of another server and a signed-out caller are refused', async () => {
  const member = await session({
    guilds: [
      { id: D_GUILD, owner: false, permissions: '0' },
      { id: OTHER_D_GUILD, owner: false, permissions: '0' },
    ],
  });
  assert.equal((await search(member, D_GUILD, 'ticket 1')).status, 403);
  const admin = await session(); // owner of D_GUILD only
  assert.equal((await search(admin, OTHER_D_GUILD, 'ticket 1')).status, 403);
  const { status } = await search(anonymous(), D_GUILD, 'ticket 1');
  assert.ok(status === 401 || status === 403, `-> ${status}`);
});

test('a flood of searches is limited', async () => {
  const admin = await session();
  let limited = 0;
  for (let i = 0; i < 70; i += 1) if ((await search(admin, D_GUILD, 'ticket 1')).status === 429) limited += 1;
  assert.ok(limited > 0, 'the 61st search in a minute is refused');
});

test('a flood of member searches is limited too', async () => {
  const admin = await session();
  let limited = 0;
  for (let i = 0; i < 130; i += 1)
    if ((await admin.get(`/guilds/${D_GUILD}/members/search?q=al`)).status === 429) limited += 1;
  assert.ok(limited > 0, 'the 121st member search in a minute is refused');
});
