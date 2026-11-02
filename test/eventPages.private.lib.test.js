// The rules behind the sign-in event pages (modules/lib/eventPage.js): who a channel's page is for
// (channelAudience), and whether one person may open it (viewerMaySee). Plain fakes; the real
// Express app is in eventPages.private.test.js and the Fluxer SDK classes in
// eventPages.private.fluxer.test.js.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import {
  MEMBER_LOOKUP_MS,
  VIEWER_CACHE_MS,
  _setLoginOffered,
  _setMembersIntent,
  _setViewerCache,
  channelAudience,
  eventAudience,
  platformOfKey,
  viewerMaySee,
} from '../src/modules/lib/eventPage.js';
import { isAgeRestricted } from '../src/modules/quoteBoard.js';
import { runtime } from '../src/runtime.js';

// No verdict is reused in these tests unless a test asks for it (the last tests do).
_setViewerCache({ ttlMs: 0 });

const view = { has: (p) => p === 'ViewChannel' };
const none = { has: () => false };
const everyone = {};
const USER = '900000000000000701';
const OTHER = '900000000000000702';

/** A channel everyone can see, unless told otherwise. `members` are the ids that can see it. */
const channel = (over = {}) => ({
  id: '1',
  nsfw: false,
  type: ChannelType.GuildText,
  permissionsFor: (target) => (target === everyone ? view : (target?.canView ?? false) ? view : none),
  ...over,
});
const privateChannel = (over = {}) => channel({ permissionsFor: (t) => (t?.canView ? view : none), ...over });
const member = (id = USER, canView = true) => ({ id, canView });
const guildWith = (channels, members = {}, extra = {}) => ({
  roles: { everyone },
  channels: { cache: new Map(Object.entries(channels)) },
  members: {
    cache: new Map(Object.entries(members)),
    fetch: async (arg) => {
      const id = typeof arg === 'string' ? arg : arg?.user;
      if (!members[id]) throw new Error('Unknown Member');
      return members[id];
    },
  },
  ...extra,
});

// --- channelAudience ---------------------------------------------------------------------------

test('channelAudience: public for a channel everyone sees, private for one only some see', () => {
  assert.equal(channelAudience(guildWith({ 1: channel() }), '1'), 'public');
  assert.equal(channelAudience(guildWith({ 1: privateChannel() }), '1'), 'private');
});

test('channelAudience: no page for an age-restricted channel, whoever could see it', () => {
  assert.equal(channelAudience(guildWith({ 1: channel({ nsfw: true }) }), '1'), 'none');
  assert.equal(channelAudience(guildWith({ 1: privateChannel({ nsfw: true }) }), '1'), 'none');
});

test('channelAudience: no page for a channel Sylo does not have, or when it cannot tell', () => {
  assert.equal(channelAudience(guildWith({}), '1'), 'none');
  assert.equal(channelAudience(guildWith({ 1: channel() }), ''), 'none');
  assert.equal(channelAudience(guildWith({ 1: channel() }), undefined), 'none');
  assert.equal(channelAudience(null, '1'), 'none');
  assert.equal(channelAudience({}, '1'), 'none');
  // the age rule cannot be read: the channel is treated as age-restricted
  const unreadable = privateChannel();
  Object.defineProperty(unreadable, 'nsfw', {
    get() {
      throw new Error('boom');
    },
  });
  assert.equal(channelAudience(guildWith({ 1: unreadable }), '1'), 'none');
});

test('channelAudience: permissions that cannot be read leave a page nobody can open', async () => {
  // the audience is "private": the page asks the visitor's own permissions, which fail too
  const broken = privateChannel({
    permissionsFor: () => {
      throw new Error('boom');
    },
  });
  const g = guildWith({ 1: broken }, { [USER]: member() });
  assert.equal(channelAudience(g, '1'), 'private');
  assert.equal(await viewerMaySee(g, '1', USER), false);
});

test('channelAudience: a public thread follows its parent, a private thread has no page, an orphan none', () => {
  const thread = (type, parent, over = {}) =>
    channel({
      type,
      parent,
      isThread: () => true,
      permissionsFor: (t) => parent?.permissionsFor?.(t),
      ...over,
    });
  const open = channel();
  const closed = privateChannel();
  const adult = privateChannel({ nsfw: true });
  assert.equal(channelAudience(guildWith({ t: thread(ChannelType.PublicThread, open) }), 't'), 'public');
  assert.equal(channelAudience(guildWith({ t: thread(ChannelType.PublicThread, closed) }), 't'), 'private');
  assert.equal(channelAudience(guildWith({ t: thread(ChannelType.PublicThread, adult) }), 't'), 'none');
  assert.equal(channelAudience(guildWith({ t: thread(ChannelType.PrivateThread, open) }), 't'), 'none');
  assert.equal(channelAudience(guildWith({ t: thread(ChannelType.PrivateThread, closed) }), 't'), 'none');
  assert.equal(channelAudience(guildWith({ t: thread(ChannelType.PublicThread, null) }), 't'), 'none');
});

test('isAgeRestricted: a thread follows its parent, and what cannot be read counts as restricted', () => {
  const thread = (parent) => channel({ type: ChannelType.PublicThread, parent, isThread: () => true });
  assert.equal(isAgeRestricted({}, channel()), false);
  assert.equal(isAgeRestricted({}, channel({ nsfw: true })), true);
  assert.equal(isAgeRestricted({}, thread(channel())), false);
  assert.equal(isAgeRestricted({}, thread(channel({ nsfw: true }))), true);
  assert.equal(isAgeRestricted({}, thread(undefined)), true);
  assert.equal(isAgeRestricted({}, undefined), true);
  assert.equal(isAgeRestricted({}, null), true);
  assert.equal(
    isAgeRestricted(
      {},
      {
        get nsfw() {
          throw new Error('boom');
        },
      }
    ),
    true
  );
});

test('platformOfKey: a bare id is Discord, a prefixed one Fluxer', () => {
  assert.equal(platformOfKey('900000000000000201'), 'discord');
  assert.equal(platformOfKey('fluxer:900000000000000202'), 'fluxer');
  assert.equal(platformOfKey('nonsense'), 'discord');
});

// --- viewerMaySee ------------------------------------------------------------------------------

test('viewerMaySee: a member who can see the channel may, one who cannot may not', async () => {
  const g = guildWith({ 1: privateChannel() }, { [USER]: member(USER, true), [OTHER]: member(OTHER, false) });
  assert.equal(await viewerMaySee(g, '1', USER), true);
  assert.equal(await viewerMaySee(g, '1', OTHER), false);
});

test('viewerMaySee: nobody who is not in the server', async () => {
  const g = guildWith({ 1: privateChannel() }, { [USER]: member() });
  assert.equal(await viewerMaySee(g, '1', '900000000000000799'), false);
});

test('viewerMaySee: no answer is remembered between calls', async () => {
  const people = { [USER]: member(USER, true) };
  const g = guildWith({ 1: privateChannel() }, people);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await viewerMaySee(g, '1', USER), true);
    people[USER].canView = false;
    assert.equal(await viewerMaySee(g, '1', USER), false, 'lost at the very next call');
    people[USER].canView = true;
  }
  delete people[USER];
  g.members.cache.delete(USER);
  assert.equal(await viewerMaySee(g, '1', USER), false, 'left the server');
});

test('viewerMaySee: an age-restricted channel is a no even for a member who could see it', async () => {
  const g = guildWith({ 1: privateChannel({ nsfw: true }) }, { [USER]: member() });
  assert.equal(await viewerMaySee(g, '1', USER), false);
});

test('viewerMaySee: a private thread is a no, a public thread follows its parent', async () => {
  const parent = privateChannel();
  const thread = (type) => ({
    id: 't',
    type,
    nsfw: false,
    parent,
    isThread: () => true,
    permissionsFor: (t) => parent.permissionsFor(t),
    members: { cache: new Map([[USER, {}]]), fetch: async () => ({}) },
  });
  const g = guildWith(
    { pub: thread(ChannelType.PublicThread), priv: thread(ChannelType.PrivateThread) },
    { [USER]: member(USER, true), [OTHER]: member(OTHER, false) }
  );
  assert.equal(await viewerMaySee(g, 'pub', USER), true);
  assert.equal(await viewerMaySee(g, 'pub', OTHER), false);
  assert.equal(await viewerMaySee(g, 'priv', USER), false, 'even a member of the thread');
});

test('viewerMaySee fails closed on everything that is not a clear yes', async () => {
  const ok = () => guildWith({ 1: privateChannel() }, { [USER]: member() });
  assert.equal(await viewerMaySee(ok(), '1', USER), true);
  for (const [why, args] of [
    ['no guild', [null, '1', USER]],
    ['no channel id', [ok(), '', USER]],
    ['no user id', [ok(), '1', '']],
    ['a user id that is not a string', [ok(), '1', 123]],
    ['no user id given', [ok(), '1', undefined]],
    ['a channel Sylo does not have', [ok(), '2', USER]],
  ]) {
    assert.equal(await viewerMaySee(...args), false, why);
  }

  const g = ok();
  g.channels.cache.get('1').permissionsFor = () => {
    throw new Error('boom');
  };
  assert.equal(await viewerMaySee(g, '1', USER), false, 'permissionsFor throws');
  g.channels.cache.get('1').permissionsFor = () => null;
  assert.equal(await viewerMaySee(g, '1', USER), false, 'no permissions known');

  const noMembers = ok();
  noMembers.members = undefined;
  assert.equal(await viewerMaySee(noMembers, '1', USER), false, 'no member manager');

  const failing = ok();
  failing.members.cache.clear();
  failing.members.fetch = async () => {
    throw new Error('Discord is down');
  };
  assert.equal(await viewerMaySee(failing, '1', USER), false, 'the lookup fails');

  const someoneElse = ok();
  someoneElse.members.cache.set(USER, member(OTHER, true));
  assert.equal(await viewerMaySee(someoneElse, '1', USER), false, 'a member object that is not that person');
  const noId = ok();
  noId.members.cache.set(USER, { canView: true });
  assert.equal(await viewerMaySee(noId, '1', USER), false, 'a member object with no id');

  const wrongFetch = ok();
  wrongFetch.members.cache.clear();
  wrongFetch.members.fetch = async () => member(OTHER, true);
  assert.equal(await viewerMaySee(wrongFetch, '1', USER), false, 'the platform answers for someone else');
});

test(
  'viewerMaySee: a lookup that never answers is a no once the limit is up',
  { timeout: 15_000 },
  async () => {
    const g = guildWith({ 1: privateChannel() }, {});
    g.members.fetch = () => new Promise(() => {});
    const started = Date.now();
    assert.equal(await viewerMaySee(g, '1', USER), false);
    assert.ok(Date.now() - started >= MEMBER_LOOKUP_MS - 100);
  }
);

test('viewerMaySee: the bot cache is used while the platform keeps it current, else the platform is asked', async () => {
  const asked = [];
  const people = { [USER]: member() };
  const g = guildWith({ 1: privateChannel() }, people);
  g.members.fetch = async (arg) => {
    asked.push(arg);
    return people[typeof arg === 'string' ? arg : arg.user];
  };

  // with the server-members intent: the cache is current; a member it holds costs no call
  assert.equal(await viewerMaySee(g, '1', USER), true);
  assert.deepEqual(asked, []);
  g.members.cache.clear();
  assert.equal(await viewerMaySee(g, '1', USER), true);
  assert.deepEqual(asked, [USER], 'a member it does not hold is fetched');

  // without it: never the cache, always a forced fetch
  _setMembersIntent(() => false);
  try {
    asked.length = 0;
    g.members.cache.set(USER, member(USER, true));
    people[USER] = member(USER, false); // the platform says no, the cache still says yes
    assert.equal(await viewerMaySee(g, '1', USER), false);
    assert.deepEqual(asked, [{ user: USER, force: true }]);
  } finally {
    _setMembersIntent(null);
  }
});

// --- Fluxer: the member is always fetched fresh ----------------------------------------------------

/** A guild that belongs to the Fluxer client, so Sylo reads it as a Fluxer server. */
function fluxerGuild(channels, members = {}, id = '900000000000000901') {
  const client = {};
  runtime.clients.fluxer = client;
  // the fields Fluxer's age rule reads: no override of its own, no category, a server that is not age-restricted
  for (const c of Object.values(channels)) Object.assign(c, { nsfwOverride: null, parentId: null });
  return guildWith(channels, members, { id, client, nsfw: false });
}

test('viewerMaySee on Fluxer: a stale cached member is never trusted, the platform is asked with force', async () => {
  const calls = [];
  try {
    const g = fluxerGuild({ 1: privateChannel() });
    g.members.cache.set(USER, member(USER, true)); // the bot's cache still says yes
    const fresh = member(USER, false); // the platform says no (the role was taken away while the bot was away)
    g.members.fetch = async (arg) => {
      calls.push(arg);
      return fresh;
    };
    assert.equal(await viewerMaySee(g, '1', USER), false);
    assert.deepEqual(calls, [{ user: USER, force: true }]);

    // the platform cannot be asked: no, though the cache holds a yes
    g.members.fetch = async () => {
      throw new Error('Fluxer is down');
    };
    assert.equal(await viewerMaySee(g, '1', USER), false);

    // a member the platform no longer knows (removed meanwhile) is a no, cached or not
    g.members.fetch = async () => {
      throw Object.assign(new Error('Unknown Member'), { statusCode: 404 });
    };
    assert.equal(await viewerMaySee(g, '1', USER), false);

    // a yes comes from the platform, not from the cache
    g.members.cache.clear();
    g.members.fetch = async (arg) => {
      calls.push(arg);
      return member(USER, true);
    };
    assert.equal(await viewerMaySee(g, '1', USER), true);
  } finally {
    runtime.clients.fluxer = null;
  }
});

// --- the short yes-or-no that spares the platform's API ---------------------------------------------

test('viewerMaySee: a yes or no that cost a call is reused for a few seconds, and no longer', async () => {
  let t = 1_000_000;
  _setViewerCache({ ttlMs: VIEWER_CACHE_MS, now: () => t });
  let fetches = 0;
  const people = { [USER]: member(USER, true), [OTHER]: member(OTHER, true) };
  try {
    const g = fluxerGuild({ 1: privateChannel(), 2: privateChannel({ id: '2' }) }, {}, '900000000000000902');
    g.members.fetch = async (arg) => {
      fetches += 1;
      return people[arg.user];
    };

    // one page view: three requests inside a second cost one call
    assert.equal(await viewerMaySee(g, '1', USER), true);
    t += 400;
    assert.equal(await viewerMaySee(g, '1', USER), true);
    t += 400;
    assert.equal(await viewerMaySee(g, '1', USER), true);
    assert.equal(fetches, 1);

    // access taken away: still the old answer until the time is up, never longer
    people[USER] = member(USER, false);
    t += VIEWER_CACHE_MS - 800 - 1;
    assert.equal(await viewerMaySee(g, '1', USER), true, 'inside the time');
    t += 2;
    assert.equal(await viewerMaySee(g, '1', USER), false, 'when the time is up');
    assert.equal(fetches, 2);

    // a no is reused too, and so is the way back
    people[USER] = member(USER, true);
    assert.equal(await viewerMaySee(g, '1', USER), false);
    assert.equal(fetches, 2);
    t += VIEWER_CACHE_MS;
    assert.equal(await viewerMaySee(g, '1', USER), true);
    assert.equal(fetches, 3);

    // another person, and another channel, are other questions
    await viewerMaySee(g, '1', OTHER);
    await viewerMaySee(g, '2', USER);
    assert.equal(fetches, 5);

    // the channel's own rules are read again at once: a channel that becomes age-restricted is a no
    // inside the time, though the verdict for the person is still stored
    g.channels.cache.get('1').nsfw = true;
    assert.equal(await viewerMaySee(g, '1', USER), false);
  } finally {
    runtime.clients.fluxer = null;
    _setViewerCache({ ttlMs: 0 });
  }
});

test('viewerMaySee: requests that arrive together share one call, and a failure is a short no too', async () => {
  let t = 5_000_000;
  _setViewerCache({ ttlMs: VIEWER_CACHE_MS, now: () => t });
  try {
    const g = fluxerGuild({ 1: privateChannel() }, {}, '900000000000000903');
    let fetches = 0;
    g.members.fetch = async () => {
      fetches += 1;
      await new Promise((r) => setTimeout(r, 20));
      return member(USER, true);
    };
    const answers = await Promise.all(Array.from({ length: 6 }, () => viewerMaySee(g, '1', USER)));
    assert.deepEqual(answers, Array(6).fill(true));
    assert.equal(fetches, 1);

    // a failing platform is asked once inside the time, not for every reload
    const bad = fluxerGuild({ 1: privateChannel() }, {}, '900000000000000904');
    let failures = 0;
    bad.members.fetch = async () => {
      failures += 1;
      throw new Error('429');
    };
    for (let i = 0; i < 5; i += 1) assert.equal(await viewerMaySee(bad, '1', USER), false);
    assert.equal(failures, 1);
    t += VIEWER_CACHE_MS;
    assert.equal(await viewerMaySee(bad, '1', USER), false);
    assert.equal(failures, 2);
  } finally {
    runtime.clients.fluxer = null;
    _setViewerCache({ ttlMs: 0 });
  }
});

test('viewerMaySee: a member the bot cache holds on Discord costs no call and is never reused', async () => {
  const t = 9_000_000;
  _setViewerCache({ ttlMs: VIEWER_CACHE_MS, now: () => t });
  try {
    const people = { [USER]: member(USER, true) };
    const g = guildWith({ 1: privateChannel() }, people, { id: '900000000000000905' });
    let fetches = 0;
    g.members.fetch = async () => {
      fetches += 1;
      return people[USER];
    };
    assert.equal(await viewerMaySee(g, '1', USER), true);
    people[USER].canView = false; // read at once: the cache is the gateway's and costs nothing
    assert.equal(await viewerMaySee(g, '1', USER), false);
    assert.equal(fetches, 0);
  } finally {
    _setViewerCache({ ttlMs: 0 });
  }
});

// --- a page is offered only where it can open ------------------------------------------------------

test('eventAudience: a page for a private channel counts only where a login is offered for its platform', () => {
  const g = guildWith({ 1: privateChannel(), 2: channel({ id: '2' }) });
  const ev = (channel_id, guild_id) => ({ channel_id, guild_id });
  const d = '900000000000000201';
  const f = 'fluxer:900000000000000202';
  try {
    _setLoginOffered(() => false);
    assert.equal(eventAudience(g, ev('1', d)), 'none', 'private, no login');
    assert.equal(eventAudience(g, ev('2', d)), 'public', 'public needs none');
    _setLoginOffered((platform) => platform === 'discord');
    assert.equal(eventAudience(g, ev('1', d)), 'private');
    assert.equal(eventAudience(g, ev('1', f)), 'none', 'no login for Fluxer');
    _setLoginOffered((platform) => platform === 'fluxer');
    assert.equal(eventAudience(g, ev('1', f)), 'private');
    assert.equal(eventAudience(g, ev('1', d)), 'none');
  } finally {
    _setLoginOffered(null);
  }
});
