// Suggestions end to end with fake platform objects: /suggest, the 👍 / 👎 buttons, staff decisions
// with DMs and the log-channel move, anonymous mode, plain messages in the channel, the cooldown and
// the ceilings, /forget, and Fluxer (no thread).
// mock.timers is experimental until Node 23.1 but works on the Node 22 this project requires.
/* eslint-disable n/no-unsupported-features/node-builtins */
import './helpers/tmpDb.js';
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { routeComponent } from '../src/bot/lib/components.js';
import { setGuildModule } from '../src/db/modules.js';
import { dispatch } from '../src/modules/dispatch.js';
import { startSchedules, stopSchedules } from '../src/modules/schedule.js';
import {
  createSuggestion as insertSuggestion,
  decideSuggestion,
  getSuggestion,
  getSuggestionByNumber,
  getSuggestionVote,
  listSuggestions,
  setSuggestionMessage,
  setSuggestionVote,
  suggestionCount,
} from '../src/db/suggestions.js';
import { forgetUser } from '../src/db/purge.js';
import { LIMITS as CEILINGS } from '../src/lib/limits.js';
import { execute as suggest } from '../src/bot/commands/suggest.js';
import { execute as suggestion } from '../src/bot/commands/suggestion.js';
import {
  createSuggestion,
  decide,
  parseSuggestionInput,
  refreshSuggestionMessage,
  removeSuggestion,
} from '../src/modules/suggestions.js';

let GID = '';
let seq = 0;
const CH = '100000000000000001';
const LOG = '100000000000000002';
const ROLE = '100000000000000700';
const STAFF = '100000000000000999';
const U = ['100000000000000011', '100000000000000012', '100000000000000013'];

const settle = async () => {
  for (let i = 0; i < 25; i += 1) await new Promise((r) => setImmediate(r));
};

// Nothing queued by a vote may run later against a different test's fake guild.
await stopSchedules();

function world({ dmClosed = [], platform = 'discord' } = {}) {
  seq += 1;
  const rawId = String(900000000000000200n + BigInt(seq));
  GID = platform === 'fluxer' ? `fluxer:${rawId}` : rawId;
  const out = { sent: [], edits: [], deletes: [], threads: [], dms: [], replies: [] };
  let msgSeq = 0;

  const makeChannel = (id) => {
    const store = new Map();
    const channel = {
      id,
      isTextBased: () => true,
      store,
      send: async (p) => {
        msgSeq += 1;
        const message = {
          id: `30000000000000${String(msgSeq).padStart(4, '0')}`,
          channelId: id,
          edit: async (payload) => {
            out.edits.push({ channel: id, id: message.id, payload });
            return message;
          },
          delete: async () => {
            store.delete(message.id);
            out.deletes.push({ channel: id, id: message.id });
          },
          startThread: async (opts) => {
            out.threads.push({ id: message.id, ...opts });
            return { id: `thread-${message.id}` };
          },
        };
        store.set(message.id, message);
        out.sent.push({ channel: id, id: message.id, payload: p });
        return message;
      },
      messages: { fetch: async (mid) => store.get(mid) ?? null },
    };
    return channel;
  };
  const channels = new Map([CH, LOG].map((id) => [id, makeChannel(id)]));

  const members = new Map();
  const member = (id) => {
    if (!members.has(id)) members.set(id, { id, roles: { cache: new Map() } });
    return members.get(id);
  };
  const guild = {
    id: platform === 'fluxer' ? rawId : GID,
    name: 'Test Guild',
    channels: { cache: channels, fetch: async (id) => channels.get(id) ?? null },
    members: { cache: members, fetch: async (id) => members.get(id) ?? null },
  };
  const client = {
    isReady: () => true,
    guilds: { cache: new Map([[guild.id, guild]]) },
    users: {
      fetch: async (id) => ({
        id,
        send: async (p) => {
          if (dmClosed.includes(id)) throw new Error('Cannot send messages to this user');
          out.dms.push({ id, p });
        },
      }),
    },
  };
  guild.client = client;
  runtime.clients.discord = platform === 'fluxer' ? null : client;
  runtime.clients.fluxer = platform === 'fluxer' ? client : null;
  return { ...out, out, guild, channels, member };
}

let w;
const fresh = (opts) => {
  w = world(opts);
  return w;
};

afterEach(async () => {
  mock.timers.reset();
  await stopSchedules();
  runtime.clients.discord = null;
  runtime.clients.fluxer = null;
});

const enable = (config = {}) =>
  setGuildModule(GID, 'suggestions', { enabled: true, config: { cooldownSeconds: 0, ...config } });

function slash(values = {}, { perms = [], as = U[0], sub = null, channelId = CH } = {}) {
  const replies = [];
  return {
    guildId: GID,
    guild: w.guild,
    channelId,
    user: { id: as },
    member: w.member(as),
    memberPermissions: { has: (p) => perms.includes(p) },
    options: {
      getSubcommand: () => sub,
      getString: (n, required) => {
        if (required && values[n] == null) throw new TypeError(n);
        return values[n] ?? null;
      },
      getInteger: (n, required) => {
        if (required && values[n] == null) throw new TypeError(n);
        return values[n] ?? null;
      },
    },
    reply: async (p) => {
      replies.push(p);
    },
    replies,
    text: () => replies.map((r) => r.content ?? '').join('\n'),
  };
}

async function say(text, as = U[0], extra = {}) {
  const i = slash({ text, ...extra }, { as });
  await suggest(i);
  return i;
}

async function decideAs(action, number, reason, { perms = ['ManageGuild'], as = STAFF } = {}) {
  const i = slash({ id: number, reason }, { perms, as, sub: action });
  await suggestion(i);
  return i;
}

function click(customId, userId) {
  const replies = [];
  return {
    customId,
    guildId: GID,
    guild: w.guild,
    user: { id: userId },
    member: w.member(userId),
    replied: false,
    deferred: false,
    isRepliable: () => true,
    reply: async (p) => {
      replies.push(p);
    },
    replies,
  };
}

async function press(dir, id, userId) {
  const i = click(`sug:${dir}:${id}`, userId);
  assert.equal(await routeComponent(i), true, 'the button is routed to the suggestions module');
  return i.replies.map((r) => r.content).join('\n');
}

/** A suggestion row straight in the database, with its post registered in the fake channel. */
async function seed(over = {}) {
  const { id, number } = await insertSuggestion({
    guildId: GID,
    channelId: CH,
    authorId: U[0],
    body: 'Seeded idea',
    ...over,
  });
  return { id, number };
}

const fieldsOf = (payload) =>
  Object.fromEntries(payload.embeds[0].toJSON().fields.map((f) => [f.name, f.value]));

// --- /suggest ---------------------------------------------------------------------------------

test('/suggest is refused while the module is off', async () => {
  fresh();
  await setGuildModule(GID, 'suggestions', { enabled: false });
  const i = await say('An idea');
  assert.match(i.text(), /not enabled/);
  assert.equal(w.sent.length, 0);
  assert.equal(await suggestionCount(GID), 0);
});

test('/suggest posts the embed with buttons and a thread, stores it and answers privately', async () => {
  fresh();
  await enable({ channel: LOG });
  const i = await say('Add a movie night on Fridays', U[0], { title: 'Movie night' });
  assert.match(i.text(), /suggestion \*\*#1\*\* is up in <#100000000000000002>/);
  assert.equal(i.replies[0].flags & 64, 64, 'the answer is ephemeral');

  assert.equal(w.sent.length, 1);
  const posted = w.sent[0];
  assert.equal(posted.channel, LOG, 'the configured channel, not the one the command ran in');
  const json = posted.payload.embeds[0].toJSON();
  assert.equal(json.title, '💡 Suggestion #1: Movie night');
  assert.equal(json.description, 'Add a movie night on Fridays');
  assert.equal(fieldsOf(posted.payload)['Suggested by'], `<@${U[0]}>`);

  const row = await getSuggestionByNumber(GID, 1);
  assert.deepEqual(
    posted.payload.components[0].toJSON().components.map((x) => x.custom_id),
    [`sug:up:${row.id}`, `sug:down:${row.id}`]
  );
  assert.equal(row.author_id, U[0]);
  assert.equal(row.title, 'Movie night');
  assert.equal(row.status, 'open');
  assert.equal(row.channel_id, LOG);
  assert.equal(row.message_id, posted.id);

  assert.equal(w.threads.length, 1, 'a discussion thread on Discord');
  assert.equal(w.threads[0].id, posted.id);
  assert.equal(w.threads[0].name, '#1 Movie night');
  assert.equal(w.threads[0].autoArchiveDuration, 1440);
});

test('/suggest posts in the current channel when none is set, numbers per server, names the thread from the text', async () => {
  fresh();
  await enable();
  await say('First idea');
  const second = await say('Second\nidea\n'.repeat(100));
  assert.match(second.text(), /#2/);
  assert.equal(w.sent[0].channel, CH);
  assert.equal((await getSuggestionByNumber(GID, 2)).title, '');
  assert.equal(w.threads[1].name.length <= 100, true);
  assert.doesNotMatch(w.threads[1].name, /\n/, 'a thread name is one line');
  assert.equal((await getSuggestionByNumber(GID, 2)).body.length, 1000, 'cut at the text limit');
});

test('a suggestion is still posted when the thread cannot be started', async () => {
  fresh();
  await enable();
  w.channels.get(CH).send = async (p) => {
    w.out.sent.push({ channel: CH, id: 'm1', payload: p });
    return {
      id: 'm1',
      startThread: async () => {
        throw new Error('Missing Access');
      },
    };
  };
  const i = await say('Idea');
  assert.match(i.text(), /is up in/);
  assert.equal((await getSuggestionByNumber(GID, 1)).message_id, 'm1');
});

test('/suggest explains when Sylo cannot post, and keeps nothing', async () => {
  fresh();
  await enable();
  w.channels.get(CH).send = async () => {
    throw new Error('Missing Permissions');
  };
  const i = await say('Idea');
  assert.match(i.text(), /could not post in that channel/);
  assert.equal(await suggestionCount(GID), 0);
});

test('/suggest with no text is refused', async () => {
  fresh();
  await enable();
  const i = await say('    ');
  assert.match(i.text(), /Write what you suggest/);
  assert.equal(w.sent.length, 0);
});

// --- anonymous mode ---------------------------------------------------------------------------

test('anonymous mode: the post names no one, the author is still stored, old posts keep their setting', async () => {
  fresh();
  await enable({ anonymous: true });
  await say('Secret idea');
  assert.equal(fieldsOf(w.sent[0].payload)['Suggested by'], undefined);
  const row = await getSuggestionByNumber(GID, 1);
  assert.equal(row.anonymous, true);
  assert.equal(row.author_id, U[0], 'staff can still see who wrote it');

  await enable({ anonymous: false });
  await say('Open idea', U[1]);
  assert.equal(fieldsOf(w.sent[1].payload)['Suggested by'], `<@${U[1]}>`);

  // the anonymous one stays anonymous when it is refreshed after the setting changed
  await refreshSuggestionMessage(row.id);
  assert.equal(w.edits.length, 1);
  assert.equal(fieldsOf(w.edits[0].payload)['Suggested by'], undefined);
});

test('anonymous suggestions still DM their author when staff decide', async () => {
  fresh();
  await enable({ anonymous: true });
  await say('Secret idea');
  await decideAs('approve', 1, 'Nice');
  assert.equal(w.dms.length, 1);
  assert.equal(w.dms[0].id, U[0]);
});

// --- voting -----------------------------------------------------------------------------------

test('voting: one vote per member, changeable, and the same button again takes it back', async () => {
  fresh();
  await enable();
  await say('Idea');
  const { id } = await getSuggestionByNumber(GID, 1);

  assert.match(await press('up', id, U[0]), /voted 👍 on #1/);
  assert.equal(await getSuggestionVote(id, U[0]), 1);
  assert.match(await press('up', id, U[1]), /voted 👍/);
  assert.match(await press('down', id, U[2]), /voted 👎/);
  assert.equal((await getSuggestion(id)).up, 2);
  assert.equal((await getSuggestion(id)).down, 1);

  assert.match(await press('down', id, U[0]), /Changed your vote on #1 to 👎/);
  assert.equal(await getSuggestionVote(id, U[0]), -1);
  assert.equal((await getSuggestion(id)).up, 1, 'a change moves the vote, it does not add one');
  assert.equal((await getSuggestion(id)).down, 2);

  assert.match(await press('down', id, U[0]), /👎 vote on #1 is taken back/);
  assert.equal(await getSuggestionVote(id, U[0]), 0);
  assert.equal((await getSuggestion(id)).down, 1);
  assert.match(await press('up', id, U[0]), /voted 👍/, 'and they can vote again');
});

test('a burst of votes produces one edit of the post, with the final counts on the buttons', async () => {
  fresh();
  await enable();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  startSchedules();
  await say('Idea');
  const { id } = await getSuggestionByNumber(GID, 1);
  await press('up', id, U[0]);
  await press('up', id, U[1]);
  await press('down', id, U[2]);
  await press('down', id, U[1]);
  assert.equal(w.edits.length, 0, 'nothing is edited per click');
  mock.timers.tick(3000);
  await settle();
  assert.equal(w.edits.length, 1);
  const buttons = w.edits[0].payload.components[0].toJSON().components;
  assert.deepEqual(
    buttons.map((b) => b.label),
    ['👍 1', '👎 2']
  );
  assert.equal(fieldsOf(w.edits[0].payload).Votes, '👍 1 · 👎 2');
});

test('a click on a decided, unknown, foreign or disabled suggestion is answered privately and stores nothing', async () => {
  fresh();
  await enable();
  await say('Idea');
  const { id } = await getSuggestionByNumber(GID, 1);
  await decideAs('approve', 1);
  assert.match(await press('up', id, U[1]), /Voting on this suggestion is closed/);
  assert.equal(await getSuggestionVote(id, U[1]), 0);
  assert.match(await press('up', 999999, U[1]), /no longer exists/);

  const other = await insertSuggestion({
    guildId: '900000000000009999',
    channelId: CH,
    authorId: 'x',
    body: 'y',
  });
  assert.match(await press('up', other.id, U[1]), /no longer exists/, 'a suggestion of another server');

  const live = await seed();
  await setGuildModule(GID, 'suggestions', { enabled: false });
  assert.match(await press('up', live.id, U[1]), /disabled/);
  assert.equal(await getSuggestionVote(live.id, U[1]), 0);
  await enable();
  assert.match(await press('up', live.id, U[1]), /voted/, 'considering still takes votes');
  await decideAs('consider', live.number);
  assert.match(await press('down', live.id, U[2]), /voted 👎/);
});

test('a malformed button id changes nothing and gets no reply', async () => {
  fresh();
  await enable();
  const { id } = await seed();
  for (const customId of ['sug:sideways:1', 'sug:up:abc', 'sug:up']) {
    const i = click(customId, U[1]);
    await routeComponent(i);
    assert.equal(i.replies.length, 0, customId);
  }
  assert.equal(await getSuggestionVote(id, U[1]), 0);
});

// --- staff decisions --------------------------------------------------------------------------

test('only staff decide; the module must be on; an unknown number is explained', async () => {
  fresh();
  await enable();
  await say('Idea');
  const nope = await decideAs('approve', 1, 'x', { perms: ['ManageEvents', 'ManageMessages'], as: U[1] });
  assert.match(nope.text(), /Only staff/);
  assert.equal((await getSuggestionByNumber(GID, 1)).status, 'open');
  assert.equal(w.dms.length, 0);

  const missing = await decideAs('deny', 99);
  assert.match(missing.text(), /no suggestion #99/);

  await setGuildModule(GID, 'suggestions', { enabled: false });
  assert.match((await decideAs('approve', 1)).text(), /not enabled/);
});

test('staff roles from the settings may decide without Manage Server', async () => {
  fresh();
  await enable({ staffRoles: [ROLE] });
  await say('Idea');
  const i = slash({ id: 1 }, { sub: 'approve', as: U[1] });
  i.member.roles.cache.set(ROLE, {});
  await suggestion(i);
  assert.match(i.text(), /is now approved/);
});

test('approve, deny, implement and consider each set the status, reason and colour, and edit the post', async () => {
  fresh();
  await enable();
  const colours = new Set();
  for (const [action, status] of [
    ['approve', 'approved'],
    ['deny', 'denied'],
    ['implement', 'implemented'],
    ['consider', 'considering'],
  ]) {
    await say(`Idea for ${action}`);
    const row = await getSuggestionByNumber(GID, await suggestionCount(GID));
    const before = w.edits.length;
    const i = await decideAs(action, row.number, `Because ${action}`);
    assert.match(i.text(), new RegExp(`#${row.number}\\*\\* is now ${status}`));
    const stored = await getSuggestion(row.id);
    assert.equal(stored.status, status);
    assert.equal(stored.reason, `Because ${action}`);
    assert.equal(stored.decided_by, STAFF);
    assert.ok(stored.decided_at > 0);

    assert.equal(w.edits.length, before + 1, 'the post is edited');
    const payload = w.edits.at(-1).payload;
    const f = fieldsOf(payload);
    assert.match(f.Status, new RegExp(`by <@${STAFF}>`));
    assert.equal(f['Reason from staff'], `Because ${action}`);
    colours.add(payload.embeds[0].toJSON().color);
    assert.equal(
      payload.components.length > 0,
      status === 'considering',
      'only an undecided one keeps its buttons'
    );
  }
  assert.equal(colours.size, 4);
});

test('a reason is optional and cut at 500 characters', async () => {
  fresh();
  await enable();
  await say('One');
  await say('Two');
  await decideAs('approve', 1);
  assert.equal((await getSuggestionByNumber(GID, 1)).reason, '');
  await decideAs('deny', 2, 'r'.repeat(600));
  assert.equal((await getSuggestionByNumber(GID, 2)).reason.length, 500);
});

test('a decision can be changed later, and the latest reason wins', async () => {
  fresh();
  await enable();
  await say('Idea');
  await decideAs('approve', 1, 'Planned');
  await decideAs('implement', 1);
  const row = await getSuggestionByNumber(GID, 1);
  assert.equal(row.status, 'implemented');
  assert.equal(row.reason, '');
  assert.equal(fieldsOf(w.edits.at(-1).payload)['Reason from staff'], undefined);
});

test('the author gets a DM with the status and the reason; DM off, closed DMs and erased authors are quiet', async () => {
  fresh({ dmClosed: [U[1]] });
  await enable();
  await say('Idea', U[0], { title: 'Movies' });
  const ok = await decideAs('approve', 1, 'Starting next week');
  assert.match(ok.text(), /author notified/);
  assert.equal(w.dms.length, 1);
  assert.equal(w.dms[0].id, U[0]);
  const dm = w.dms[0].p.content;
  assert.match(dm, /suggestion \*\*#1\*\* in \*\*Test Guild\*\*/);
  assert.match(dm, /approved/);
  assert.match(dm, /> Idea/);
  assert.match(dm, /Starting next week/);

  // closed DMs: the decision still counts and nothing is reported
  await say('Another', U[1]);
  const closed = await decideAs('deny', 2, 'No');
  assert.match(closed.text(), /is now denied\.$/);
  assert.equal((await getSuggestionByNumber(GID, 2)).status, 'denied');
  assert.equal(w.dms.length, 1);

  // the setting off
  await enable({ dmAuthor: false });
  await say('Third', U[0]);
  await decideAs('approve', 3);
  assert.equal(w.dms.length, 1, 'no DM when the server turned it off');

  // an erased author has nobody to tell
  await enable();
  await say('Fourth', U[0]);
  await forgetUser(GID, U[0]);
  await decideAs('approve', 4);
  assert.equal(w.dms.length, 1);
});

test('with a log channel a decided suggestion moves there and the original is deleted', async () => {
  fresh();
  await enable({ logChannel: LOG });
  await say('Idea');
  const original = w.sent[0];
  assert.equal(original.channel, CH);

  const i = await decideAs('approve', 1, 'Yes');
  assert.match(i.text(), /moved to the log channel/);
  const moved = w.sent[1];
  assert.equal(moved.channel, LOG);
  const f = fieldsOf(moved.payload);
  assert.equal(f.Status, `✅ Approved by <@${STAFF}>`);
  assert.equal(f['Reason from staff'], 'Yes');
  assert.equal(moved.payload.components.length, 0);
  assert.deepEqual(w.deletes, [{ channel: CH, id: original.id }], 'the original is gone');
  assert.equal(w.edits.length, 0, 'the original was not edited first');

  const row = await getSuggestionByNumber(GID, 1);
  assert.equal(row.channel_id, LOG);
  assert.equal(row.message_id, moved.id);

  // a later decision edits the post where it now lives, without moving it again
  await decideAs('implement', 1);
  assert.equal(w.sent.length, 2);
  assert.equal(w.edits.at(-1).channel, LOG);
  assert.equal(w.edits.at(-1).id, moved.id);
  assert.equal(fieldsOf(w.edits.at(-1).payload).Status, `🚀 Implemented by <@${STAFF}>`);
});

test('"considering" stays where it is, and a log channel that cannot be posted in leaves the suggestion in place', async () => {
  fresh();
  await enable({ logChannel: LOG });
  await say('One');
  await say('Two');
  await decideAs('consider', 1);
  assert.equal(w.sent.length, 2, 'considering is not a final decision: nothing moved');
  assert.equal(w.deletes.length, 0);

  w.channels.get(LOG).send = async () => {
    throw new Error('Missing Access');
  };
  const i = await decideAs('deny', 2, 'No');
  assert.match(i.text(), /is now denied/);
  assert.doesNotMatch(i.text(), /moved/);
  assert.equal((await getSuggestionByNumber(GID, 2)).status, 'denied', 'the decision still counts');
  assert.equal((await getSuggestionByNumber(GID, 2)).channel_id, CH);
  assert.equal(w.deletes.length, 0, 'the original stays');
  assert.equal(w.edits.at(-1).id, w.sent[1].id, 'and is edited instead');
});

test('a post that is already in the log channel is not moved again', async () => {
  fresh();
  await enable({ logChannel: CH });
  await say('Idea');
  await decideAs('approve', 1);
  assert.equal(w.sent.length, 1);
  assert.equal(w.deletes.length, 0);
  assert.equal(w.edits.length, 1);
});

test('decide() on a suggestion whose post was deleted still records the decision', async () => {
  fresh();
  await enable();
  const { id, number } = await seed();
  await setSuggestionMessage(id, CH, 'gone');
  const row = await getSuggestion(id);
  const r = await decide(row, 'deny', { reason: 'no', by: STAFF });
  assert.equal(r.ok, true);
  assert.equal((await getSuggestionByNumber(GID, number)).status, 'denied');
  assert.equal((await decide(row, 'explode', { by: STAFF })).ok, false);
});

test('removeSuggestion deletes the row, the votes and the post', async () => {
  fresh();
  await enable();
  await say('Idea');
  const row = await getSuggestionByNumber(GID, 1);
  await setSuggestionVote(row.id, U[1], 1);
  await removeSuggestion(row);
  assert.equal(await getSuggestion(row.id), null);
  assert.equal(await getSuggestionVote(row.id, U[1]), 0);
  assert.deepEqual(w.deletes, [{ channel: CH, id: row.message_id }]);
});

// --- cooldown and ceilings --------------------------------------------------------------------

test('the cooldown holds a member back, per member, and 0 turns it off', async () => {
  fresh();
  await enable({ cooldownSeconds: 60 });
  assert.match((await say('First')).text(), /is up in/);
  const again = await say('Second');
  assert.match(again.text(), /Wait \d+ s before your next suggestion/);
  assert.equal(await suggestionCount(GID), 1);
  assert.match((await say('Someone else', U[1])).text(), /is up in/, 'another member is not held back');

  // 61 s later (the earlier one is made to look old) the member may suggest again
  const { getSuggestion: g1 } = await import('../src/db/suggestions.js');
  const old = await seed({ authorId: U[2], createdAt: Date.now() - 61_000 });
  assert.ok(await g1(old.id));
  assert.match((await say('Third', U[2])).text(), /is up in/);
  const recent = await seed({ authorId: '100000000000000020', createdAt: Date.now() - 20_000 });
  assert.ok(recent.id);
  const wait = await say('Too soon', '100000000000000020');
  assert.match(wait.text(), /Wait (3\d|40) s/);

  await enable({ cooldownSeconds: 0 });
  assert.match((await say('Fourth')).text(), /is up in/);
  assert.match((await say('Fifth')).text(), /is up in/);
});

test('a member may have 10 open suggestions; a decision makes room', async () => {
  fresh();
  await enable();
  for (let n = 0; n < CEILINGS.openSuggestionsPerMember; n += 1) await seed({ body: `idea ${n}` });
  const blocked = await say('One too many');
  assert.match(blocked.text(), /already have 10 open suggestions/);
  assert.equal(await suggestionCount(GID), 10);
  assert.match((await say('Someone else is fine', U[1])).text(), /is up in/);

  const first = await getSuggestionByNumber(GID, 1);
  await decideSuggestion(first.id, { status: 'denied' });
  assert.match((await say('Now it fits')).text(), /is up in/);

  // "considering" still counts as open
  const second = await getSuggestionByNumber(GID, 2);
  await decideSuggestion(second.id, { status: 'considering' });
  assert.match((await say('Full again')).text(), /already have 10/);
});

test('a server stores at most 5000 suggestions; deleting one makes room', async () => {
  fresh();
  await enable();
  for (let n = 0; n < CEILINGS.suggestions; n += 1) {
    await insertSuggestion({ guildId: GID, channelId: CH, authorId: `author-${n}`, body: 'x' });
  }
  const blocked = await say('Over the ceiling');
  assert.match(blocked.text(), /maximum of 5000 stored suggestions/);
  assert.match(blocked.text(), /delete old ones on the dashboard/);
  assert.equal(await suggestionCount(GID), CEILINGS.suggestions);
  assert.equal(w.sent.length, 0);

  const [one] = await listSuggestions(GID, { limit: 1 });
  await removeSuggestion(one);
  assert.match((await say('Room again')).text(), /is up in/);
});

// --- plain messages in the channel ------------------------------------------------------------

function chat(content, { as = U[0], channelId = CH, bot = false, attachments = 0 } = {}) {
  const out = { deleted: false, replies: [] };
  const message = {
    channelId,
    content,
    author: { id: as, bot },
    guild: w.guild,
    attachments: { size: attachments },
    delete: async () => {
      out.deleted = true;
    },
    reply: async (p) => {
      out.replies.push(p);
      return { delete: async () => {} };
    },
  };
  return { message, out };
}

test('with the option on, a message in the channel becomes a suggestion and the original is deleted', async () => {
  fresh();
  await enable({ channel: CH, messagesToSuggestions: true });
  const { message, out } = chat('Please add dark mode');
  await dispatch('messageCreate', GID, message);
  assert.equal(out.deleted, true);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].payload.embeds[0].toJSON().description, 'Please add dark mode');
  const row = await getSuggestionByNumber(GID, 1);
  assert.equal(row.author_id, U[0]);
  assert.equal(w.threads.length, 1);
});

test('the message option is off by default and ignores other channels, bots, empty messages and attachments', async () => {
  fresh();
  await enable({ channel: CH });
  const off = chat('An idea');
  await dispatch('messageCreate', GID, off.message);
  assert.equal(off.out.deleted, false, 'off by default');

  await enable({ channel: CH, messagesToSuggestions: true });
  const cases = [
    chat('elsewhere', { channelId: LOG }),
    chat('from a bot', { bot: true }),
    chat('   '),
    chat('with a picture', { attachments: 1 }),
  ];
  for (const c of cases) {
    await dispatch('messageCreate', GID, c.message);
    assert.equal(c.out.deleted, false);
  }
  await enable({ messagesToSuggestions: true }); // no channel set: nothing to watch
  const none = chat('An idea');
  await dispatch('messageCreate', GID, none.message);
  assert.equal(none.out.deleted, false);
  assert.equal(await suggestionCount(GID), 0);
});

test('a too-long message, a cooldown and a ceiling get a short note and the message stays', async () => {
  fresh();
  await enable({ channel: CH, messagesToSuggestions: true, cooldownSeconds: 60 });
  const long = chat('x'.repeat(1001));
  await dispatch('messageCreate', GID, long.message);
  assert.equal(long.out.deleted, false);
  assert.match(long.out.replies[0].content, /at most 1000 characters/);
  assert.equal(await suggestionCount(GID), 0);

  const first = chat('First');
  await dispatch('messageCreate', GID, first.message);
  assert.equal(first.out.deleted, true);
  const second = chat('Second right away');
  await dispatch('messageCreate', GID, second.message);
  assert.equal(second.out.deleted, false);
  assert.match(second.out.replies[0].content, /Wait \d+ s/);
  assert.equal(await suggestionCount(GID), 1);
});

test('a suggestion made from a message while the module is off is not touched', async () => {
  fresh();
  await setGuildModule(GID, 'suggestions', {
    enabled: false,
    config: { channel: CH, messagesToSuggestions: true },
  });
  const { message, out } = chat('An idea');
  await dispatch('messageCreate', GID, message);
  assert.equal(out.deleted, false);
});

// --- /forget ----------------------------------------------------------------------------------

test('after /forget the suggestion keeps its text and number but the next refresh shows no author', async () => {
  fresh();
  await enable();
  await say('Keep this board', U[0]);
  const { id } = await getSuggestionByNumber(GID, 1);
  await setSuggestionVote(id, U[0], 1);
  await setSuggestionVote(id, U[1], 1);

  const r = await forgetUser(GID, U[0]);
  assert.equal(r.suggestionVotes, 1);
  assert.equal(r.suggestions, 1);
  const row = await getSuggestion(id);
  assert.equal(row.body, 'Keep this board');
  assert.equal(row.number, 1);
  assert.equal(row.author_id, null);
  assert.equal(row.up, 1, 'the other member vote stays');

  await refreshSuggestionMessage(id);
  assert.equal(fieldsOf(w.edits.at(-1).payload)['Suggested by'], undefined);
  assert.equal(w.edits.at(-1).payload.embeds[0].toJSON().description, 'Keep this board');
});

// --- Fluxer -----------------------------------------------------------------------------------

test('on Fluxer a suggestion is posted without a thread, with the same embed and buttons', async () => {
  fresh({ platform: 'fluxer' });
  const result = await createSuggestion({
    guild: w.guild,
    channelId: CH,
    authorId: '100000000000000011',
    input: parseSuggestionInput({ text: 'Fluxer idea' }).value,
    cfg: { cooldownSeconds: 0, anonymous: false },
  });
  assert.equal(result.ok, true);
  assert.equal(w.sent.length, 1);
  assert.equal(w.threads.length, 0, 'Fluxer has no threads yet');
  const row = await getSuggestion(result.id);
  assert.match(row.guild_id, /^fluxer:/);
  assert.equal(row.message_id, w.sent[0].id);
  assert.equal(w.sent[0].payload.components[0].toJSON().components.length, 2);
});
