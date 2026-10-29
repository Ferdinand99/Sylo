// The public quote page, /quotes/<server>: off by default (404), on when the server switches it
// on, newest first with paging, display names only and no ids, nothing from channels everyone
// cannot read, no jump links, and a page that works under the enforcing Content Security Policy
// (no inline script or style).
import { startWebApp } from './helpers/webApp.js';
import { plainProblems } from './helpers/publicViews.js';
import { GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setGuildModule } from '../src/db/modules.js';
import { clearGuildQuotes, insertQuote } from '../src/db/quotes.js';
import { PAGE_SIZE } from '../src/web/routes/quotes.js';

let app;
test.before(async () => {
  app = await startWebApp();
});
test.after(() => app.close());

const get = (path = `/quotes/${GID}`) => fetch(app.base + path);
const AUTHOR_ID = '100000000000000321';
const SAVER_ID = '100000000000000322';
const CHANNEL_ID = '100000000000000323';
const MESSAGE_ID = '100000000000000324';
let n = 0;
const make = (over = {}) => {
  n += 1;
  return insertQuote({
    guildId: GID,
    channelId: CHANNEL_ID,
    messageId: over.messageId ?? (n === 1 ? MESSAGE_ID : `100000000000${String(n).padStart(6, '0')}`),
    authorId: AUTHOR_ID,
    authorName: 'Alice',
    body: `Quote number ${n}`,
    messageAt: Date.UTC(2030, 0, 2, 3, 4),
    savedBy: SAVER_ID,
    publicSource: true,
    ...over,
  });
};
const turnOn = (config = { publicPage: true }, enabled = true) =>
  setGuildModule(GID, 'quote-board', { enabled, config });

test('the page does not exist for an unknown server, a bad id, or a server that is not connected', async () => {
  const bad = await get('/quotes/not-a-server');
  assert.equal(bad.status, 404);
  assert.match(await bad.text(), /Unknown server/);
  const unknown = await get('/quotes/100000000000000999');
  assert.equal(unknown.status, 404);
  assert.match(await unknown.text(), /Sylo is not in that server/);
  const fluxer = await get(`/quotes/${encodeURIComponent('fluxer:900000000000000010')}`);
  assert.equal(fluxer.status, 404);
  assert.match(await fluxer.text(), /Sylo is not in that server/);
});

test('off by default: a server that never touched the module answers 404', async () => {
  await make();
  const res = await get();
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.match(html, /has not turned on a public quote page/);
  assert.doesNotMatch(html, /Quote number 1/);
});

test('the module on but the public page off is still 404, and so is a page switched on in a disabled module', async () => {
  await turnOn({ publicPage: false });
  assert.equal((await get()).status, 404);
  await turnOn({});
  assert.equal((await get()).status, 404);
  await turnOn({ publicPage: 'true' });
  assert.equal((await get()).status, 404, 'only a real true counts');
  await turnOn({ publicPage: true }, false);
  const res = await get();
  assert.equal(res.status, 404);
  assert.doesNotMatch(await res.text(), /Quote number 1/);
});

test('switched on, the page lists the quotes, newest first, with names and dates', async () => {
  await turnOn();
  await make({ body: 'The second quote', authorName: 'Bob', messageAt: Date.UTC(2031, 5, 6) });
  const res = await get();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /<title>.*Quotes<\/title>/);
  assert.match(html, /Quote board · 2 quotes/);
  assert.ok(html.indexOf('The second quote') < html.indexOf('Quote number 1'), 'newest first');
  assert.match(html, /Alice/);
  assert.match(html, /Bob/);
  assert.match(html, /2031-06-06/);
  assert.match(html, /#2/);
  assert.match(html, /class="q-item"/);
});

test('no ids leak: not the author, the saver, the channel or the message, and no jump links', async () => {
  const html = await (await get()).text();
  for (const secret of [AUTHOR_ID, SAVER_ID, CHANNEL_ID, MESSAGE_ID]) {
    assert.ok(!html.includes(secret), `the page must not contain ${secret}`);
  }
  assert.doesNotMatch(html, /\/channels\//);
  assert.doesNotMatch(html, /<a [^>]*href="https?:/i, 'no outward links at all');
  // nothing that looks like a snowflake besides the server's own id
  assert.doesNotMatch(html.replaceAll(GID, ''), /\b\d{17,20}\b/);
});

test('ids written inside a quote are turned into words', async () => {
  await make({
    body:
      'ping <@100000000000000777> in <#100000000000000778> with <:blob:100000000000000779> ' +
      'see https://discord.com/channels/100000000000000780/100000000000000781/100000000000000782',
  });
  const html = await (await get()).text();
  assert.match(html, /ping @member in #channel with :blob: see \[message link\]/);
  assert.doesNotMatch(html.replaceAll(GID, ''), /\b\d{17,20}\b/);
});

test('quotes from channels everyone cannot read never appear, and are not counted', async () => {
  await make({ body: 'Whispered in the staff channel', publicSource: false });
  const html = await (await get()).text();
  assert.doesNotMatch(html, /Whispered in the staff channel/);
  assert.match(html, /Quote board · 3 quotes/);
});

test('text is escaped, never run as markup', async () => {
  await make({
    body: '<script>alert("x")</script><img src=x/onerror=alert(1)><svg/onload=alert(2)>',
    authorName: '<b>Mallory</b>',
  });
  const html = await (await get()).text();
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>Mallory/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.deepEqual(plainProblems(html), []);
});

test('an attachments-only quote shows the count', async () => {
  await make({ body: '', attachments: 3 });
  const html = await (await get()).text();
  assert.match(html, /\(no text\)/);
  assert.match(html, /📎 3 attachments/);
});

test('the page carries the enforcing Content Security Policy and has no inline script or style', async () => {
  const res = await get();
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, 'a Content-Security-Policy header');
  assert.equal(res.headers.get('content-security-policy-report-only'), null, 'enforcing, not report-only');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /style-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  const html = await res.text();
  assert.deepEqual(plainProblems(html), []);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/i, 'no inline script');
  assert.doesNotMatch(html, /<style[\s>]/i, 'no inline style block');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'no style attribute');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handler');
  assert.match(html, /<link rel="stylesheet" href="\/public\.css"/);
  assert.match(html, /<script src="\/theme\.js"><\/script>/);
  assert.match(html, /<meta name="robots" content="noindex"/);
});

test('the stylesheet has the quote page classes', async () => {
  const css = await (await get('/public.css')).text();
  for (const cls of ['.q-list', '.q-item', '.q-text', '.q-meta']) assert.ok(css.includes(cls), cls);
});

test('the error page for a missing public page also carries the policy', async () => {
  await turnOn({ publicPage: false });
  const res = await get();
  assert.equal(res.status, 404);
  assert.ok(res.headers.get('content-security-policy'));
  assert.deepEqual(plainProblems(await res.text()), []);
  await turnOn();
});

test('paging: 50 per page, newest first, links between pages, and odd page numbers are clamped', async () => {
  await turnOn();
  const before = Number((await (await get()).text()).match(/· (\d+) quotes/)[1]);
  const need = PAGE_SIZE + 1 - before + 10; // more than one page, a short second page
  for (let i = 0; i < need; i += 1) await make({ body: `paged ${i}` });
  const total = before + need;
  const pages = Math.ceil(total / PAGE_SIZE);
  assert.equal(pages, 2);

  const first = await (await get()).text();
  assert.equal([...first.matchAll(/class="q-item"/g)].length, PAGE_SIZE);
  assert.match(first, new RegExp(`Page 1 of ${pages}`));
  assert.match(first, /href="\?page=2">Older/);
  assert.match(first, /lb-pager-off">&larr; Newer/);
  assert.ok(first.includes(`paged ${need - 1}`), 'the newest quote is on the first page');

  const second = await (await get(`/quotes/${GID}?page=2`)).text();
  assert.equal([...second.matchAll(/class="q-item"/g)].length, total - PAGE_SIZE);
  assert.match(second, /href="\?page=1">&larr; Newer/);
  assert.match(second, /lb-pager-off">Older/);
  assert.ok(second.includes('Quote number 1'), 'the oldest quote is on the last page');
  assert.ok(!second.includes(`paged ${need - 1}`));

  for (const odd of ['999', '0', '-4', 'abc', '2.7']) {
    const html = await (await get(`/quotes/${GID}?page=${odd}`)).text();
    assert.match(html, /Page \d of 2/, odd);
  }
  assert.match(await (await get(`/quotes/${GID}?page=999`)).text(), /Page 2 of 2/);
  assert.match(await (await get(`/quotes/${GID}?page=abc`)).text(), /Page 1 of 2/);
});

test('an empty board says so', async () => {
  await clearGuildQuotes(GID);
  const html = await (await get()).text();
  assert.match(html, /No quotes have been saved yet/);
  assert.match(html, /Quote board · 0 quotes/);
  assert.deepEqual(plainProblems(html), []);
});
