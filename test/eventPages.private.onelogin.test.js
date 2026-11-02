// The event pages on a dashboard that offers only the Discord login (no Fluxer login configured) while
// the bot is also in a Fluxer server. A visitor who is not signed in must get the same answer for an
// event on the platform without a login as for an address that is no event, so the status does not
// show that the event exists or where it was posted.
import './helpers/trustLoopbackProxy.js';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SYLO_TEST_NO_FLUXER_LOGIN = '1';
const { D_GUILD, F_GUILD, browser, setProfiles, startOAuthApp, stateOf } =
  await import('./helpers/oauthApp.js');
await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { config } = await import('../src/config.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { createEvent, getEvent } = await import('../src/db/events.js');
const { eventAudience, _setViewerCache } = await import('../src/modules/lib/eventPage.js');
_setViewerCache({ ttlMs: 0 });

const ALICE = '900000000000000401';
const CH = '100000000000000102';
const sees = { has: (p) => p === 'ViewChannel' };
const nobody = { has: () => false };

/** A guild whose one channel only its member can see. Works for both fake guilds of the OAuth harness. */
function arrange(guild) {
  const member = { id: ALICE, user: { id: ALICE }, roles: { cache: new Map() } };
  guild.nsfw = false;
  guild.roles = { cache: new Map(), everyone: { id: guild.id } };
  guild.channels.cache.set(CH, {
    id: CH,
    nsfw: false,
    nsfwOverride: null,
    parentId: null,
    isThread: () => false,
    permissionsFor: (target) => (target?.roles ? sees : nobody),
  });
  guild.members = { cache: new Map([[ALICE, member]]), fetch: async () => member };
}
arrange(runtime.clients.discord.guilds.cache.get(D_GUILD));
arrange(runtime.clients.fluxer.guilds.cache.get(F_GUILD));

const FLUXER_KEY = `fluxer:${F_GUILD}`;
let sent = 0;
const clientNow = () => `10.50.${Math.floor(sent++ / 25)}.1`;
const asClient = (ip) => ({ headers: { 'x-forwarded-for': ip } });
const get = (b, path) => b.get(path, asClient(clientNow()));
const text = (res) => res.text();
const randomToken = () =>
  [...Array(32)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
const masked = (html, token) => html.split(token).join('<token>');

async function make(guildId) {
  const { id } = await createEvent({
    guildId,
    channelId: CH,
    title: 'Only for the team',
    startAt: Date.UTC(2030, 0, 5, 18, 0),
    hostId: '900000000000000555',
  });
  return getEvent(id);
}

let discordEvent;
let fluxerEvent;
let alice;
test.before(async () => {
  await setGuildModule(D_GUILD, 'events', { enabled: true, config: { publicPages: true } });
  await setGuildModule(FLUXER_KEY, 'events', { enabled: true, config: { publicPages: true } });
  discordEvent = await make(D_GUILD);
  fluxerEvent = await make(FLUXER_KEY);
  setProfiles({ discordId: ALICE });
  alice = browser();
  const ip = clientNow();
  const start = await alice.get('/auth/discord/login', asClient(ip));
  await alice.get(`/auth/discord/callback?code=abc&state=${stateOf(start)}`, asClient(ip));
});

test('the setup is what the test says: a Discord login only', () => {
  assert.equal(config.discordAuthEnabled, true);
  assert.equal(config.fluxerAuthEnabled, false);
});

test('a visitor who is not signed in gets the same sign-in page for a Fluxer event, a Discord event and an unknown address', async () => {
  const bodies = [];
  for (const token of [fluxerEvent.public_token, discordEvent.public_token, randomToken(), randomToken()]) {
    const res = await get(browser(), `/events/${token}`);
    assert.equal(res.status, 401, token === fluxerEvent.public_token ? 'the Fluxer event' : 'the rest');
    const html = await text(res);
    assert.match(html, /Log in with Discord/, 'the only login there is');
    assert.ok(!html.includes('Fluxer'));
    assert.ok(!html.includes('Only for the team'));
    bodies.push(masked(html, token));
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal(new Set(bodies).size, 1, 'byte for byte the same apart from the address');
  // the same for the images
  for (const token of [fluxerEvent.public_token, randomToken()]) {
    assert.equal((await get(browser(), `/events/${token}/icon`)).status, 401);
  }
});

test('a signed-in person gets the usual 404 for the Fluxer event, as for a wrong address, and the page for their own', async () => {
  const wrong = await get(alice, `/events/${randomToken()}`);
  assert.equal(wrong.status, 404);
  const wrongBody = await text(wrong);
  const res = await get(alice, `/events/${fluxerEvent.public_token}`);
  assert.equal(res.status, 404);
  assert.equal(await text(res), wrongBody);
  assert.equal((await get(alice, `/events/${fluxerEvent.public_token}/image`)).status, 404);
  assert.equal(
    (await get(alice, `/events/${discordEvent.public_token}`)).status,
    200,
    'the Discord event opens'
  );
});

test('no page is offered for a private channel of the platform without a login', () => {
  const dGuild = runtime.clients.discord.guilds.cache.get(D_GUILD);
  const fGuild = runtime.clients.fluxer.guilds.cache.get(F_GUILD);
  assert.equal(eventAudience(dGuild, discordEvent), 'private');
  assert.equal(eventAudience(fGuild, fluxerEvent), 'none', 'nobody could sign in with Fluxer');
});
