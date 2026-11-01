// The public event page, /events/<token>: off by default (404), on when the server switches it on
// in the Events settings. One page per event at an address nobody can guess; the title, the time,
// the place, the capacity and the Going / Maybe counts, never a name, a host or an id; only events
// from a channel everyone can see, checked again on every request; every reason for no page gives
// the same answer; and the page works under the strict Content Security Policy.
import './helpers/trustLoopbackProxy.js';
import { startWebApp } from './helpers/webApp.js';
import { plainProblems } from './helpers/publicViews.js';
import { CH, GID } from './helpers/fakeGuild.js';
import { PermissionsBitField } from 'discord.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setGuildModule } from '../src/db/modules.js';
import {
  claimEventState,
  clearGuildEvents,
  createEvent,
  getEvent,
  setEventParticipant,
} from '../src/db/events.js';
import { forgetUser } from '../src/db/purge.js';
import { _clearImageCache, _setImageFetcher } from '../src/modules/lib/eventImage.js';

let app;
test.before(async () => {
  app = await startWebApp();
  app.guild.iconURL = () => ICON_LINK;
  // The events live under a server key of their own, so that other test files that share the
  // Postgres database (and use the fake server's own id) never see them.
  app.client.guilds.cache.set(SG, app.guild);
});
test.after(() => app.close());

const SG = '900000000000000124';
const HOST = '900000000000000555';
const MEMBERS = ['900000000000000561', '900000000000000562', '900000000000000563'];
const HOUR = 3_600_000;
const NO_PAGE = /There is no public event page at this address/;
const ICON_LINK = `https://cdn.discordapp.com/icons/${GID}/a1b2c3.png?size=128`;
const ATTACHMENT = `https://cdn.discordapp.com/attachments/${CH.general}/100000000000000042/poster.png`;
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png'),
]);

// The images are fetched by Sylo, not by the visitor's browser. Here the fetch is answered by the
// test: every call is recorded, and a test can change the answer.
const calls = [];
let override = null;
const setAnswer = (fn) => {
  override = fn;
};
const okPng = async () => ({
  status: 200,
  ok: true,
  headers: new Headers({ 'content-type': 'image/png' }),
  body: PNG,
});
test.before(() => {
  _setImageFetcher(async (url, options) => {
    calls.push({ url, options });
    return (override ?? okPng)(url, options);
  });
  _clearImageCache();
});
test.after(() => _setImageFetcher(null));

const turnOn = (config = { publicPages: true }, enabled = true) =>
  setGuildModule(SG, 'events', { enabled, config });

async function make(over = {}) {
  const { id } = await createEvent({
    guildId: SG,
    channelId: CH.general,
    title: 'Game night',
    description: 'Bring snacks',
    location: 'Voice 1',
    startAt: Date.UTC(2030, 0, 5, 18, 0),
    endAt: Date.UTC(2030, 0, 5, 21, 0),
    timeZone: 'Europe/Oslo',
    capacity: 10,
    roleId: '100000000000000700',
    hostId: HOST,
    ...over,
  });
  return getEvent(id);
}
// The page is limited to 40 requests a minute per client. These tests send more than that, so every
// 30 requests come from the next client address (the web server trusts X-Forwarded-For from this
// machine here, see helpers/trustLoopbackProxy.js); the limit's own test uses one of its own.
let sent = 0;
const clientNow = () => `10.20.${Math.floor(sent++ / 30)}.1`;
const get = (token, client = clientNow()) =>
  fetch(`${app.base}/events/${token}`, { headers: { 'x-forwarded-for': client } });
const getAsset = (token, name, client = clientNow()) =>
  fetch(`${app.base}/events/${token}/${name}`, { headers: { 'x-forwarded-for': client } });
const page = async (ev) => (await get(ev.public_token)).text();

let ev;
test.before(async () => {
  await turnOn();
  ev = await make();
});

// --- no page ----------------------------------------------------------------------------------

test('off by default: a server that never touched the setting answers 404', async () => {
  await setGuildModule(SG, 'events', { enabled: true, config: {} });
  const res = await get(ev.public_token);
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.match(html, NO_PAGE);
  assert.doesNotMatch(html, /Game night/);
  await turnOn();
});

test('the setting must be a real true, and the module must be on', async () => {
  for (const [config, enabled] of [
    [{ publicPages: false }, true],
    [{ publicPages: 'true' }, true],
    [{ publicPages: 1 }, true],
    [{}, true],
    [{ publicPages: true }, false],
  ]) {
    await turnOn(config, enabled);
    const res = await get(ev.public_token);
    assert.equal(res.status, 404, JSON.stringify([config, enabled]));
    assert.doesNotMatch(await res.text(), /Game night/);
  }
  await turnOn();
  assert.equal((await get(ev.public_token)).status, 200);
});

test('a wrong token is 404: another event, a changed character, the wrong case, the wrong length', async () => {
  const other = await make({ title: 'Other event' });
  const t = ev.public_token;
  const flipped = `${t.slice(0, -1)}${t.endsWith('0') ? '1' : '0'}`;
  for (const token of [
    flipped,
    t.toUpperCase(),
    t.slice(0, 31),
    `${t}0`,
    '0'.repeat(32),
    String(ev.id),
    `${ev.id}`.padStart(32, '0'),
    'not-a-token',
    '%00',
    "' OR 1=1 --",
  ]) {
    const res = await get(encodeURIComponent(token));
    assert.equal(res.status, 404, token);
    assert.match(await res.text(), NO_PAGE, token);
  }
  // the right token of the other event shows the other event
  assert.match(await page(other), /Other event/);
  assert.doesNotMatch(await page(other), /Game night/);
});

test('the event number is never an address', async () => {
  for (const path of [`/events/${ev.id}`, `/events/${ev.id}/`, `/events/${GID}`, '/events/', '/events']) {
    const res = await fetch(app.base + path, {
      headers: { 'x-forwarded-for': `10.20.${Math.floor(sent++ / 30)}.1` },
    });
    assert.equal(res.status, 404, path);
  }
});

test('every reason for no page gives the same answer, byte for byte', async () => {
  const bodies = [];
  bodies.push(await (await get('not-a-token')).text()); // not a token
  bodies.push(await (await get('0'.repeat(32))).text()); // looks right, belongs to nothing
  const stranger = await make({ guildId: '100000000000000999' }); // a server Sylo is not in
  bodies.push(await page(stranger));
  await turnOn({ publicPages: false }); // page off
  bodies.push(await page(ev));
  await turnOn({ publicPages: true }, false); // module off
  bodies.push(await page(ev));
  await turnOn();

  const channel = app.guild.channels.cache.get(CH.general);
  const open = channel.permissionsFor;
  const everyone = app.guild.roles.everyone;
  try {
    channel.permissionsFor = (role) => (role === everyone ? new PermissionsBitField(0n) : open(role));
    bodies.push(await page(ev)); // private channel
  } finally {
    channel.permissionsFor = open;
  }
  const lost = await make({ channelId: '100000000000000998' }); // a channel Sylo cannot find
  bodies.push(await page(lost));

  assert.equal(new Set(bodies).size, 1, 'the answers are identical');
  assert.match(bodies[0], NO_PAGE);
});

// --- the page ---------------------------------------------------------------------------------

test('switched on, the page shows the event: title, time, place, capacity, counts and status', async () => {
  await setEventParticipant(ev.id, MEMBERS[0], 'join');
  await setEventParticipant(ev.id, MEMBERS[1], 'join');
  await setEventParticipant(ev.id, MEMBERS[2], 'maybe');
  const res = await get(ev.public_token);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /<title>Game night[^<]*<\/title>/);
  assert.match(html, /<h1 class="page-title">Game night<\/h1>/);
  assert.match(html, /Bring snacks/);
  assert.match(html, /Voice 1/);
  assert.match(html, /ev-badge ev-upcoming">Upcoming</);
  // the time is an element the page script turns into the visitor's own zone; UTC without script
  assert.match(html, /<time [^>]*datetime="2030-01-05T18:00:00\.000Z"[^>]*>2030-01-05 18:00 UTC<\/time>/);
  assert.match(html, /datetime="2030-01-05T21:00:00\.000Z"/, 'the end');
  assert.match(html, /<dt>Going<\/dt>\s*<dd>2 of 10<\/dd>/);
  assert.match(html, /<dt>Maybe<\/dt>\s*<dd>1<\/dd>/);
  assert.match(html, /<script src="\/event-time\.js" defer><\/script>/);
});

test('an event without a capacity, a place or an end shows only what it has', async () => {
  const bare = await make({ capacity: null, location: '', description: '', endAt: null });
  const html = await page(bare);
  assert.match(html, /<dt>Going<\/dt>\s*<dd>0<\/dd>/);
  assert.doesNotMatch(html, /<dt>Where<\/dt>/);
  assert.doesNotMatch(html, /<dt>Ends<\/dt>/);
  assert.doesNotMatch(html, /ev-description/);
  assert.doesNotMatch(html, / of null| of undefined|undefined|NaN/);
});

test('a full event says so', async () => {
  const small = await make({ capacity: 1 });
  await setEventParticipant(small.id, MEMBERS[0], 'join');
  assert.match(await page(small), /<dd>1 of 1 · Full<\/dd>/);
});

test('a cancelled event still has its page, marked cancelled', async () => {
  const c = await make({ title: 'Called off' });
  await claimEventState(c.id, 'cancelled');
  const html = await page(c);
  assert.match(html, /Called off/);
  assert.match(html, /ev-badge ev-cancelled">Cancelled</);
  assert.doesNotMatch(html, /Upcoming/);
});

test('an ended event still has its page, marked ended', async () => {
  const e = await make({ title: 'Last year' });
  await claimEventState(e.id, 'ended');
  const html = await page(e);
  assert.match(html, /ev-badge ev-ended">Ended</);
  assert.doesNotMatch(html, /Upcoming/);
});

test('an event past its end is ended even before the clock tick has closed it', async () => {
  const past = await make({
    title: 'Over by now',
    startAt: Date.now() - 5 * HOUR,
    endAt: Date.now() - 3 * HOUR,
  });
  assert.equal(past.state, 'scheduled');
  assert.match(await page(past), /ev-badge ev-ended">Ended</);
  // with no end time it counts as over two hours after the start
  const noEnd = await make({ title: 'No end', startAt: Date.now() - 3 * HOUR, endAt: null });
  assert.match(await page(noEnd), /ev-badge ev-ended">Ended</);
  const running = await make({ title: 'Running', startAt: Date.now() - HOUR, endAt: null });
  assert.match(await page(running), /ev-badge ev-upcoming">Upcoming</);
});

test('no host, no member, no role, no channel and no id of any kind', async () => {
  const html = await page(ev);
  for (const secret of [HOST, ...MEMBERS, '100000000000000700', CH.general, GID]) {
    assert.ok(!html.includes(secret), `the page must not contain ${secret}`);
  }
  assert.doesNotMatch(html, /\b\d{17,20}\b/, 'nothing that looks like a snowflake');
  assert.doesNotMatch(html, /user-\d{4}/, 'no display names or tags');
  assert.doesNotMatch(html, /<@|<#|host|Host|participant|Participant/i);
  assert.doesNotMatch(html, /<a [^>]*href="https?:/i, 'no outward links');
  assert.doesNotMatch(html, new RegExp(`#${ev.id}\\b`), 'not even the event number');
});

test('mentions and ids written into the text are turned into words', async () => {
  const m = await make({
    title: 'Party for <@900000000000000777>',
    description:
      'Ask <@&900000000000000778> in <#900000000000000779> see https://discord.com/channels/900000000000000780/900000000000000781/900000000000000782',
    location: '<#900000000000000783>',
  });
  const html = await page(m);
  assert.match(html, /Party for @member/);
  assert.match(html, /Ask @role in #channel see \[message link\]/);
  assert.doesNotMatch(html, /\b\d{17,20}\b/);
});

test('hostile text is escaped, never run as markup', async () => {
  const evil = '<script>alert("x")</script><img src=x/onerror=alert(1)><svg/onload=alert(2)>"\'&';
  const h = await make({ title: evil, description: evil, location: evil });
  const html = await page(h);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<svg/);
  assert.doesNotMatch(html, /<[^>]*\sonerror=/i);
  assert.match(html, /&lt;script&gt;alert\(&#34;x&#34;\)&lt;\/script&gt;/);
  assert.deepEqual(plainProblems(html), []);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/i, 'no inline script');
  assert.equal([...html.matchAll(/<script/g)].length, 2, 'only the theme and time scripts');
});

// --- images -----------------------------------------------------------------------------------

const asset = async (event, name) => getAsset(event.public_token, name);
const fetched = (url) => calls.filter((c) => c.url.startsWith(url.split('?')[0]));

test('the page holds no third-party address and no id: the icon and the image are served by Sylo', async () => {
  const withImage = await make({ imageUrl: ATTACHMENT });
  const html = await page(withImage);
  assert.ok(html.includes(`src="/events/${withImage.public_token}/icon"`), 'the icon through Sylo');
  assert.ok(html.includes(`src="/events/${withImage.public_token}/image"`), 'the image through Sylo');
  assert.doesNotMatch(html, /https?:\/\//, 'no address of anyone else');
  assert.doesNotMatch(html, /discordapp/);
  assert.doesNotMatch(html, /\b\d{17,20}\b/, 'none of the ids in the image links');
  assert.ok(!html.includes(GID) && !html.includes(CH.general) && !html.includes('100000000000000042'));

  const icon = await asset(withImage, 'icon');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.equal(icon.headers.get('x-content-type-options'), 'nosniff');
  assert.match(icon.headers.get('cache-control'), /private/);
  assert.deepEqual(Buffer.from(await icon.arrayBuffer()), PNG);
  const image = await asset(withImage, 'image');
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
});

test('Sylo fetches only from Discord, over https, with no redirect, a size cap and a timeout', async () => {
  const withImage = await make({ imageUrl: ATTACHMENT });
  _clearImageCache();
  calls.length = 0;
  await asset(withImage, 'image');
  await asset(withImage, 'icon');
  assert.deepEqual(calls.map((c) => c.url).sort(), [ATTACHMENT, ICON_LINK].sort());
  for (const { url, options } of calls) {
    assert.match(url, /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//);
    assert.equal(options.maxRedirects, 0, 'a redirect is a failure');
    assert.equal(options.allowPrivate, false, 'never lifted by ALLOW_PRIVATE_URLS');
    assert.ok(options.maxBytes > 0 && options.maxBytes <= 2 * 1024 * 1024);
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 10_000);
  }
});

test('a link to anywhere else is never fetched, and leaves the image out', async () => {
  const hidden = [
    'https://evil.example/pixel.png',
    'https://tracker.example/p.gif?visitor=1',
    'https://cdn.discordapp.com.evil.example/a.png',
    'https://evilcdn.discordapp.com/a.png',
    'https://cdn.discordapp.com@evil.example/a.png',
    'https://evil.example/cdn.discordapp.com/a.png',
    'http://cdn.discordapp.com/a.png',
    'https://cdn.discordapp.com:8443/a.png',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    '//cdn.discordapp.com/a.png',
  ];
  for (const imageUrl of hidden) {
    calls.length = 0;
    const withImage = await make({ imageUrl });
    const html = await page(withImage);
    assert.doesNotMatch(html, /<img class="ev-image"/, imageUrl);
    assert.ok(!html.includes('evil.example') && !html.includes('tracker.example'), imageUrl);
    assert.equal((await asset(withImage, 'image')).status, 404, imageUrl);
    assert.equal(fetched(imageUrl).length, 0, `${imageUrl} is not fetched`);
    assert.ok(
      calls.every((c) => /^https:\/\/cdn\.discordapp\.com\/icons\//.test(c.url)),
      'only the icon'
    );
  }
});

test('when the fetch fails the page has no image, and the image address is not found', async () => {
  const body = (type, bytes) => ({
    status: 200,
    ok: true,
    headers: new Headers({ 'content-type': type }),
    body: bytes,
  });
  const cases = {
    'not-found': async () => ({ status: 404, ok: false, headers: new Headers(), body: Buffer.from('gone') }),
    'a redirect': async () => ({
      status: 302,
      ok: false,
      headers: new Headers({ location: 'https://evil.example/' }),
      body: Buffer.alloc(0),
    }),
    'a thrown error': async () => {
      throw new Error('Too many redirects');
    },
    'a timeout': async () => {
      throw new Error('This operation was aborted');
    },
    'too large': async () => {
      throw new Error('Response too large (3000000 bytes)');
    },
    'an SVG': async () =>
      body(
        'image/svg+xml',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
      ),
    'an SVG called a PNG': async () =>
      body('image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    'a page of HTML': async () => body('text/html', Buffer.from('<html>login</html>')),
    'an empty body': async () => body('image/png', Buffer.alloc(0)),
    'an unlisted image type': async () => body('image/bmp', Buffer.from('BM123456789')),
  };
  const missing = await (await get('0'.repeat(32))).text();
  for (const [name, answer] of Object.entries(cases)) {
    setAnswer(answer);
    _clearImageCache();
    const withImage = await make({
      imageUrl: `https://cdn.discordapp.com/attachments/1/2/${name.replaceAll(' ', '-')}.png`,
    });
    const html = await page(withImage);
    assert.doesNotMatch(html, /<img class="ev-image"/, name);
    assert.match(html, /Game night/, `${name}: the rest of the page is still there`);
    assert.ok(!html.includes('/icon'), `${name}: nor the icon`);
    const res = await asset(withImage, 'image');
    assert.equal(res.status, 404, name);
    assert.equal(await res.text(), missing, `${name}: the same not-found page`);
  }
  setAnswer(null);
  _clearImageCache();
});

test('what is served is the type the bytes show, from the types on the list only', async () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const GIF = Buffer.from('GIF89a......');
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]);
  for (const [bytes, served] of [
    [JPEG, 'image/jpeg'],
    [GIF, 'image/gif'],
    [WEBP, 'image/webp'],
    [PNG, 'image/png'],
  ]) {
    setAnswer(async () => ({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'image/png' }),
      body: bytes,
    }));
    _clearImageCache();
    const withImage = await make({ imageUrl: ATTACHMENT });
    const res = await asset(withImage, 'image');
    assert.equal(res.status, 200, served);
    assert.equal(res.headers.get('content-type'), served, 'the type of the bytes, not the claimed one');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
  setAnswer(null);
  _clearImageCache();
});

test('the image addresses follow the rules of the page and answer with the same not-found', async () => {
  const withImage = await make({ imageUrl: ATTACHMENT });
  const missing = await (await get('0'.repeat(32))).text();
  const refused = [];
  const seen = async (res) => {
    assert.equal(res.status, 404);
    refused.push(await res.text());
  };
  _clearImageCache();
  calls.length = 0;

  await seen(await getAsset('0'.repeat(32), 'image')); // no such token
  await seen(await getAsset('not-a-token', 'icon'));
  await seen(await getAsset(withImage.public_token, 'other')); // not an asset
  await seen(await getAsset(String(withImage.id), 'image')); // the event number
  await turnOn({ publicPages: false });
  await seen(await getAsset(withImage.public_token, 'image')); // page off
  await turnOn({ publicPages: true }, false);
  await seen(await getAsset(withImage.public_token, 'icon')); // module off
  await turnOn();
  await withChannel(closedTo, async () => {
    await seen(await getAsset(withImage.public_token, 'image')); // private channel
    await seen(await getAsset(withImage.public_token, 'icon'));
  });
  const stranger = await make({ guildId: '100000000000000999', imageUrl: ATTACHMENT });
  await seen(await getAsset(stranger.public_token, 'image')); // a server Sylo is not in

  assert.ok(
    refused.every((body) => body === missing),
    'every refusal is the same page'
  );
  assert.equal(calls.length, 0, 'nothing is fetched for a request that is refused');
  assert.equal((await getAsset(withImage.public_token, 'image')).status, 200, 'and back to normal');
});

test('an image that was fetched is kept for a while, not fetched again for every visitor', async () => {
  const withImage = await make({ imageUrl: `${ATTACHMENT}?ex=1` });
  _clearImageCache();
  calls.length = 0;
  for (let i = 0; i < 4; i += 1) {
    await page(withImage);
    await asset(withImage, 'image');
  }
  assert.equal(fetched(`${ATTACHMENT}?ex=1`).length, 1);
});

test('the not-found page has no visit-count script, so the address stays out of the stats', async () => {
  const res = await get('0'.repeat(32));
  const html = await res.text();
  assert.doesNotMatch(html, /telemetry|kestrel|k\.js/i);
  assert.equal([...html.matchAll(/<script/g)].length, 1, 'only the theme script');
  assert.match(html, /<meta name="robots" content="noindex"/);
});

// --- what the browser is told -----------------------------------------------------------------

test('the page carries the enforcing Content Security Policy, noindex, and is not cached', async () => {
  const res = await get(ev.public_token);
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, 'a Content-Security-Policy header');
  assert.equal(res.headers.get('content-security-policy-report-only'), null, 'enforcing, not report-only');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /style-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const html = await res.text();
  assert.deepEqual(plainProblems(html), []);
  assert.doesNotMatch(html, /<style[\s>]/i, 'no inline style block');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'no style attribute');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handler');
  assert.match(html, /<link rel="stylesheet" href="\/public\.css"/);
  assert.match(html, /<meta name="robots" content="noindex"/);
});

test('the not-found page carries the policy too, and is not cached', async () => {
  const res = await get('0'.repeat(32));
  assert.equal(res.status, 404);
  assert.ok(res.headers.get('content-security-policy'));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(plainProblems(await res.text()), []);
});

test('the time script and the stylesheet are served, and the script holds no foreign address', async () => {
  const js = await fetch(`${app.base}/event-time.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  const code = await js.text();
  assert.match(code, /toLocaleString|Intl\.DateTimeFormat/);
  assert.doesNotMatch(code, /https?:\/\//);
  assert.doesNotMatch(code, /\beval\b|new Function|document\.write|innerHTML/);
  const css = await (await fetch(`${app.base}/public.css`)).text();
  for (const cls of ['.ev-card', '.ev-badge', '.ev-facts', '.ev-image', '.ev-description']) {
    assert.ok(css.includes(cls), cls);
  }
});

// --- the channel is public: checked on every request, and fails closed --------------------------

const withChannel = async (change, fn) => {
  const channel = app.guild.channels.cache.get(CH.general);
  const saved = { permissionsFor: channel.permissionsFor, nsfw: channel.nsfw };
  try {
    change(channel);
    return await fn();
  } finally {
    channel.permissionsFor = saved.permissionsFor;
    if (saved.nsfw === undefined) delete channel.nsfw;
    else channel.nsfw = saved.nsfw;
  }
};
const everyoneOf = () => app.guild.roles.everyone;
const closedTo = (channel) => {
  const open = channel.permissionsFor;
  channel.permissionsFor = (role) => (role === everyoneOf() ? new PermissionsBitField(0n) : open(role));
};

test('an event in a channel @everyone cannot read has no page, even with the setting on', async () => {
  const before = await get(ev.public_token);
  assert.equal(before.status, 200);
  await withChannel(closedTo, async () => {
    const res = await get(ev.public_token);
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.match(html, NO_PAGE);
    assert.doesNotMatch(html, /Game night/);
  });
});

test('the channel is checked on every request: closed at once, open again at once', async () => {
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await get(ev.public_token)).status, 200);
    await withChannel(closedTo, async () => {
      assert.equal((await get(ev.public_token)).status, 404, `closed, round ${i}`);
    });
  }
  assert.equal((await get(ev.public_token)).status, 200);
});

test('an age-restricted channel has no page', async () => {
  await withChannel(
    (c) => {
      c.nsfw = true;
    },
    async () => assert.equal((await get(ev.public_token)).status, 404)
  );
});

test('when the answer cannot be had, there is no page: an error, no answer, a channel Sylo cannot see', async () => {
  await withChannel(
    (c) => {
      c.permissionsFor = () => {
        throw new Error('boom');
      };
    },
    async () => assert.equal((await get(ev.public_token)).status, 404, 'permissionsFor throws')
  );
  await withChannel(
    (c) => {
      c.permissionsFor = () => null;
    },
    async () => assert.equal((await get(ev.public_token)).status, 404, 'no permissions known')
  );
  const gone = await make({ channelId: '100000000000000997' });
  assert.equal((await get(gone.public_token)).status, 404, 'the channel is not known to Sylo');
  const cache = app.guild.channels.cache;
  const saved = cache.get(CH.general);
  try {
    cache.delete(CH.general);
    assert.equal((await get(ev.public_token)).status, 404, 'the channel left the cache');
  } finally {
    cache.set(CH.general, saved);
  }
  assert.equal((await get(ev.public_token)).status, 200);
});

// --- erasure ----------------------------------------------------------------------------------

test('/forget by the host leaves the page as it was, without a host to show', async () => {
  const mine = await make({ title: 'Mine', hostId: MEMBERS[0] });
  await setEventParticipant(mine.id, MEMBERS[0], 'join');
  assert.match(await page(mine), /<dt>Going<\/dt>\s*<dd>1 of 10<\/dd>/);
  await forgetUser(SG, MEMBERS[0]);
  const html = await page(mine);
  assert.match(html, /Mine/);
  assert.match(html, /<dt>Going<\/dt>\s*<dd>0 of 10<\/dd>/, 'their sign-up is gone from the count');
  assert.ok(!html.includes(MEMBERS[0]));
});

test('when Sylo leaves the server, the events and their pages are gone', async () => {
  const doomed = await make({ title: 'Doomed' });
  assert.equal((await get(doomed.public_token)).status, 200);
  await clearGuildEvents(SG);
  const res = await get(doomed.public_token);
  assert.equal(res.status, 404);
  assert.match(await res.text(), NO_PAGE);
});

// --- limits -----------------------------------------------------------------------------------

test('the public rate limit applies: 40 requests a minute, then 429', async () => {
  let last;
  for (let i = 0; i < 45; i += 1) last = await get('0'.repeat(32), '10.99.99.99');
  assert.equal(last.status, 429);
  assert.equal(last.headers.get('x-ratelimit-limit'), '40');
});
