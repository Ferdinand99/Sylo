// The starboard compares audiences: every role that can read the board channel must be able to read the
// source channel. A server that gates every channel behind a role keeps working; a source hidden from some
// of the board's readers is not copied; on Fluxer the same rule runs on the compat permission layer.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/modules/dispatch.js';
import { rescanBoard, normaliseStarboard } from '../src/modules/starboard.js';
import { setGuildModule } from '../src/db/modules.js';
import { getStarboardEntry, setStarboardPost, upsertStarboardEntry } from '../src/db/starboard.js';
import { runtime } from '../src/runtime.js';

const G = '900000000000000041';
const BOARD = '100000000000001001';
const SRC = '100000000000001002';
const EVERYONE = { id: G, name: '@everyone', managed: false };
const VERIFIED = { id: '500000000000000001', name: 'Verified', managed: false };
const STAFF = { id: '500000000000000002', name: 'Staff', managed: false };
const BOT_ROLE = { id: '500000000000000003', name: 'SomeBot', managed: true, tags: { botId: '1' } };
// the Server Booster role is managed too, but people hold it
const BOOSTER = {
  id: '500000000000000004',
  name: 'Booster',
  managed: true,
  tags: { premiumSubscriberRole: true },
};

const channel = (id, view, extra = {}) => ({
  id,
  nsfw: false,
  nsfwOverride: null,
  isTextBased: () => true,
  isThread: () => false,
  permissionsFor: (who) => ({ has: () => (who?.id ? view.includes(who.id) : true) }),
  ...extra,
});

function world({ board, source, platform = 'discord', memberOverwrite = null }) {
  const sent = [];
  const deleted = [];
  const post = { id: 'oldpost', delete: async () => deleted.push('oldpost') };
  const dest = channel(BOARD, board, {
    ...(memberOverwrite && {
      permissionOverwrites: { cache: new Map([[memberOverwrite, { id: memberOverwrite, type: 1 }]]) },
    }),
    send: async (p) => {
      sent.push(p);
      return { id: `post${sent.length}`, react: async () => {} };
    },
    messages: { fetch: async () => post },
  });
  const src = channel(SRC, source);
  const roles = new Map([EVERYONE, VERIFIED, STAFF, BOT_ROLE, BOOSTER].map((r) => [r.id, r]));
  const guild = {
    id: G,
    nsfw: false,
    channels: { cache: new Map([dest, src].map((c) => [c.id, c])) },
    roles: { everyone: EVERYONE, cache: roles },
    members: { me: {}, cache: new Map([['m1', { id: 'm1' }]]), fetch: async () => null },
    emojis: { cache: new Map() },
  };
  const client = { guilds: { cache: new Map([[G, guild]]) } };
  guild.client = client;
  if (platform === 'fluxer') runtime.clients.fluxer = client;
  return { guild, src, dest, sent, deleted };
}

const users = new Map(['u1', 'u2', 'u3'].map((id) => [id, { id, bot: false }]));
function reaction(guild, src, id = '700000000000000001') {
  const m = {
    id,
    channelId: src.id,
    channel: src,
    guild,
    author: { id: 'author', bot: false, username: 'a', displayAvatarURL: () => 'https://x/a.png' },
    content: 'hello',
    createdTimestamp: Date.now() - 60_000,
    url: `https://x/${id}`,
    attachments: new Map(),
    embeds: [],
    reactions: { cache: new Map() },
  };
  const rx = {
    emoji: { id: null, name: '⭐' },
    message: m,
    partial: false,
    users: { fetch: async () => users, cache: users },
  };
  m.reactions.cache.set('⭐', rx);
  return { m, rx };
}

let boards = 0;
// A new board id each time: a board posts at most once a minute.
async function react(w, boardConfig = {}) {
  await setGuildModule(w.guild.id, 'starboard', {
    enabled: true,
    config: { boards: [{ id: `a${(boards += 1)}`, channelId: BOARD, threshold: 3, ...boardConfig }] },
  });
  const { rx } = reaction(w.guild, w.src);
  await dispatch('reactionAdd', w.guild.id, { reaction: rx, user: { id: 'u3', bot: false } });
}

test('a server that gates channels behind a role: a source all the board readers can see is copied', async () => {
  // @everyone sees nothing; Verified and Staff see the board and the source
  const w = world({ board: [VERIFIED.id, STAFF.id], source: [VERIFIED.id, STAFF.id] });
  await react(w);
  assert.equal(w.sent.length, 1);
});

test('a source hidden from some of the board readers is not copied', async () => {
  const w = world({ board: [VERIFIED.id, STAFF.id], source: [STAFF.id] });
  await react(w);
  assert.equal(w.sent.length, 0);
});

test('a staff-only source on a staff-only board is copied; on a board that @everyone reads it is not', async () => {
  const staffOnly = world({ board: [STAFF.id], source: [STAFF.id] });
  await react(staffOnly);
  assert.equal(staffOnly.sent.length, 1);
  const open = world({ board: [EVERYONE.id, VERIFIED.id, STAFF.id], source: [VERIFIED.id, STAFF.id] });
  await react(open);
  assert.equal(open.sent.length, 0);
});

test('a booster or integration role is held by people: it is an audience even though it is managed', async () => {
  // the board is in a supporters channel that Booster and Staff read; the source is staff-only
  const w = world({ board: [BOOSTER.id, STAFF.id], source: [STAFF.id] });
  await react(w);
  assert.equal(w.sent.length, 0);
});

test('a person the board names in an overwrite must be able to read the source too', async () => {
  const hidden = world({ board: ['m1'], source: [STAFF.id], memberOverwrite: 'm1' });
  await react(hidden);
  assert.equal(hidden.sent.length, 0);
  const shared = world({ board: ['m1'], source: ['m1'], memberOverwrite: 'm1' });
  await react(shared);
  assert.equal(shared.sent.length, 1);
});

test('a bot-managed role that reads the board is not an audience', async () => {
  const w = world({ board: [VERIFIED.id, BOT_ROLE.id], source: [VERIFIED.id] });
  await react(w);
  assert.equal(w.sent.length, 1);
});

test('an admin-picked hidden source is still copied ("only these channels")', async () => {
  const w = world({ board: [VERIFIED.id], source: [STAFF.id] });
  await react(w, { channelMode: 'deny', channelList: [SRC] });
  assert.equal(w.sent.length, 1);
});

test('the rescan uses the same rule', async () => {
  const ok = world({ board: [VERIFIED.id], source: [VERIFIED.id] });
  const hidden = world({ board: [VERIFIED.id], source: [STAFF.id] });
  for (const w of [ok, hidden]) {
    const { m } = reaction(w.guild, w.src);
    w.src.messages = { fetch: async () => new Map([[m.id, m]]) };
  }
  const board = normaliseStarboard({ boards: [{ id: 'rs', channelId: BOARD, threshold: 3 }] }).boards[0];
  assert.equal((await rescanBoard(ok.guild, board)).posted, 1);
  assert.equal((await rescanBoard(hidden.guild, board)).posted, 0);
});

test('a board post whose source no longer fits is deleted on the next reaction', async () => {
  const w = world({ board: [VERIFIED.id], source: [STAFF.id] });
  await setGuildModule(w.guild.id, 'starboard', {
    enabled: true,
    config: { boards: [{ id: 'old', channelId: BOARD, threshold: 3 }] },
  });
  const { rx, m } = reaction(w.guild, w.src, '700000000000000077');
  await upsertStarboardEntry({
    guildId: w.guild.id,
    boardId: 'old',
    sourceMsgId: m.id,
    sourceChanId: SRC,
    starCount: 3,
  });
  await setStarboardPost(w.guild.id, 'old', m.id, 'oldpost', Date.now());
  await dispatch('reactionAdd', w.guild.id, { reaction: rx, user: { id: 'u3', bot: false } });
  assert.deepEqual(w.deleted, ['oldpost']);
  assert.equal((await getStarboardEntry(w.guild.id, 'old', m.id)).post_msg_id, null);
  assert.equal(w.sent.length, 0);
});

test('Fluxer: the same audience rule, with the age restriction inherited from the category', async () => {
  try {
    const readable = world({ board: [VERIFIED.id], source: [VERIFIED.id], platform: 'fluxer' });
    await react(readable);
    assert.equal(readable.sent.length, 1, 'readable by the board readers');

    const hidden = world({ board: [VERIFIED.id], source: [STAFF.id], platform: 'fluxer' });
    await react(hidden);
    assert.equal(hidden.sent.length, 0, 'hidden from Verified');

    // a Fluxer channel inherits its category's age restriction
    const restricted = world({ board: [VERIFIED.id], source: [VERIFIED.id], platform: 'fluxer' });
    const category = { id: '100000000000001999', nsfwOverride: true };
    restricted.guild.channels.cache.set(category.id, category);
    restricted.src.parentId = category.id;
    await react(restricted);
    assert.equal(restricted.sent.length, 0, 'not onto a board that is not age-restricted');
  } finally {
    runtime.clients.fluxer = null;
  }
});
