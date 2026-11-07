// The sign-in event page, /events/<token>, for an event in a channel that @everyone cannot see, on
// Discord, through the real Express app with both logins on (helpers/oauthApp.js).
//
// The rules under test: a visitor who is not signed in gets one neutral sign-in page that shows
// nothing of any event; after sign-in the server checks on every request that the person is a member
// of that server and can see that channel, by the bot's live data, on the same platform; everything
// else is the same not-found page as a wrong address; the answers are never cached or indexed; the
// images follow the page; an age-restricted channel has no page for anyone; the login returns only
// to a path on this site.
import './helpers/trustLoopbackProxy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { D_GUILD, F_GUILD, browser, setProfiles, startOAuthApp, stateOf } from './helpers/oauthApp.js';
import { plainProblems } from './helpers/publicViews.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { createEvent, getEvent } = await import('../src/db/events.js');
const { _clearImageCache, _setImageFetcher } = await import('../src/modules/lib/eventImage.js');
const { MEMBER_LOOKUP_MS, _setMembersIntent, _setViewerCache } =
  await import('../src/modules/lib/eventPage.js');
// A verdict is reused for a few seconds in production; these tests change access between requests.
_setViewerCache({ ttlMs: 0 });

// --- the world: one Discord server with a public channel, a staff channel and some members ------

const STAFF = '900000000000000301'; // the role that can see the staff channel
const ALICE = '900000000000000401'; // a member with the staff role
const BOB = '900000000000000402'; // a member without it
const CAROL = '900000000000000403'; // not in the server at all
const MOD = '900000000000000404'; // has the staff role, not cached by the bot
const CH_PUBLIC = '100000000000000101';
const CH_STAFF = '100000000000000102';
const CH_ADULT = '100000000000000103'; // staff channel, age-restricted
const CH_ADULT_PUBLIC = '100000000000000104'; // everyone can see it, age-restricted
const TH_PUBLIC = '100000000000000105'; // a public thread in the staff channel
const TH_PRIVATE = '100000000000000106'; // a private thread in the staff channel
const ICON = `https://cdn.discordapp.com/icons/${D_GUILD}/a1b2c3.png?size=128`;
const POSTER = 'https://cdn.discordapp.com/attachments/100000000000000102/100000000000000042/poster.png';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('secret'),
]);
const NOT_FOUND = /There is no event page at this address/;

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
guild.iconURL = () => ICON;

const roles = new Map([
  [D_GUILD, { id: D_GUILD, permissions: new PermissionsBitField(P.ViewChannel | P.SendMessages) }],
  [STAFF, { id: STAFF, permissions: new PermissionsBitField(0n) }],
]);
guild.roles = { cache: roles, everyone: roles.get(D_GUILD) };

/** What discord.js works out for a member or a role: role permissions, then @everyone's overwrite, then the roles'. */
function permissionsOf(channel, roleIds) {
  let bits = roles.get(D_GUILD).permissions.bitfield;
  for (const id of roleIds) bits |= roles.get(id)?.permissions.bitfield ?? 0n;
  if (bits & P.Administrator) return new PermissionsBitField(PermissionsBitField.All);
  for (const id of [D_GUILD, ...roleIds]) {
    const ow = channel.overwrites[id];
    if (ow) bits = (bits & ~ow.deny) | ow.allow;
  }
  return new PermissionsBitField(bits);
}

function makeChannel(id, { open = false, staff = true, nsfw = false } = {}) {
  const channel = {
    id,
    name: `channel-${id.slice(-3)}`,
    type: ChannelType.GuildText,
    nsfw,
    isThread: () => false,
    // overwrites by role id: tests change them to make a channel public or private again
    overwrites: {
      [D_GUILD]: open ? { allow: P.ViewChannel, deny: 0n } : { allow: 0n, deny: P.ViewChannel },
      ...(staff ? { [STAFF]: { allow: P.ViewChannel, deny: 0n } } : {}),
    },
    permissionsFor(target) {
      if (target?.roles?.cache) return permissionsOf(channel, [...target.roles.cache.keys()]);
      if (target?.permissions) return permissionsOf(channel, target.id === D_GUILD ? [] : [target.id]);
      return null;
    },
  };
  return channel;
}

function makeThread(id, parent, type) {
  const members = new Map();
  return {
    id,
    type,
    nsfw: false,
    parent,
    members: {
      cache: members,
      fetch: async (userId) => members.get(userId) ?? Promise.reject(new Error('Unknown Member')),
    },
    isThread: () => true,
    permissionsFor: (target) => parent.permissionsFor(target),
    _members: members,
  };
}

const channels = guild.channels.cache;
const staffChannel = makeChannel(CH_STAFF);
channels.set(CH_PUBLIC, makeChannel(CH_PUBLIC, { open: true, staff: false }));
channels.set(CH_STAFF, staffChannel);
channels.set(CH_ADULT, makeChannel(CH_ADULT, { nsfw: true }));
channels.set(CH_ADULT_PUBLIC, makeChannel(CH_ADULT_PUBLIC, { open: true, staff: false, nsfw: true }));
channels.set(TH_PUBLIC, makeThread(TH_PUBLIC, staffChannel, ChannelType.PublicThread));
channels.set(TH_PRIVATE, makeThread(TH_PRIVATE, staffChannel, ChannelType.PrivateThread));

// The platform's truth (`live`) and the bot's cache of it (`cache`) are separate, so a test can make
// the cache stale. fetch() asks the platform and records how.
const live = new Map();
const fetches = [];
const memberOf = (id, roleIds) => ({
  id,
  user: { id },
  roles: { cache: new Map(roleIds.map((r) => [r, roles.get(r)])) },
});
guild.members = {
  cache: new Map(),
  fetch: async (arg) => {
    fetches.push(arg);
    const id = typeof arg === 'string' ? arg : arg?.user;
    const member = live.get(id);
    if (!member) throw new Error('Unknown Member');
    return member;
  },
};
function enrol(id, roleIds, { cached = true } = {}) {
  const member = memberOf(id, roleIds);
  live.set(id, member);
  if (cached) guild.members.cache.set(id, member);
  else guild.members.cache.delete(id);
  return member;
}
function expel(id) {
  live.delete(id);
  guild.members.cache.delete(id);
}
const resetMembers = () => {
  fetches.length = 0;
  enrol(ALICE, [STAFF]);
  enrol(BOB, []);
  enrol(MOD, [STAFF], { cached: false });
  expel(CAROL);
};
resetMembers();

// --- the images: fetched by Sylo, here answered by the test ---------------------------------------

const imageCalls = [];
_setImageFetcher(async (url) => {
  imageCalls.push(url);
  return { status: 200, ok: true, headers: new Headers({ 'content-type': 'image/png' }), body: PNG };
});
test.after(() => _setImageFetcher(null));

// --- requests --------------------------------------------------------------------------------

// The page and the login are rate limited per client. These tests send more than one client's
// share, so every 25 requests come from the next client address (helpers/trustLoopbackProxy.js).
let sent = 0;
const clientNow = () => `10.30.${Math.floor(sent++ / 25)}.1`;
const asClient = (ip, headers = {}) => ({ headers: { 'x-forwarded-for': ip, ...headers } });
const get = (b, path, headers) => b.get(path, asClient(clientNow(), headers));
const anon = () => browser();

/** A browser signed in with a platform account of the given id (the OAuth round trip, stubbed). */
async function signedIn(platform, id, next) {
  setProfiles(platform === 'discord' ? { discordId: id } : { fluxerId: id });
  const b = browser();
  const ip = clientNow();
  const start = await b.get(`/auth/${platform}/login${next ? `?next=${next}` : ''}`, asClient(ip));
  assert.equal(start.status, 302);
  const done = await b.get(`/auth/${platform}/callback?code=abc&state=${stateOf(start)}`, asClient(ip));
  assert.equal(done.status, 302);
  return { b, done };
}
const browsers = {};
test.before(async () => {
  for (const [name, id] of [
    ['alice', ALICE],
    ['bob', BOB],
    ['carol', CAROL],
    ['mod', MOD],
  ]) {
    browsers[name] = (await signedIn('discord', id)).b;
  }
});

// --- events ----------------------------------------------------------------------------------

const turnOn = (config2 = { publicPages: true }, enabled = true) =>
  setGuildModule(D_GUILD, 'events', { enabled, config: config2 });
let seq = 0;
async function make(channelId, over = {}) {
  seq += 1;
  const { id } = await createEvent({
    guildId: D_GUILD,
    channelId,
    title: `Secret plans ${seq}`,
    description: 'Bring the budget sheet',
    location: 'Back room',
    imageUrl: POSTER,
    startAt: Date.UTC(2030, 0, 5, 18, 0),
    endAt: Date.UTC(2030, 0, 5, 21, 0),
    timeZone: 'Europe/Oslo',
    capacity: 10,
    hostId: '900000000000000555',
    ...over,
  });
  return getEvent(id);
}
test.before(() => turnOn());

/** The body of a page with its own token replaced, so two addresses can be compared. */
const masked = (html, token) => html.split(token).join('<token>');
const randomToken = () =>
  [...Array(32)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
const text = async (res) => res.text();

let staffEv;
test.before(async () => {
  staffEv = await make(CH_STAFF);
});

// --- before sign-in: one neutral page that shows nothing ---------------------------------------

test('a visitor who is not signed in gets a sign-in page that shows nothing about the event', async () => {
  const res = await get(anon(), `/events/${staffEv.public_token}`);
  assert.equal(res.status, 401);
  const html = await text(res);
  for (const secret of [
    staffEv.title,
    'Bring the budget sheet',
    'Back room',
    'D-main', // the server's name
    'Europe/Oslo',
    POSTER,
    ICON,
    'cdn.discordapp.com',
    'Upcoming',
    CH_STAFF,
    D_GUILD,
    '/icon',
    '/image',
  ]) {
    assert.ok(!html.includes(secret), `the page must not contain ${secret}`);
  }
  assert.doesNotMatch(html, /<meta[^>]+(property|name)="(og|twitter|description)/i);
  assert.match(html, /<title>Sylo — Sign in<\/title>/);
  assert.match(html, /<meta name="robots" content="noindex/);
  assert.deepEqual(plainProblems(html), []);
  // no visit-count script: the address holds the token
  assert.doesNotMatch(html, /telemetry|kestrel|k\.js/i);
  assert.equal([...html.matchAll(/<script/g)].length, 1, 'only the theme script');
});

test('the sign-in page is never cached or indexed, and the address does not travel as a referrer', async () => {
  const res = await get(anon(), `/events/${staffEv.public_token}`);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  assert.match(res.headers.get('x-robots-tag'), /nofollow/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('vary') ?? '', /cookie/i);
  assert.ok(res.headers.get('content-security-policy'), 'the page policy applies');
});

test('a link preview bot sees the same page: no title, no description, no image, no card tags', async () => {
  for (const userAgent of [
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'Twitterbot/1.0',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'facebookexternalhit/1.1',
    'WhatsApp/2.23.20.0',
  ]) {
    const res = await get(anon(), `/events/${staffEv.public_token}`, { 'user-agent': userAgent });
    const html = await text(res);
    assert.equal(res.status, 401, userAgent);
    assert.doesNotMatch(html, /og:|twitter:|<meta[^>]+description/i, userAgent);
    assert.ok(!html.includes(staffEv.title), userAgent);
    assert.doesNotMatch(html, /<img[^>]+src="(?!\/favicon)/i, "no picture but Sylo's own mark");
  }
});

test('the sign-in link is for the platform the event was posted on', async () => {
  const d = await text(await get(anon(), `/events/${staffEv.public_token}`));
  assert.match(d, new RegExp(`href="/auth/discord/login\\?next=/events/${staffEv.public_token}"`));
  assert.match(d, /Sign in with Discord/);
  assert.doesNotMatch(d, /Fluxer/);

  // an event posted on Fluxer (its server key carries the prefix)
  const fluxer = await make(CH_STAFF, { guildId: `fluxer:${F_GUILD}` });
  const f = await text(await get(anon(), `/events/${fluxer.public_token}`));
  assert.match(f, new RegExp(`href="/auth/fluxer/login\\?next=/events/${fluxer.public_token}"`));
  assert.match(f, /Sign in with Fluxer/);
  assert.doesNotMatch(f, /Discord/);
});

test('an address that is no event gets the very same sign-in page, so the page does not show what exists', async () => {
  const real = await get(anon(), `/events/${staffEv.public_token}`);
  const realBody = masked(await text(real), staffEv.public_token);
  const shapes = new Set();
  for (let i = 0; i < 30; i += 1) {
    const token = randomToken();
    const res = await get(anon(), `/events/${token}`);
    assert.equal(res.status, real.status, 'same status');
    const body = masked(await text(res), token);
    shapes.add(body);
    assert.equal(res.headers.get('cache-control'), real.headers.get('cache-control'));
    assert.equal(res.headers.get('content-type'), real.headers.get('content-type'));
    // the only difference allowed is which login is offered
    assert.equal(
      body.replace(/Discord|Fluxer|discord|fluxer/g, 'X'),
      realBody.replace(/Discord|Fluxer|discord|fluxer/g, 'X')
    );
  }
  assert.equal(shapes.size, 2, 'the offered login varies with the address, not with whether an event exists');
  // and an address always gets the same one
  const token = randomToken();
  const first = masked(await text(await get(anon(), `/events/${token}`)), token);
  const again = masked(await text(await get(anon(), `/events/${token}`)), token);
  assert.equal(first, again);
});

test('everything that has no page for a visitor who is not signed in gives the same sign-in page', async () => {
  const statusOf = async (ev) => (await get(anon(), `/events/${ev.public_token}`)).status;
  const adult = await make(CH_ADULT);
  const gone = await make('100000000000000999'); // a channel Sylo does not have
  for (const ev of [staffEv, adult, gone]) assert.equal(await statusOf(ev), 401);
  await turnOn({}, true);
  assert.equal(await statusOf(staffEv), 401, 'setting off');
  await turnOn({ publicPages: true }, false);
  assert.equal(await statusOf(staffEv), 401, 'module off');
  await turnOn();
});

test('a malformed address is a plain not-found page', async () => {
  for (const path of [
    '/events/not-a-token',
    `/events/${'a'.repeat(31)}`,
    `/events/${'A'.repeat(32)}`,
    '/events/1',
  ]) {
    const res = await get(anon(), path);
    assert.equal(res.status, 404, path);
    assert.match(await text(res), NOT_FOUND);
  }
});

// --- after sign-in -----------------------------------------------------------------------------

test('a member who can see the channel gets the page', async () => {
  const res = await get(browsers.alice, `/events/${staffEv.public_token}`);
  assert.equal(res.status, 200);
  const html = await text(res);
  assert.match(html, new RegExp(staffEv.title));
  assert.match(html, /Bring the budget sheet/);
  assert.match(html, /Back room/);
  assert.match(html, /D-main/);
});

test('the page of a private event is private to the browser, not indexed, and carries no member name', async () => {
  const res = await get(browsers.alice, `/events/${staffEv.public_token}`);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  assert.match(res.headers.get('vary') ?? '', /cookie/i);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const html = await text(res);
  assert.match(html, /<meta name="robots" content="noindex/);
  assert.doesNotMatch(html, /og:|twitter:/i, 'no link-preview tags');
  assert.deepEqual(plainProblems(html), []);
  for (const hidden of [ALICE, BOB, STAFF, CH_STAFF, D_GUILD, 'ferdi', '900000000000000555']) {
    assert.ok(!html.includes(hidden), `the page must not hold ${hidden}`);
  }
  assert.ok(!html.includes('cdn.discordapp.com'), 'images come through Sylo');
});

test('a member whose data is not in the bot cache is looked up, and gets the page', async () => {
  fetches.length = 0;
  const res = await get(browsers.mod, `/events/${staffEv.public_token}`);
  assert.equal(res.status, 200);
  assert.deepEqual(fetches, [MOD]);
});

test('a signed-in person with no access sees exactly what a wrong address gives', async () => {
  const wrong = await get(browsers.bob, `/events/${randomToken()}`);
  assert.equal(wrong.status, 404);
  const wrongBody = await text(wrong);
  assert.match(wrongBody, NOT_FOUND);
  for (const who of ['bob', 'carol']) {
    const res = await get(browsers[who], `/events/${staffEv.public_token}`);
    assert.equal(res.status, wrong.status, who);
    assert.equal(await text(res), wrongBody, `${who}: same body`);
    for (const header of ['cache-control', 'x-robots-tag', 'content-type', 'vary', 'referrer-policy']) {
      assert.equal(res.headers.get(header), wrong.headers.get(header), `${who}: ${header}`);
    }
    assert.equal(wrong.headers.get('cache-control'), 'private, no-store');
  }
  assert.ok(!wrongBody.includes(staffEv.title));
});

test('every reason for no page gives the same answer to a signed-in person', async () => {
  const adult = await make(CH_ADULT);
  const gone = await make('100000000000000999');
  const wrong = await get(browsers.alice, `/events/${randomToken()}`);
  const wrongBody = await text(wrong);
  const cases = [
    ['an age-restricted channel', adult.public_token],
    ['a channel Sylo does not have', gone.public_token],
  ];
  for (const [why, token] of cases) {
    const res = await get(browsers.alice, `/events/${token}`);
    assert.equal(res.status, 404, why);
    assert.equal(await text(res), wrongBody, why);
  }
  for (const [why, setting, enabled] of [
    ['the setting off', {}, true],
    ['the module off', { publicPages: true }, false],
  ]) {
    await turnOn(setting, enabled);
    const res = await get(browsers.alice, `/events/${staffEv.public_token}`);
    assert.equal(res.status, 404, why);
    assert.equal(await text(res), wrongBody, why);
  }
  await turnOn();
  assert.equal((await get(browsers.alice, `/events/${staffEv.public_token}`)).status, 200);
});

// --- access is checked on every request --------------------------------------------------------

test('a person who loses the role loses the page on the next request, and gets it back when they regain it', async () => {
  for (let round = 0; round < 3; round += 1) {
    assert.equal(
      (await get(browsers.alice, `/events/${staffEv.public_token}`)).status,
      200,
      `round ${round}`
    );
    guild.members.cache.get(ALICE).roles.cache.delete(STAFF);
    const lost = await get(browsers.alice, `/events/${staffEv.public_token}`);
    assert.equal(lost.status, 404, `lost, round ${round}`);
    assert.doesNotMatch(await text(lost), new RegExp(staffEv.title));
    guild.members.cache.get(ALICE).roles.cache.set(STAFF, roles.get(STAFF));
  }
  assert.equal((await get(browsers.alice, `/events/${staffEv.public_token}`)).status, 200);
});

test('a person who leaves the server loses the page at once', async () => {
  assert.equal((await get(browsers.alice, `/events/${staffEv.public_token}`)).status, 200);
  expel(ALICE);
  assert.equal((await get(browsers.alice, `/events/${staffEv.public_token}`)).status, 404);
  enrol(ALICE, [STAFF]);
  assert.equal((await get(browsers.alice, `/events/${staffEv.public_token}`)).status, 200);
});

test('the channel closing to the person, or to the role, takes the page down at once', async () => {
  const saved = staffChannel.overwrites[STAFF];
  delete staffChannel.overwrites[STAFF];
  try {
    assert.equal((await get(browsers.alice, `/events/${staffEv.public_token}`)).status, 404);
  } finally {
    staffChannel.overwrites[STAFF] = saved;
  }
  assert.equal((await get(browsers.alice, `/events/${staffEv.public_token}`)).status, 200);
});

test('a person who is a member but cannot see the channel is refused', async () => {
  assert.equal((await get(browsers.bob, `/events/${staffEv.public_token}`)).status, 404);
  // until the channel gives them the view
  const bobRole = '900000000000000302';
  roles.set(bobRole, { id: bobRole, permissions: new PermissionsBitField(0n) });
  staffChannel.overwrites[bobRole] = { allow: P.ViewChannel, deny: 0n };
  guild.members.cache.get(BOB).roles.cache.set(bobRole, roles.get(bobRole));
  try {
    assert.equal((await get(browsers.bob, `/events/${staffEv.public_token}`)).status, 200);
  } finally {
    guild.members.cache.get(BOB).roles.cache.delete(bobRole);
    delete staffChannel.overwrites[bobRole];
    roles.delete(bobRole);
  }
  assert.equal((await get(browsers.bob, `/events/${staffEv.public_token}`)).status, 404);
});

test('Discord without the server-members intent: the cache is not trusted, the platform is asked every time', async () => {
  _setMembersIntent(() => false);
  try {
    fetches.length = 0;
    assert.equal((await get(browsers.alice, `/events/${staffEv.public_token}`)).status, 200);
    assert.deepEqual(fetches, [{ user: ALICE, force: true }], 'asked the platform, with force');

    // the cache still says Alice has the role; the platform says she has not
    const stale = guild.members.cache.get(ALICE);
    live.set(ALICE, memberOf(ALICE, []));
    guild.members.cache.set(ALICE, stale);
    const res = await get(browsers.alice, `/events/${staffEv.public_token}`);
    assert.equal(res.status, 404, 'a stale cached yes is not enough');
  } finally {
    _setMembersIntent(null);
    resetMembers();
  }
});

test('with the intent on the bot cache is used as is, and costs the platform nothing', async () => {
  fetches.length = 0;
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await get(browsers.alice, `/events/${staffEv.public_token}`)).status, 200);
  }
  assert.deepEqual(fetches, []);
});

// --- fail closed -------------------------------------------------------------------------------

test('what cannot be told is a no: errors, a lookup that fails, a member that is someone else, a bot that left', async () => {
  const url = `/events/${staffEv.public_token}`;
  const ok = async () => assert.equal((await get(browsers.alice, url)).status, 200);
  await ok();

  const permissionsFor = staffChannel.permissionsFor;
  staffChannel.permissionsFor = () => {
    throw new Error('boom');
  };
  assert.equal((await get(browsers.alice, url)).status, 404, 'permissionsFor throws');
  staffChannel.permissionsFor = () => null;
  assert.equal((await get(browsers.alice, url)).status, 404, 'no permissions known');
  staffChannel.permissionsFor = permissionsFor;
  await ok();

  // a cached member that is not the person
  const alice = guild.members.cache.get(ALICE);
  guild.members.cache.set(ALICE, memberOf(BOB, [STAFF]));
  assert.equal((await get(browsers.alice, url)).status, 404, 'a member object of someone else');
  guild.members.cache.set(ALICE, alice);

  // the lookup fails
  const cached = guild.members.cache.get(MOD);
  assert.equal(cached, undefined);
  const fetchMember = guild.members.fetch;
  guild.members.fetch = async () => {
    throw new Error('Discord is down');
  };
  assert.equal((await get(browsers.mod, url)).status, 404, 'the lookup fails');
  guild.members.fetch = async () => ({ id: MOD, user: { id: MOD } }); // no roles at all
  assert.equal((await get(browsers.mod, url)).status, 404, 'a member with unreadable data');
  guild.members.fetch = fetchMember;
  assert.equal((await get(browsers.mod, url)).status, 200);

  // the bot is no longer in the server
  runtime.clients.discord.guilds.cache.delete(D_GUILD);
  assert.equal((await get(browsers.alice, url)).status, 404, 'the bot left');
  runtime.clients.discord.guilds.cache.set(D_GUILD, guild);
  await ok();
});

test(
  'a lookup that never answers is a no, after a limit',
  { timeout: MEMBER_LOOKUP_MS + 10_000 },
  async () => {
    const fetchMember = guild.members.fetch;
    guild.members.fetch = () => new Promise(() => {});
    try {
      const started = Date.now();
      const res = await get(browsers.mod, `/events/${staffEv.public_token}`);
      assert.equal(res.status, 404);
      assert.ok(Date.now() - started >= MEMBER_LOOKUP_MS - 100, 'it waited for the limit');
    } finally {
      guild.members.fetch = fetchMember;
    }
  }
);

test('a Discord id never opens a Fluxer page, and a Fluxer id never opens a Discord page', async () => {
  const wrong = await text(await get(browsers.alice, `/events/${randomToken()}`));
  // a Fluxer account whose id is the id of Alice on Discord
  const { b: fluxerAlice } = await signedIn('fluxer', ALICE);
  const res = await get(fluxerAlice, `/events/${staffEv.public_token}`);
  assert.equal(res.status, 404, 'signed in, but not with the platform of this event');
  const html = await text(res);
  assert.equal(html, wrong, 'the same page as a wrong address');
  assert.ok(!html.includes(staffEv.title));
  assert.equal((await get(fluxerAlice, `/events/${staffEv.public_token}/icon`)).status, 404);

  // the other way: a Discord account on an event posted on Fluxer. The Fluxer server here is a
  // real one for Sylo (module on, a channel the member can see, the member in its cache), so the
  // only thing that refuses the Discord account is that it has no Fluxer identity.
  const fGuild = runtime.clients.fluxer.guilds.cache.get(F_GUILD);
  const sees = { has: (p) => p === 'ViewChannel' };
  fGuild.nsfw = false;
  fGuild.roles = { cache: new Map(), everyone: { id: F_GUILD } };
  fGuild.channels.cache.set(CH_STAFF, {
    id: CH_STAFF,
    nsfw: false,
    nsfwOverride: null,
    parentId: null,
    isThread: () => false,
    permissionsFor: (target) => (target?.roles ? sees : { has: () => false }),
  });
  const fMember = memberOf(ALICE, [STAFF]);
  fGuild.members = { cache: new Map([[ALICE, fMember]]), fetch: async () => fMember };
  await setGuildModule(`fluxer:${F_GUILD}`, 'events', { enabled: true, config: { publicPages: true } });
  const fluxerEvent = await make(CH_STAFF, { guildId: `fluxer:${F_GUILD}` });
  const url = `/events/${fluxerEvent.public_token}`;
  const { b: fluxerMember } = await signedIn('fluxer', ALICE);
  assert.equal((await get(fluxerMember, url)).status, 200, 'the same person with a Fluxer login is let in');
  const back = await get(browsers.alice, url);
  assert.equal(back.status, 404, 'a Discord login is not');
  assert.equal(await text(back), wrong);
});

// --- a channel that changes --------------------------------------------------------------------

test('a channel that turns private moves its page to sign-in at the next request, and back again', async () => {
  const ch = channels.get(CH_PUBLIC);
  const open = ch.overwrites[D_GUILD];
  const ev = await make(CH_PUBLIC);
  const url = `/events/${ev.public_token}`;
  for (let i = 0; i < 2; i += 1) {
    const publicPage = await get(anon(), url);
    assert.equal(publicPage.status, 200, 'public: no sign-in needed');
    assert.ok((await text(publicPage)).includes(ev.title));
    assert.equal(publicPage.headers.get('cache-control'), 'no-store', 'a public page is as it was');

    ch.overwrites[D_GUILD] = { allow: 0n, deny: P.ViewChannel };
    try {
      const signIn = await get(anon(), url);
      assert.equal(signIn.status, 401, 'private: sign-in');
      assert.ok(!(await text(signIn)).includes(ev.title));
      assert.equal((await get(browsers.bob, url)).status, 404, 'a member without access');
      // everyone who can see it through a role still can: give Alice the view
      ch.overwrites[STAFF] = { allow: P.ViewChannel, deny: 0n };
      assert.equal((await get(browsers.alice, url)).status, 200);
      delete ch.overwrites[STAFF];
    } finally {
      ch.overwrites[D_GUILD] = open;
    }
  }
});

test('an event in a public channel is open to a signed-in person too, and keeps the public cache rule', async () => {
  const ev = await make(CH_PUBLIC);
  const res = await get(browsers.bob, `/events/${ev.public_token}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

// --- age-restricted channels -------------------------------------------------------------------

test('an age-restricted channel has no page for anyone, member or not', async () => {
  for (const channelId of [CH_ADULT, CH_ADULT_PUBLIC]) {
    const ev = await make(channelId);
    const url = `/events/${ev.public_token}`;
    const wrong = await text(await get(browsers.alice, `/events/${randomToken()}`));
    for (const who of ['alice', 'bob', 'carol', 'mod']) {
      const res = await get(browsers[who], url);
      assert.equal(res.status, 404, `${channelId} ${who}`);
      assert.equal(await text(res), wrong, `${channelId} ${who}: as a wrong address`);
    }
    for (const sub of ['icon', 'image']) {
      assert.equal((await get(browsers.alice, `${url}/${sub}`)).status, 404, `${channelId} ${sub}`);
    }
    assert.equal((await get(anon(), url)).status, 401, 'not signed in: the same neutral sign-in page');
  }
  // a staff member with Administrator sees nothing either: the rule is the platform's age gate
  roles.set('900000000000000399', {
    id: '900000000000000399',
    permissions: new PermissionsBitField(P.Administrator),
  });
  guild.members.cache.get(ALICE).roles.cache.set('900000000000000399', roles.get('900000000000000399'));
  try {
    const ev = await make(CH_ADULT);
    assert.equal((await get(browsers.alice, `/events/${ev.public_token}`)).status, 404);
  } finally {
    guild.members.cache.get(ALICE).roles.cache.delete('900000000000000399');
    roles.delete('900000000000000399');
  }
});

test('a channel that becomes age-restricted takes its page down at the next request', async () => {
  const url = `/events/${staffEv.public_token}`;
  assert.equal((await get(browsers.alice, url)).status, 200);
  staffChannel.nsfw = true;
  try {
    assert.equal((await get(browsers.alice, url)).status, 404);
    assert.equal((await get(browsers.alice, `${url}/icon`)).status, 404);
  } finally {
    staffChannel.nsfw = false;
  }
  assert.equal((await get(browsers.alice, url)).status, 200);
});

// --- threads -----------------------------------------------------------------------------------

test('a public thread follows its parent channel; a private thread has no page', async () => {
  const pub = await make(TH_PUBLIC);
  assert.equal(
    (await get(browsers.alice, `/events/${pub.public_token}`)).status,
    200,
    'staff see the thread'
  );
  assert.equal((await get(browsers.bob, `/events/${pub.public_token}`)).status, 404, 'others do not');

  const priv = await make(TH_PRIVATE);
  channels.get(TH_PRIVATE)._members.set(ALICE, { id: ALICE });
  assert.equal(
    (await get(browsers.alice, `/events/${priv.public_token}`)).status,
    404,
    'a private thread: no page, even for a thread member'
  );
  assert.equal((await get(anon(), `/events/${priv.public_token}`)).status, 401);
});

// --- the images --------------------------------------------------------------------------------

test('the icon and the image follow the page: served to a member, private and never kept', async () => {
  const url = `/events/${staffEv.public_token}`;
  for (const asset of ['icon', 'image']) {
    const res = await get(browsers.alice, `${url}/${asset}`);
    assert.equal(res.status, 200, asset);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'private, no-store', asset);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/);
    assert.match(res.headers.get('vary') ?? '', /cookie/i);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  }
  const html = await text(await get(browsers.alice, url));
  assert.match(html, new RegExp(`src="${url}/icon"`));
  assert.match(html, new RegExp(`src="${url}/image"`));
});

test('without access the icon and the image give nothing: the sign-in page, or the not-found page', async () => {
  const url = `/events/${staffEv.public_token}`;
  const wrong = await get(browsers.bob, `/events/${randomToken()}/icon`);
  const wrongBody = await text(wrong);
  assert.equal(wrong.status, 404);
  for (const asset of ['icon', 'image']) {
    for (const who of ['bob', 'carol']) {
      const res = await get(browsers[who], `${url}/${asset}`);
      assert.equal(res.status, 404, `${who} ${asset}`);
      assert.equal(await text(res), wrongBody);
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      assert.notEqual(res.headers.get('content-type'), 'image/png');
    }
    const signIn = await get(anon(), `${url}/${asset}`);
    assert.equal(signIn.status, 401, `anon ${asset}`);
    assert.match(signIn.headers.get('content-type'), /html/);
    assert.ok(!Buffer.from(await signIn.arrayBuffer()).includes('secret'), 'none of the image bytes');
  }
});

test('the image cache on the server cannot hand the bytes to a person without access', async () => {
  _clearImageCache();
  imageCalls.length = 0;
  const url = `/events/${staffEv.public_token}/image`;
  const bytes = async (res) => Buffer.from(await res.arrayBuffer());

  // a member warms the cache
  assert.deepEqual(await bytes(await get(browsers.alice, url)), PNG);
  const afterWarm = imageCalls.length;
  assert.ok(afterWarm >= 1);

  // nobody else gets the bytes while they are cached
  for (const who of ['bob', 'carol']) {
    const res = await get(browsers[who], url);
    assert.equal(res.status, 404, who);
    assert.ok(!(await bytes(res)).includes('secret'), who);
  }
  const noSession = await get(anon(), url);
  assert.ok(!(await bytes(noSession)).includes('secret'));

  // a member who loses access does not get them either, though the bytes are still cached
  guild.members.cache.get(ALICE).roles.cache.delete(STAFF);
  const lost = await get(browsers.alice, url);
  assert.equal(lost.status, 404);
  assert.ok(!(await bytes(lost)).includes('secret'));
  guild.members.cache.get(ALICE).roles.cache.set(STAFF, roles.get(STAFF));

  // and a person who is no member of any server, asking for an event they know the address of
  const stranger = await get(browsers.carol, `/events/${staffEv.public_token}/icon`);
  assert.equal(stranger.status, 404);
  assert.equal(imageCalls.length, afterWarm, 'the refusals fetched nothing and read nothing from the cache');
});

// --- the login: where it goes back to ---------------------------------------------------------

test('the sign-in link comes back to the event page after the login', async () => {
  const path = `/events/${staffEv.public_token}`;
  const page = await text(await get(anon(), path));
  const href = page.match(/href="(\/auth\/discord\/login\?next=[^"]+)"/)[1];
  setProfiles({ discordId: ALICE });
  const b = browser();
  const ip = clientNow();
  const start = await b.get(href, asClient(ip));
  assert.equal(start.status, 302);
  assert.match(start.headers.get('location'), /^https:\/\/discord\.com\/oauth2\/authorize/);
  const done = await b.get(`/auth/discord/callback?code=abc&state=${stateOf(start)}`, asClient(ip));
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), path, 'back to the page, and nowhere else');
  const after = await get(b, path);
  assert.equal(after.status, 200);
  assert.ok((await text(after)).includes(staffEv.title));
});

test('the login never goes back to another site, whatever the request says', async () => {
  const evil = [
    '//evil.example/x',
    '///evil.example',
    '/\\evil.example',
    'https://evil.example/',
    'http://evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    '/events/..//evil.example',
    '%2F%2Fevil.example',
  ];
  for (const next of evil) {
    setProfiles({ discordId: ALICE });
    const b = browser();
    const ip = clientNow();
    const start = await b.get(`/auth/discord/login?next=${encodeURIComponent(next)}`, asClient(ip));
    const done = await b.get(`/auth/discord/callback?code=abc&state=${stateOf(start)}`, asClient(ip));
    assert.equal(done.status, 302, next);
    const where = done.headers.get('location');
    assert.equal(new URL(where, 'http://dashboard.test').host, 'dashboard.test', `${next} -> ${where}`);
    assert.ok(where.startsWith('/') && !where.startsWith('//'), `${next} -> ${where}`);
  }
  // the address the sign-in page links to is built from the token, not from anything in the request
  for (const query of [
    '?next=//evil.example',
    '?next=https://evil.example',
    '?redirect=//evil.example',
    '?returnTo=//evil.example',
  ]) {
    const html = await text(await get(anon(), `/events/${staffEv.public_token}${query}`));
    assert.ok(!html.includes('evil'), query);
    assert.match(html, new RegExp(`href="/auth/discord/login\\?next=/events/${staffEv.public_token}"`));
  }
  // an address that is not a token never reaches the login at all
  const odd = await get(anon(), '/events/%2F%2Fevil.example');
  assert.equal(odd.status, 404);
  assert.ok(!(await text(odd)).includes('evil'));
});

// --- erasure -----------------------------------------------------------------------------------

test('/forget by the host leaves a members-only page as it was, without a host to show', async () => {
  const { setEventParticipant } = await import('../src/db/events.js');
  const { forgetUser } = await import('../src/db/purge.js');
  const mine = await make(CH_STAFF, { title: 'Mine', hostId: BOB });
  await setEventParticipant(mine.id, BOB, 'join');
  const url = `/events/${mine.public_token}`;
  assert.match(await text(await get(browsers.alice, url)), /<dt>Going<\/dt>\s*<dd>1 of 10 spots<\/dd>/);
  await forgetUser(D_GUILD, BOB);
  const html = await text(await get(browsers.alice, url));
  assert.match(html, /Mine/);
  assert.match(html, /<dt>Going<\/dt>\s*<dd>0 of 10 spots<\/dd>/, 'their sign-up is gone from the count');
  assert.ok(!html.includes(BOB), 'no member id on the page');
});

test('when Sylo leaves the server, the events and their members-only pages are gone', async () => {
  const { clearGuildEvents } = await import('../src/db/events.js');
  const doomed = await make(CH_STAFF, { title: 'Doomed' });
  const url = `/events/${doomed.public_token}`;
  assert.equal((await get(browsers.alice, url)).status, 200);
  await clearGuildEvents(D_GUILD);
  const wrong = await text(await get(browsers.alice, `/events/${randomToken()}`));
  const res = await get(browsers.alice, url);
  assert.equal(res.status, 404);
  assert.equal(await text(res), wrong);
  assert.equal((await get(browsers.alice, `${url}/icon`)).status, 404);
  // and not signed in, it is the sign-in page like any address that is no event
  assert.equal((await get(anon(), url)).status, 401);
  staffEv = await make(CH_STAFF); // the other tests of this file go on with a fresh event
});

// --- limits and logs -----------------------------------------------------------------------------

test('the same rate limit as the public page: 40 requests a minute per client, then 429', async () => {
  const ip = '10.99.99.9';
  const b = anon();
  for (let i = 0; i < 40; i += 1) {
    const res = await b.get(`/events/${staffEv.public_token}`, asClient(ip));
    assert.equal(res.status, 401, `request ${i + 1}`);
  }
  const limited = await b.get(`/events/${staffEv.public_token}`, asClient(ip));
  assert.equal(limited.status, 429);
  assert.ok(!(await text(limited)).includes(staffEv.title));
  // the images share the limit
  assert.equal((await b.get(`/events/${staffEv.public_token}/icon`, asClient(ip))).status, 429);
});

test('the response never carries the address in a header that logs or analytics read', async () => {
  const res = await get(anon(), `/events/${staffEv.public_token}`);
  for (const [name, value] of res.headers) {
    if (['set-cookie'].includes(name)) continue;
    assert.ok(!value.includes(staffEv.public_token), `${name} holds the token`);
  }
  assert.equal(res.headers.get('location'), null);
});
