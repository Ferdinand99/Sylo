// The Suggestions page of the new dashboard: settings, the filterable list, staff decisions and
// delete through /api/v2, with the side effects (stored rows, DMs, the log channel, audit rows)
// asserted. Who may call these routes, and the CSRF header, are in v2.permissions*.test.js and
// v2Suggestions.auth.test.js.
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID, CH, ROLE } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import {
  createSuggestion,
  decideSuggestion,
  getSuggestionByNumber,
  setSuggestionMessage,
  setSuggestionVote,
  suggestionCount,
} from '../src/db/suggestions.js';

let app;
let api;
test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
});
test.after(() => app.close());

const json = async (res) => res.json();
const make = (over = {}) =>
  createSuggestion({
    guildId: GID,
    channelId: CH.general,
    authorId: '100000000000000555',
    body: 'Idea',
    ...over,
  });

test('GET config: the defaults, the channel and role lists, no suggestions yet', async () => {
  const res = await api.get('/modules/suggestions/config');
  assert.equal(res.status, 200);
  const data = await json(res);
  assert.deepEqual(data.config, {
    channel: '',
    logChannel: '',
    anonymous: false,
    dmAuthor: true,
    messagesToSuggestions: false,
    cooldownSeconds: 60,
    staffRoles: [],
  });
  assert.ok(data.channels.some((c) => c.id === CH.general));
  assert.ok(data.roles.some((r) => r.id === ROLE.member));
  assert.deepEqual(data.suggestions, []);
});

test('POST config stores the normalised settings and writes an audit row', async () => {
  const res = await api.post('/modules/suggestions/config', {
    channel: CH.announce,
    logChannel: CH.bots,
    anonymous: true,
    dmAuthor: false,
    messagesToSuggestions: true,
    cooldownSeconds: 99999,
    staffRoles: [ROLE.admin, 'junk'],
  });
  assert.equal(res.status, 200);
  const stored = (await getGuildModule(GID, 'suggestions')).config;
  assert.deepEqual(stored, {
    channel: CH.announce,
    logChannel: CH.bots,
    anonymous: true,
    dmAuthor: false,
    messagesToSuggestions: true,
    cooldownSeconds: 3600,
    staffRoles: [ROLE.admin],
  });
  assert.deepEqual((await json(await api.get('/modules/suggestions/config'))).config, stored);
  const audit = (await auditRows(GID, 'module:suggestions'))[0];
  assert.equal(audit.detail, 'settings saved');
  assert.equal(audit.actor, 'Dashboard');
  await api.post('/modules/suggestions/config', {});
});

test('the list carries votes and the author (staff see who wrote an anonymous one); filters and sorting work', async () => {
  const a = await make({ body: 'First', anonymous: true });
  const b = await make({ body: 'Second', title: 'Titled' });
  const c = await make({ body: 'Third' });
  await setSuggestionVote(a.id, 'u1', 1);
  await setSuggestionVote(a.id, 'u2', 1);
  await setSuggestionVote(b.id, 'u1', -1);
  await decideSuggestion(b.id, { status: 'denied', reason: 'No' });
  await decideSuggestion(c.id, { status: 'considering' });

  const all = (await json(await api.get('/modules/suggestions/list'))).suggestions;
  assert.deepEqual(
    all.map((s) => s.number),
    [3, 2, 1]
  );
  const first = all.find((s) => s.number === 1);
  assert.equal(first.text, 'First');
  assert.equal(first.up, 2);
  assert.equal(first.anonymous, true);
  assert.equal(first.authorId, '100000000000000555');
  assert.equal(first.author, '100000000000000555');
  const second = all.find((s) => s.number === 2);
  assert.equal(second.title, 'Titled');
  assert.equal(second.status, 'denied');
  assert.equal(second.reason, 'No');
  assert.equal(second.down, 1);

  const numbers = async (query) =>
    (await json(await api.get(`/modules/suggestions/list?${query}`))).suggestions.map((s) => s.number);
  assert.deepEqual(await numbers('status=open'), [3, 1], 'open covers considering');
  assert.deepEqual(await numbers('status=denied'), [2]);
  assert.deepEqual(await numbers('status=approved'), []);
  assert.deepEqual(await numbers('sort=top'), [1, 3, 2], 'best net votes first');
  assert.deepEqual(await numbers('status=open&sort=top'), [1, 3]);
  assert.deepEqual(
    await numbers('status=nonsense&sort=sideways'),
    [3, 2, 1],
    'unknown filters mean "all, newest"'
  );
  assert.deepEqual((await json(await api.get('/modules/suggestions/config'))).suggestions.length, 3);
});

test('deciding needs the module on, a known action and an existing suggestion', async () => {
  await setGuildModule(GID, 'suggestions', { enabled: false });
  const off = await api.post('/modules/suggestions/1/decision', { action: 'approve' });
  assert.equal(off.status, 400);
  assert.match((await json(off)).error, /Turn the Suggestions module on/);
  await setGuildModule(GID, 'suggestions', { enabled: true, config: {} });

  const bad = await api.post('/modules/suggestions/1/decision', { action: 'explode' });
  assert.equal(bad.status, 400);
  assert.match((await json(bad)).error, /approve, deny, implement, consider/);
  assert.equal((await api.post('/modules/suggestions/1/decision', {})).status, 400);

  const missing = await api.post('/modules/suggestions/999/decision', { action: 'approve' });
  assert.equal(missing.status, 404);
  assert.match((await json(missing)).error, /No such suggestion/);
  assert.equal((await api.post('/modules/suggestions/abc/decision', { action: 'approve' })).status, 404);
  assert.equal((await getSuggestionByNumber(GID, 1)).status, 'open');
});

test('approving stores the status and reason, DMs the author and writes an audit row', async () => {
  app.sink.dms.length = 0;
  const res = await api.post('/modules/suggestions/1/decision', { action: 'approve', reason: 'Good one' });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.suggestion.status, 'approved');
  assert.equal(body.suggestion.reason, 'Good one');
  assert.equal(body.dm, true);
  assert.equal(body.moved, false);

  const row = await getSuggestionByNumber(GID, 1);
  assert.equal(row.status, 'approved');
  assert.equal(row.reason, 'Good one');
  assert.ok(row.decided_at > 0);
  assert.equal(app.sink.dms.length, 1);
  assert.equal(app.sink.dms[0].id, '100000000000000555');
  assert.match(app.sink.dms[0].payload.content, /suggestion \*\*#1\*\*.*approved/);
  assert.match(app.sink.dms[0].payload.content, /Good one/);
  assert.ok((await auditRows(GID, 'module:suggestions')).some((a) => a.detail === 'approved #1'));
});

test('the reason is cut at 500 characters; each of the four actions works', async () => {
  const expectations = {
    approve: 'approved',
    deny: 'denied',
    implement: 'implemented',
    consider: 'considering',
  };
  for (const [action, status] of Object.entries(expectations)) {
    const res = await api.post('/modules/suggestions/3/decision', { action, reason: 'r'.repeat(600) });
    assert.equal(res.status, 200, action);
    const { suggestion } = await json(res);
    assert.equal(suggestion.status, status);
    assert.equal(suggestion.reason.length, 500);
  }
});

test('with the DM setting off nobody is messaged', async () => {
  await setGuildModule(GID, 'suggestions', { enabled: true, config: { dmAuthor: false } });
  app.sink.dms.length = 0;
  const res = await json(await api.post('/modules/suggestions/2/decision', { action: 'implement' }));
  assert.equal(res.dm, false);
  assert.equal(app.sink.dms.length, 0);
  await setGuildModule(GID, 'suggestions', { enabled: true, config: {} });
});

test('with a log channel a final decision reposts the suggestion there', async () => {
  await setGuildModule(GID, 'suggestions', { enabled: true, config: { logChannel: CH.bots } });
  const { id, number } = await make({ body: 'Move me' });
  await setSuggestionMessage(id, CH.general, 'original-message');
  app.sink.messages.length = 0;
  const res = await json(
    await api.post(`/modules/suggestions/${number}/decision`, { action: 'deny', reason: 'No' })
  );
  assert.equal(res.moved, true);
  assert.equal(app.sink.messages.length, 1);
  assert.equal(app.sink.messages[0].channel, CH.bots);
  const embed = app.sink.messages[0].payload.embeds[0].toJSON();
  assert.equal(embed.description, 'Move me');
  assert.equal(app.sink.messages[0].payload.components.length, 0);
  const row = await getSuggestionByNumber(GID, number);
  assert.equal(row.channel_id, CH.bots);
  assert.notEqual(row.message_id, 'original-message');
  assert.equal(res.suggestion.channelId, CH.bots);

  // "considering" does not move anything
  const other = await make({ body: 'Stay' });
  app.sink.messages.length = 0;
  const stay = await json(
    await api.post(`/modules/suggestions/${other.number}/decision`, { action: 'consider' })
  );
  assert.equal(stay.moved, false);
  assert.equal(app.sink.messages.length, 0);
  await setGuildModule(GID, 'suggestions', { enabled: true, config: {} });
});

test('delete removes the suggestion and its votes; a second delete and a missing one are 404', async () => {
  const { id, number } = await make({ body: 'Delete me' });
  await setSuggestionVote(id, 'u1', 1);
  const before = await suggestionCount(GID);
  const res = await api.post(`/modules/suggestions/${number}/delete`);
  assert.equal(res.status, 200);
  assert.equal(await suggestionCount(GID), before - 1);
  assert.equal(await getSuggestionByNumber(GID, number), null);
  assert.ok((await auditRows(GID, 'module:suggestions')).some((a) => a.detail === `deleted #${number}`));
  assert.equal((await api.post(`/modules/suggestions/${number}/delete`)).status, 404);
  assert.equal((await api.post('/modules/suggestions/0/delete')).status, 404);
});
