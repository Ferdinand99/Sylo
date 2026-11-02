// The sign-in event pages on Fluxer, against the real SDK classes (Role, GuildRoleManager, the
// channel classes made by Channel.from, GuildMember and the overwrite manager) with the compat layer
// installed, through the real Express app (helpers/oauthApp.js). The compat layer's permission check
// for a member is the one that decides: nothing here fakes permissionsFor.
//
// Not covered, because it needs a live Fluxer server: that the bot's real member cache and the real
// members.fetch() behave as the SDK source says (see the PR notes).
import './helpers/trustLoopbackProxy.js';
// helpers/oauthApp.js first: it points the database at a temporary file before anything loads src/config.js
import { D_GUILD, F_GUILD, browser, setProfiles, startOAuthApp, stateOf } from './helpers/oauthApp.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@fluxerjs/core';
import { Collection } from '@fluxerjs/collection';
import { installFluxerCompat } from '../src/platform/compat.js';

installFluxerCompat(sdk, { Collection });
await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { createEvent, getEvent } = await import('../src/db/events.js');
const { channelAudience, viewerMaySee } = await import('../src/modules/lib/eventPage.js');
const { _clearImageCache, _setImageFetcher } = await import('../src/modules/lib/eventImage.js');

const KEY = `fluxer:${F_GUILD}`;
const F = sdk.PermissionFlags;
const STAFF = '900000000000000801';
const ADMIN = '900000000000000802';
const STAFF_USER = '900000000000000811';
const PLAIN_USER = '900000000000000812';
const ADMIN_USER = '900000000000000813';
const OUTSIDER = '900000000000000814';
const CHANNEL = {
  open: '900000000000000821',
  staff: '900000000000000822',
  adult: '900000000000000823',
  underCategory: '900000000000000824',
  category: '900000000000000825',
  noCategoryInfo: '900000000000000826',
  categoryNoField: '900000000000000827',
};

const client = runtime.clients.fluxer;
const guild = client.guilds.cache.get(F_GUILD);
// the SDK's channels find their server through client.guilds.get()
client.guilds.get = (id) => client.guilds.cache.get(id);
client.getOrCreateUser = (user) => user;

const roleData = (id, permissions, position = 0) => ({
  id,
  name: id === F_GUILD ? '@everyone' : `role-${id.slice(-3)}`,
  color: 0,
  position,
  permissions: String(permissions),
});
const roles = new sdk.GuildRoleManager(F_GUILD, {});
roles.set(F_GUILD, new sdk.Role(client, roleData(F_GUILD, F.ViewChannel | F.SendMessages), F_GUILD));
roles.set(STAFF, new sdk.Role(client, roleData(STAFF, F.SendMessages, 3), F_GUILD));
roles.set(ADMIN, new sdk.Role(client, roleData(ADMIN, F.Administrator, 5), F_GUILD));
const overwrite = (id, { allow = 0n, deny = 0n } = {}) => ({
  id,
  type: sdk.OverwriteType.Role,
  allow: String(allow),
  deny: String(deny),
});
const staffOnly = [overwrite(F_GUILD, { deny: F.ViewChannel }), overwrite(STAFF, { allow: F.ViewChannel })];
const channelFrom = (id, over = {}) =>
  sdk.Channel.from(client, {
    id,
    type: 0,
    guild_id: F_GUILD,
    name: `chan-${id.slice(-3)}`,
    parent_id: null,
    permission_overwrites: [],
    nsfw: false,
    nsfw_override: null,
    ...over,
  });

const channels = new Collection();
guild.roles = roles;
guild.channels = channels;
guild.nsfw = false;
guild.ownerId = '900000000000000899';
guild.iconURL = () => null;
channels.set(CHANNEL.open, channelFrom(CHANNEL.open));
channels.set(CHANNEL.staff, channelFrom(CHANNEL.staff, { permission_overwrites: staffOnly }));
channels.set(
  CHANNEL.adult,
  channelFrom(CHANNEL.adult, { permission_overwrites: staffOnly, nsfw: true, nsfw_override: true })
);
channels.set(
  CHANNEL.category,
  sdk.Channel.from(client, {
    id: CHANNEL.category,
    type: 4,
    guild_id: F_GUILD,
    name: 'Adults',
    nsfw_override: true,
  })
);
channels.set(
  CHANNEL.underCategory,
  channelFrom(CHANNEL.underCategory, { permission_overwrites: staffOnly, parent_id: CHANNEL.category })
);
// a channel that names a category the bot has not seen
channels.set(
  CHANNEL.noCategoryInfo,
  channelFrom(CHANNEL.noCategoryInfo, { permission_overwrites: staffOnly, parent_id: '900000000000000999' })
);

const memberData = (id, roleIds) => ({
  user: { id, username: `user${id.slice(-3)}`, discriminator: '0', global_name: null, avatar: null },
  roles: roleIds,
  joined_at: new Date(0).toISOString(),
});
const members = new Collection();
const live = new Map(); // what the platform says, apart from the bot's cache
guild.members = members;
members.fetch = async (arg) => {
  const id = typeof arg === 'string' ? arg : arg?.user;
  const m = live.get(id);
  if (!m) throw new Error('Unknown Member');
  return m;
};
const enrol = (id, roleIds, { cached = true } = {}) => {
  const m = new sdk.GuildMember(client, memberData(id, roleIds), guild);
  live.set(id, m);
  if (cached) members.set(id, m);
  else members.delete(id);
  return m;
};
enrol(STAFF_USER, [STAFF]);
enrol(PLAIN_USER, []);
enrol(ADMIN_USER, [ADMIN]);

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fluxer-secret'),
]);
_setImageFetcher(async () => ({
  status: 200,
  ok: true,
  headers: new Headers({ 'content-type': 'image/png' }),
  body: PNG,
}));
_clearImageCache();
test.after(() => _setImageFetcher(null));

// --- the compat layer's check, on the real classes ------------------------------------------------

test('channel.permissionsFor(member) is the compat layer on the SDK classes, and it follows the overwrites', () => {
  const staff = channels.get(CHANNEL.staff);
  assert.ok(staff.permissionsFor(members.get(STAFF_USER)) instanceof sdk.PermissionsBitField);
  assert.equal(staff.permissionsFor(members.get(STAFF_USER)).has('ViewChannel'), true);
  assert.equal(staff.permissionsFor(members.get(PLAIN_USER)).has('ViewChannel'), false);
  assert.equal(staff.permissionsFor(members.get(ADMIN_USER)).has('ViewChannel'), true, 'Administrator');
  assert.equal(channels.get(CHANNEL.open).permissionsFor(members.get(PLAIN_USER)).has('ViewChannel'), true);
});

test('channelAudience on Fluxer: public, private, or none for an age-restricted channel', () => {
  assert.equal(channelAudience(guild, CHANNEL.open), 'public');
  assert.equal(channelAudience(guild, CHANNEL.staff), 'private');
  assert.equal(channelAudience(guild, CHANNEL.adult), 'none', 'the channel itself');
  assert.equal(channelAudience(guild, CHANNEL.underCategory), 'none', 'its category is age-restricted');
  assert.equal(
    channelAudience(guild, CHANNEL.noCategoryInfo),
    'none',
    'a category Sylo has not seen: fail closed'
  );
  assert.equal(channelAudience(guild, '900000000000000998'), 'none', 'a channel Sylo does not have');
});

test('channelAudience on Fluxer: an age-restricted server makes every channel without its own override none', () => {
  guild.nsfw = true;
  try {
    assert.equal(channelAudience(guild, CHANNEL.open), 'none');
    assert.equal(channelAudience(guild, CHANNEL.staff), 'none');
  } finally {
    guild.nsfw = false;
  }
  assert.equal(channelAudience(guild, CHANNEL.staff), 'private');
});

test('viewerMaySee on Fluxer, with real members: roles, Administrator, the owner, and the age rule', async () => {
  assert.equal(await viewerMaySee(guild, CHANNEL.staff, STAFF_USER), true);
  assert.equal(await viewerMaySee(guild, CHANNEL.staff, PLAIN_USER), false);
  assert.equal(await viewerMaySee(guild, CHANNEL.staff, ADMIN_USER), true);
  assert.equal(await viewerMaySee(guild, CHANNEL.staff, OUTSIDER), false, 'not in the server');
  assert.equal(await viewerMaySee(guild, CHANNEL.adult, STAFF_USER), false, 'age-restricted');
  assert.equal(
    await viewerMaySee(guild, CHANNEL.adult, ADMIN_USER),
    false,
    'age-restricted, even for Administrator'
  );
  assert.equal(
    await viewerMaySee(guild, CHANNEL.underCategory, STAFF_USER),
    false,
    'under an age-restricted category'
  );
  // the owner sees everything the age rule allows
  guild.ownerId = PLAIN_USER;
  try {
    assert.equal(await viewerMaySee(guild, CHANNEL.staff, PLAIN_USER), true);
  } finally {
    guild.ownerId = '900000000000000899';
  }
});

test('viewerMaySee on Fluxer: a role taken away from the real member is a no at the next call', async () => {
  const m = members.get(STAFF_USER);
  assert.equal(await viewerMaySee(guild, CHANNEL.staff, STAFF_USER), true);
  m.roles.ids.splice(m.roles.ids.indexOf(STAFF), 1);
  assert.equal(await viewerMaySee(guild, CHANNEL.staff, STAFF_USER), false);
  m.roles.ids.push(STAFF);
  assert.equal(await viewerMaySee(guild, CHANNEL.staff, STAFF_USER), true);
});

// --- the pages --------------------------------------------------------------------------------

let sent = 0;
const clientNow = () => `10.40.${Math.floor(sent++ / 25)}.1`;
const asClient = (ip) => ({ headers: { 'x-forwarded-for': ip } });
const get = (b, path) => b.get(path, asClient(clientNow()));
async function signedIn(platform, id) {
  setProfiles(platform === 'discord' ? { discordId: id } : { fluxerId: id });
  const b = browser();
  const ip = clientNow();
  const start = await b.get(`/auth/${platform}/login`, asClient(ip));
  const done = await b.get(`/auth/${platform}/callback?code=abc&state=${stateOf(start)}`, asClient(ip));
  assert.equal(done.status, 302);
  return b;
}
const who = {};
test.before(async () => {
  who.staff = await signedIn('fluxer', STAFF_USER);
  who.plain = await signedIn('fluxer', PLAIN_USER);
  who.outsider = await signedIn('fluxer', OUTSIDER);
  who.discordStaff = await signedIn('discord', STAFF_USER); // a Discord account with the same number
  await setGuildModule(KEY, 'events', { enabled: true, config: { publicPages: true } });
});

let seq = 0;
async function make(channelId, over = {}) {
  seq += 1;
  const { id } = await createEvent({
    guildId: KEY,
    channelId,
    title: `Fluxer plans ${seq}`,
    description: 'Only for the team',
    location: 'Back room',
    imageUrl: 'https://cdn.discordapp.com/attachments/1/2/poster.png',
    startAt: Date.UTC(2030, 0, 5, 18, 0),
    hostId: '900000000000000555',
    ...over,
  });
  return getEvent(id);
}
const text = (res) => res.text();
const anon = () => browser();
const randomToken = () =>
  [...Array(32)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

test('a visitor who is not signed in gets the neutral page with the Fluxer login', async () => {
  const ev = await make(CHANNEL.staff);
  const res = await get(anon(), `/events/${ev.public_token}`);
  assert.equal(res.status, 401);
  const html = await text(res);
  assert.match(html, new RegExp(`href="/auth/fluxer/login\\?next=/events/${ev.public_token}"`));
  assert.doesNotMatch(html, /Discord/);
  assert.ok(!html.includes(ev.title));
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
});

test('a Fluxer member who can see the channel gets the page, and the images', async () => {
  const ev = await make(CHANNEL.staff);
  const url = `/events/${ev.public_token}`;
  const res = await get(who.staff, url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.ok((await text(res)).includes(ev.title));
  const image = await get(who.staff, `${url}/image`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
});

test('a Fluxer member without access, and a person who is not a member, get the wrong-address page', async () => {
  const ev = await make(CHANNEL.staff);
  const wrong = await get(who.plain, `/events/${randomToken()}`);
  const wrongBody = await text(wrong);
  assert.equal(wrong.status, 404);
  for (const b of [who.plain, who.outsider]) {
    const res = await get(b, `/events/${ev.public_token}`);
    assert.equal(res.status, 404);
    assert.equal(await text(res), wrongBody);
    for (const asset of ['icon', 'image']) {
      const img = await get(b, `/events/${ev.public_token}/${asset}`);
      assert.equal(img.status, 404, asset);
      assert.ok(!Buffer.from(await img.arrayBuffer()).includes('fluxer-secret'));
    }
  }
});

test('access is checked live: a lost role and a departure take the page down at once', async () => {
  const ev = await make(CHANNEL.staff);
  const url = `/events/${ev.public_token}`;
  const m = members.get(STAFF_USER);
  assert.equal((await get(who.staff, url)).status, 200);
  m.roles.ids.splice(m.roles.ids.indexOf(STAFF), 1);
  assert.equal((await get(who.staff, url)).status, 404, 'role removed');
  assert.equal((await get(who.staff, `${url}/image`)).status, 404, 'and its image');
  m.roles.ids.push(STAFF);
  assert.equal((await get(who.staff, url)).status, 200);
  members.delete(STAFF_USER);
  live.delete(STAFF_USER);
  assert.equal((await get(who.staff, url)).status, 404, 'left the server');
  enrol(STAFF_USER, [STAFF]);
  assert.equal((await get(who.staff, url)).status, 200);
});

test('the Discord account with the same number is not the Fluxer member', async () => {
  const ev = await make(CHANNEL.staff);
  const wrong = await text(await get(who.discordStaff, `/events/${randomToken()}`));
  const res = await get(who.discordStaff, `/events/${ev.public_token}`);
  assert.equal(res.status, 404, 'signed in, but not with Fluxer');
  const html = await text(res);
  assert.equal(html, wrong);
  assert.ok(!html.includes(ev.title));
});

test('an age-restricted channel on Fluxer has no page for a member: the channel, its category, the server', async () => {
  const wrongBody = await text(await get(who.staff, `/events/${randomToken()}`));
  for (const channelId of [CHANNEL.adult, CHANNEL.underCategory, CHANNEL.noCategoryInfo]) {
    const ev = await make(channelId);
    const res = await get(who.staff, `/events/${ev.public_token}`);
    assert.equal(res.status, 404, channelId);
    assert.equal(await text(res), wrongBody, channelId);
  }
  guild.nsfw = true;
  try {
    const ev = await make(CHANNEL.staff);
    assert.equal(
      (await get(who.staff, `/events/${ev.public_token}`)).status,
      404,
      'an age-restricted server'
    );
  } finally {
    guild.nsfw = false;
  }
});

test('a public Fluxer channel still works without sign-in, and turns to sign-in when it closes', async () => {
  const ev = await make(CHANNEL.open);
  const url = `/events/${ev.public_token}`;
  assert.equal((await get(anon(), url)).status, 200);
  const open = channels.get(CHANNEL.open);
  channels.set(CHANNEL.open, channelFrom(CHANNEL.open, { permission_overwrites: staffOnly }));
  try {
    const res = await get(anon(), url);
    assert.equal(res.status, 401, 'now private: sign-in');
    assert.ok(!(await text(res)).includes(ev.title));
    assert.equal((await get(who.plain, url)).status, 404);
    assert.equal((await get(who.staff, url)).status, 200);
  } finally {
    channels.set(CHANNEL.open, open);
  }
  assert.equal((await get(anon(), url)).status, 200);
});

test('an event posted on Discord is not opened by a Fluxer member', async () => {
  const ev = await make(CHANNEL.staff, { guildId: D_GUILD });
  const res = await get(who.staff, `/events/${ev.public_token}`);
  assert.equal(res.status, 404);
});
