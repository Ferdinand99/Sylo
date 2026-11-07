// The Quote board page of the new dashboard: settings, the searchable list and remove through
// /api/v2, with the stored rows and audit rows asserted. Who may call these routes, and the CSRF
// header, are in v2.permissions*.test.js and v2Quotes.auth.test.js.
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID, CH, ROLE } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule } from '../src/db/modules.js';
import { getQuoteByNumber, insertQuote, quoteCount } from '../src/db/quotes.js';

let app;
let api;
test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
});
test.after(() => app.close());

const json = async (res) => res.json();
let n = 0;
const make = (over = {}) => {
  n += 1;
  return insertQuote({
    guildId: GID,
    channelId: CH.general,
    messageId: `900000000000${String(n).padStart(6, '0')}`,
    authorId: '100000000000000555',
    authorName: 'Alice',
    body: `Quote ${n}`,
    messageAt: Date.UTC(2030, 0, 2),
    savedBy: '100000000000000556',
    publicSource: true,
    ...over,
  });
};

test('GET config: the defaults, the role list, the public path and no quotes yet', async () => {
  const res = await api.get('/modules/quote-board/config');
  assert.equal(res.status, 200);
  const data = await json(res);
  assert.deepEqual(data.config, {
    publicPage: false,
    saveMode: 'everyone',
    saveRoles: [],
    staffRoles: [],
  });
  assert.ok(data.roles.some((r) => r.id === ROLE.member));
  assert.equal(data.publicPath, `/quotes/${GID}`);
  assert.equal(data.total, 0);
  assert.deepEqual(data.quotes, []);
});

test('POST config stores the normalised settings and writes an audit row', async () => {
  const res = await api.post('/modules/quote-board/config', {
    publicPage: true,
    saveMode: 'roles',
    saveRoles: [ROLE.member, 'junk'],
    staffRoles: [ROLE.admin],
  });
  assert.equal(res.status, 200);
  const expected = {
    publicPage: true,
    saveMode: 'roles',
    saveRoles: [ROLE.member],
    staffRoles: [ROLE.admin],
  };
  assert.deepEqual((await json(res)).config, expected);
  assert.deepEqual((await getGuildModule(GID, 'quote-board')).config, expected);
  assert.deepEqual((await json(await api.get('/modules/quote-board/config'))).config, expected);
  const audit = await auditRows(GID, 'module:quote-board');
  assert.equal(audit[0].detail, 'public page on');
  assert.equal(audit[0].actor, 'Dashboard');

  await api.post('/modules/quote-board/config', { ...expected, publicPage: true, saveMode: 'everyone' });
  assert.equal((await auditRows(GID, 'module:quote-board'))[0].detail, 'settings saved');
  await api.post('/modules/quote-board/config', { publicPage: false });
  assert.equal((await auditRows(GID, 'module:quote-board'))[0].detail, 'public page off');
});

test('the public page switch is off unless the body says true', async () => {
  for (const publicPage of ['true', 1, 'on', null]) {
    await api.post('/modules/quote-board/config', { publicPage });
    assert.equal((await getGuildModule(GID, 'quote-board')).config.publicPage, false, String(publicPage));
  }
});

test('the list shows the newest first with the fields the page needs, and the jump link', async () => {
  const a = await make({ body: 'First one', attachments: 2, channelId: CH.general });
  await make({ body: 'Second one', publicSource: false });
  const res = await json(await api.get('/modules/quote-board/list'));
  assert.equal(res.total, 2);
  assert.deepEqual(
    res.quotes.map((q) => q.number),
    [2, 1]
  );
  const first = res.quotes[1];
  assert.equal(first.number, a.number);
  assert.equal(first.text, 'First one');
  assert.equal(first.author, 'Alice');
  assert.equal(first.authorId, '100000000000000555');
  assert.equal(first.savedBy, '100000000000000556');
  assert.equal(first.attachments, 2);
  assert.equal(first.messageAt, Date.UTC(2030, 0, 2));
  assert.equal(first.channelId, CH.general);
  assert.equal(first.publicSource, true);
  assert.equal(res.quotes[0].publicSource, false);
  assert.match(first.url, new RegExp(`^https://discord.com/channels/${GID}/${CH.general}/\\d+$`));
  assert.equal((await json(await api.get('/modules/quote-board/config'))).quotes.length, 2);
});

test('the list is searched by text or author name, case-insensitively, and by nothing else', async () => {
  await make({ body: 'The pineapple incident', authorName: 'Zed' });
  await make({ body: 'unrelated', authorName: 'Pineapple Pete' });
  const numbers = async (q) =>
    (await json(await api.get(`/modules/quote-board/list?q=${encodeURIComponent(q)}`))).quotes.map(
      (x) => x.number
    );
  assert.deepEqual(await numbers('PINEAPPLE'), [4, 3]);
  assert.deepEqual(await numbers('first'), [1]);
  assert.deepEqual(await numbers('nothing like this'), []);
  assert.deepEqual(await numbers(''), [4, 3, 2, 1]);
  assert.deepEqual(await numbers('%'), [], 'a percent sign is not a wildcard');
  const searched = await json(await api.get('/modules/quote-board/list?q=pineapple'));
  assert.equal(searched.total, 4, 'total stays the size of the whole board');
});

test('the search query is cut to 100 characters', async () => {
  await make({ body: 'b'.repeat(100) });
  const res = await json(await api.get(`/modules/quote-board/list?q=${'b'.repeat(500)}`));
  assert.equal(res.quotes.length, 1);
});

test('the list shows at most 100 quotes', async () => {
  for (let i = 0; i < 101; i += 1) await make({ body: `bulk ${i}` });
  const res = await json(await api.get('/modules/quote-board/list'));
  assert.equal(res.quotes.length, 100);
  assert.equal(res.total, await quoteCount(GID));
  assert.ok(res.total > 100);
});

test('remove deletes the quote, writes an audit row, and the number is not given out again', async () => {
  const { number } = await make({ body: 'Remove me' });
  const before = await quoteCount(GID);
  const res = await api.post(`/modules/quote-board/${number}/delete`);
  assert.equal(res.status, 200);
  assert.equal(await quoteCount(GID), before - 1);
  assert.equal(await getQuoteByNumber(GID, number), null);
  assert.equal((await auditRows(GID, 'module:quote-board'))[0].detail, `removed quote #${number}`);
  assert.equal((await make()).number, number + 1);
});

test('a second remove, a missing number and a junk number are 404 and change nothing', async () => {
  const { number } = await make({ body: 'Once' });
  assert.equal((await api.post(`/modules/quote-board/${number}/delete`)).status, 200);
  const count = await quoteCount(GID);
  for (const path of [`/modules/quote-board/${number}/delete`, '/modules/quote-board/99999/delete']) {
    const res = await api.post(path);
    assert.equal(res.status, 404, path);
    assert.match((await json(res)).error, /No such quote/);
  }
  for (const junk of ['0', '-1', 'abc', '1.5']) {
    assert.equal((await api.post(`/modules/quote-board/${junk}/delete`)).status, 404, junk);
  }
  assert.equal(await quoteCount(GID), count);
});
