// The Quote board end to end with fake platform objects: the "Save quote" message menu, /quote save
// (link, reply, duplicates, refusals), random / search / user / show, who may remove, numbers that
// are never reused, the settings that gate saving, and the menu command plumbing (loading,
// registration, the interaction listener).
import './helpers/tmpDb.js';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { REST } from 'discord.js';
import { runtime } from '../src/runtime.js';
import { setGuildModule } from '../src/db/modules.js';
import { getQuoteByNumber, insertQuote, quoteCount, quotesByAuthor, recentQuotes } from '../src/db/quotes.js';
import { execute as quote, contextMenus } from '../src/bot/commands/quote.js';
import { loadContextMenus } from '../src/bot/loadCommands.js';
import { registerCommands } from '../src/bot/registerCommands.js';
import { execute as onInteraction } from '../src/bot/events/interactionCreate.js';
import { LIMITS, saveQuote } from '../src/modules/quoteBoard.js';

let seq = 0;
const CH = {
  open: '100000000000000101',
  hidden: '100000000000000102',
  nsfw: '100000000000000103',
};
const ROLE = { saver: '100000000000000710', staff: '100000000000000711' };
const USER = {
  alice: '100000000000000201',
  bob: '100000000000000202',
  carol: '100000000000000203',
  mod: '100000000000000204',
  outsider: '100000000000000205',
};
let msgSeq = 0;

/** A guild with three channels (open, hidden from @everyone, age-restricted) and a message store. */
function world() {
  seq += 1;
  const rawId = String(900000000000000600n + BigInt(seq));
  const messages = new Map();
  const everyone = { id: rawId, name: '@everyone' };
  const mkChannel = (id, { everyoneSees, nsfw = false }) => {
    const channel = {
      id,
      nsfw,
      isTextBased: () => true,
      permissionsFor: (who) => ({
        has: (p) => {
          if (p !== 'ViewChannel') return false;
          if (who === everyone) return everyoneSees;
          return who?.canSeeChannels?.includes(id) ?? false;
        },
      }),
      messages: {
        fetch: async (mid) => {
          const m = messages.get(mid);
          if (!m || m.channelId !== id) throw new Error('Unknown Message');
          return m;
        },
      },
    };
    return channel;
  };
  const channels = new Map([
    [CH.open, mkChannel(CH.open, { everyoneSees: true })],
    [CH.hidden, mkChannel(CH.hidden, { everyoneSees: false })],
    [CH.nsfw, mkChannel(CH.nsfw, { everyoneSees: true, nsfw: true })],
  ]);
  const guild = {
    id: rawId,
    name: 'Test Guild',
    roles: { everyone },
    channels: { cache: channels, fetch: async (id) => channels.get(id) ?? null },
  };
  const client = { isReady: () => true, guilds: { cache: new Map([[rawId, guild]]) } };
  guild.client = client;
  runtime.clients.discord = client;
  runtime.clients.fluxer = null;

  /** Put a message into a channel of the guild. */
  const message = ({
    channelId = CH.open,
    authorId = USER.alice,
    name = 'Alice',
    content = 'Hello there',
    attachments = 0,
    at = Date.UTC(2030, 0, 2, 3, 4, 5),
  } = {}) => {
    msgSeq += 1;
    const m = {
      id: String(100000000000001000n + BigInt(msgSeq)),
      channelId,
      channel: channels.get(channelId),
      content,
      author: { id: authorId, username: name.toLowerCase() },
      member: { displayName: name },
      attachments: { size: attachments },
      createdTimestamp: at,
    };
    messages.set(m.id, m);
    return m;
  };
  return { rawId, guild, client, channels, message };
}

const memberOf = (id, { roles = [], perms = [], canSee = [CH.open, CH.nsfw] } = {}) => ({
  id,
  canSeeChannels: canSee,
  roles: { cache: new Map(roles.map((r) => [r, { id: r }])) },
  permissions: { has: (p) => perms.includes(p) },
});

/** A slash command or menu interaction that records its replies. */
function interact(w, { who = USER.alice, member, sub, options = {}, target, ref, channelId = CH.open } = {}) {
  const m = member ?? memberOf(who);
  const replies = [];
  const opt = (name) => options[name];
  const i = {
    guild: w.guild,
    guildId: w.rawId,
    channelId,
    user: { id: who },
    member: m,
    memberPermissions: m.permissions,
    targetMessage: target,
    message: ref ? { messageReference: ref } : undefined,
    replies,
    options: {
      getSubcommand: () => sub,
      getString: (name) => opt(name) ?? null,
      getInteger: (name) => opt(name) ?? null,
      getUser: (name) => (opt(name) ? { id: opt(name) } : null),
    },
    reply: async (payload) => {
      replies.push(payload);
      i.replied = true;
    },
  };
  return i;
}

const MOD_PERMS = ['ManageMessages'];
const flagsEphemeral = (r) => Boolean(r.flags);
const embedText = (r) => r.embeds?.[0]?.data?.description ?? '';
const footer = (r) => r.embeds?.[0]?.data?.footer?.text;

async function enable(w, config = {}) {
  await setGuildModule(w.rawId, 'quote-board', { enabled: true, config });
}
const run = async (w, args) => {
  const i = interact(w, args);
  await quote(i);
  return i.replies;
};
const menu = async (w, args) => {
  const i = interact(w, args);
  await contextMenus[0].execute(i);
  return i.replies;
};
const link = (w, m) => `https://discord.com/channels/${w.rawId}/${m.channelId}/${m.id}`;

test('the "Save quote" menu saves the message and answers in the channel with the quote', async () => {
  const w = world();
  await enable(w);
  const m = w.message({ content: 'I did not say that', name: 'Alice' });
  const [reply] = await menu(w, { who: USER.bob, target: m });
  assert.match(reply.content, /Saved as quote \*\*#1\*\*/);
  assert.equal(flagsEphemeral(reply), false, 'a new quote is announced to the channel');
  assert.equal(footer(reply), 'Quote #1');
  assert.match(embedText(reply), /> I did not say that/);
  assert.match(embedText(reply), /— \*\*Alice\*\*, <t:\d+:D>/);
  assert.match(
    embedText(reply),
    new RegExp(`\\(https://discord.com/channels/${w.rawId}/${CH.open}/${m.id}\\)`)
  );

  const row = await getQuoteByNumber(w.rawId, 1);
  assert.deepEqual(
    {
      channel: row.channel_id,
      message: row.message_id,
      author: row.author_id,
      name: row.author_name,
      body: row.body,
      attachments: row.attachments,
      at: row.message_at,
      savedBy: row.saved_by,
      public: row.public_source,
    },
    {
      channel: CH.open,
      message: m.id,
      author: USER.alice,
      name: 'Alice',
      body: 'I did not say that',
      attachments: 0,
      at: Date.UTC(2030, 0, 2, 3, 4, 5),
      savedBy: USER.bob,
      public: 1,
    }
  );
});

test('the menu command is a message command, in servers only', () => {
  const json = contextMenus[0].data.toJSON();
  assert.equal(json.name, 'Save quote');
  assert.equal(json.type, 3, 'ApplicationCommandType.Message');
  assert.deepEqual(json.contexts, [0], 'servers only');
});

test('saving the same message twice returns the quote it already has', async () => {
  const w = world();
  await enable(w);
  const m = w.message();
  await menu(w, { target: m });
  const [again] = await menu(w, { who: USER.bob, target: m });
  assert.match(again.content, /already quote \*\*#1\*\*/);
  assert.equal(flagsEphemeral(again), true, 'only the person who asked sees it');
  assert.equal(await quoteCount(w.rawId), 1);
  assert.equal((await getQuoteByNumber(w.rawId, 1)).saved_by, USER.alice, 'the first saver is kept');
});

test('two saves of the same message at once make one quote', async () => {
  const w = world();
  await enable(w);
  const m = w.message();
  await Promise.all([menu(w, { target: m }), menu(w, { who: USER.bob, target: m })]);
  assert.equal(await quoteCount(w.rawId), 1);
});

test('a message with no text and no attachments is skipped; attachments only are counted, not copied', async () => {
  const w = world();
  await enable(w);
  const [empty] = await menu(w, { target: w.message({ content: '   ' }) });
  assert.match(empty.content, /nothing to save/);
  assert.equal(flagsEphemeral(empty), true);
  assert.equal(await quoteCount(w.rawId), 0);

  const [files] = await menu(w, { target: w.message({ content: '', attachments: 2 }) });
  assert.match(embedText(files), /\*\(no text\)\*/);
  assert.match(embedText(files), /📎 2 attachments/);
  const one = await menu(w, { target: w.message({ content: 'with a file', attachments: 1 }) });
  assert.match(embedText(one[0]), /📎 1 attachment(?!s)/);
  assert.equal((await getQuoteByNumber(w.rawId, 1)).attachments, 2);
});

test('/quote save by link explains an empty message (no Message Content intent) and points to the menu', async () => {
  const w = world();
  await enable(w);
  const blank = w.message({ content: '' });
  const [r] = await run(w, { sub: 'save', options: { message: link(w, blank) } });
  assert.match(r.content, /Message Content intent/);
  assert.match(r.content, /Save quote/);
  assert.equal(flagsEphemeral(r), true);
  // a message with only files is still saved by link
  const files = w.message({ content: '', attachments: 1 });
  const [ok] = await run(w, { sub: 'save', options: { message: link(w, files) } });
  assert.match(ok.content, /Saved as quote/);
});

test('the text is cut to 2000 characters and the display name to 100', async () => {
  const w = world();
  await enable(w);
  await menu(w, { target: w.message({ content: `${'x'.repeat(2500)}`, name: 'N'.repeat(150) }) });
  const row = await getQuoteByNumber(w.rawId, 1);
  assert.equal(row.body.length, LIMITS.text.maxLength);
  assert.equal(row.author_name.length, 100);
});

test('only quotes from channels everyone can read (and not age-restricted) may go on the public page', async () => {
  const w = world();
  await enable(w);
  await menu(w, { target: w.message({ channelId: CH.hidden }), who: USER.alice });
  await menu(w, { target: w.message({ channelId: CH.nsfw }) });
  await menu(w, { target: w.message({ channelId: CH.open }) });
  assert.deepEqual(
    (await recentQuotes(w.rawId)).map((r) => [r.number, r.public_source]),
    [
      [3, 1],
      [2, 0],
      [1, 0],
    ]
  );
});

test('with the module off, every command says so and nothing is stored', async () => {
  const w = world();
  const m = w.message();
  for (const args of [
    { sub: 'save', options: { message: link(w, m) } },
    { sub: 'random' },
    { sub: 'search', options: { text: 'x' } },
    { sub: 'user', options: { member: USER.alice } },
    { sub: 'show', options: { number: 1 } },
    { sub: 'remove', options: { number: 1 } },
  ]) {
    const [r] = await run(w, args);
    assert.match(r.content, /not enabled/, args.sub);
  }
  const [menuReply] = await menu(w, { target: m });
  assert.match(menuReply.content, /not enabled/);
  assert.equal(await quoteCount(w.rawId), 0);
});

test('/quote save with a message link saves it; Fluxer-style replies work through the message reference', async () => {
  const w = world();
  await enable(w);
  const m = w.message({ content: 'link me' });
  const [r] = await run(w, { sub: 'save', who: USER.bob, options: { message: link(w, m) } });
  assert.match(r.content, /Saved as quote \*\*#1\*\*/);
  assert.equal((await getQuoteByNumber(w.rawId, 1)).saved_by, USER.bob);

  const replied = w.message({ content: 'reply to me' });
  const [r2] = await run(w, {
    sub: 'save',
    ref: { channelId: replied.channelId, messageId: replied.id },
  });
  assert.match(r2.content, /Saved as quote \*\*#2\*\*/);
  assert.equal((await getQuoteByNumber(w.rawId, 2)).body, 'reply to me');
});

test('/quote save refuses a bad link, another server, no target, an unreadable message and a hidden channel', async () => {
  const w = world();
  await enable(w);
  const m = w.message();
  const refused = async (args, pattern) => {
    const [r] = await run(w, { sub: 'save', ...args });
    assert.match(r.content, pattern);
    assert.equal(flagsEphemeral(r), true);
  };
  await refused({ options: { message: 'not a link' } }, /does not look like a message link/);
  await refused(
    { options: { message: `https://discord.com/channels/100000000000099999/${CH.open}/${m.id}` } },
    /another server/
  );
  await refused({}, /Give a message link, or reply/);
  await refused(
    { options: { message: `https://discord.com/channels/${w.rawId}/${CH.open}/100000000000009999` } },
    /could not read that message/
  );
  const secret = w.message({ channelId: CH.hidden, content: 'staff only' });
  await refused({ options: { message: link(w, secret) }, who: USER.outsider }, /cannot see that channel/);
  assert.equal(await quoteCount(w.rawId), 0);

  // the same link works for someone who can see the channel
  const [ok] = await run(w, {
    sub: 'save',
    who: USER.mod,
    member: memberOf(USER.mod, { canSee: [CH.hidden] }),
    options: { message: link(w, secret) },
  });
  assert.match(ok.content, /Saved as quote/);
});

test('saving can be limited to some roles; staff may always save', async () => {
  const w = world();
  await enable(w, { saveMode: 'roles', saveRoles: [ROLE.saver], staffRoles: [ROLE.staff] });
  const m1 = w.message({ content: 'one' });
  const [denied] = await menu(w, { target: m1, who: USER.outsider });
  assert.match(denied.content, /Only some roles/);
  assert.equal(await quoteCount(w.rawId), 0);

  await menu(w, { target: m1, member: memberOf(USER.bob, { roles: [ROLE.saver] }), who: USER.bob });
  await menu(w, {
    target: w.message({ content: 'two' }),
    member: memberOf(USER.mod, { roles: [ROLE.staff] }),
    who: USER.mod,
  });
  await menu(w, {
    target: w.message({ content: 'three' }),
    member: memberOf(USER.carol, { perms: MOD_PERMS }),
    who: USER.carol,
  });
  assert.equal(await quoteCount(w.rawId), 3);

  const [viaCommand] = await run(w, { sub: 'save', who: USER.outsider, options: { message: link(w, m1) } });
  assert.match(viaCommand.content, /Only some roles/);
});

test('/quote show prints one quote with its text, author, date, attachments and jump link', async () => {
  const w = world();
  await enable(w);
  const m = w.message({ content: 'line one\nline two', name: 'Dana', attachments: 3 });
  await menu(w, { target: m });
  const [r] = await run(w, { sub: 'show', options: { number: 1 } });
  assert.equal(flagsEphemeral(r), false);
  assert.equal(footer(r), 'Quote #1');
  const text = embedText(r);
  assert.match(text, /> line one\n> line two/);
  assert.match(text, /— \*\*Dana\*\*/);
  assert.match(text, /📎 3 attachments/);
  assert.match(text, /\[Jump to the message\]\(https:\/\/discord\.com\/channels\//);
  const [missing] = await run(w, { sub: 'show', options: { number: 99 } });
  assert.match(missing.content, /no quote with that number/);
});

test("/quote random picks among all quotes, or only the member's", async () => {
  const w = world();
  await enable(w);
  for (const [authorId, name, content] of [
    [USER.alice, 'Alice', 'a1'],
    [USER.alice, 'Alice', 'a2'],
    [USER.bob, 'Bob', 'b1'],
  ]) {
    await menu(w, { target: w.message({ authorId, name, content }) });
  }
  const pick = async (value, options) => {
    const random = mock.method(Math, 'random', () => value);
    try {
      return (await run(w, { sub: 'random', options }))[0];
    } finally {
      random.mock.restore();
    }
  };
  assert.equal(footer(await pick(0)), 'Quote #1');
  assert.equal(footer(await pick(0.99)), 'Quote #3');
  assert.equal(footer(await pick(0.5)), 'Quote #2');
  assert.equal(footer(await pick(0.99, { member: USER.alice })), 'Quote #2');
  assert.match(embedText(await pick(0, { member: USER.bob })), /b1/);
  const none = await pick(0, { member: USER.carol });
  assert.match(none.content, /no quotes from that member/);
});

test('/quote random with nothing saved says so', async () => {
  const w = world();
  await enable(w);
  const [r] = await run(w, { sub: 'random' });
  assert.match(r.content, /no quotes to show here yet/);
});

test('/quote search shows the top 5, newest first, matches text and author, and takes wildcards literally', async () => {
  const w = world();
  await enable(w);
  for (let i = 1; i <= 7; i += 1) {
    await menu(w, { target: w.message({ content: `pineapple number ${i}` }) });
  }
  await menu(w, { target: w.message({ content: 'sale: 100% off', name: 'Zed' }) });
  await menu(w, { target: w.message({ content: 'plain text', name: 'Pinecone' }) });

  const [r] = await run(w, { sub: 'search', options: { text: 'PINEAPPLE' } });
  const lines = r.embeds[0].data.description.split('\n');
  assert.equal(lines.length, 5, 'at most five');
  assert.match(lines[0], /^\*\*#7\*\* Alice: pineapple number 7/);
  assert.match(lines[4], /^\*\*#3\*\*/);

  const [byName] = await run(w, { sub: 'search', options: { text: 'pinecone' } });
  assert.match(byName.embeds[0].data.description, /\*\*#9\*\* Pinecone: plain text/);

  const [percent] = await run(w, { sub: 'search', options: { text: '100%' } });
  assert.match(percent.embeds[0].data.description, /#8/);
  const [wild] = await run(w, { sub: 'search', options: { text: '%' } });
  assert.equal(wild.embeds[0].data.description.split('\n').length, 1, '% matches only a real percent sign');
  const [underscore] = await run(w, { sub: 'search', options: { text: 'pineapple_number' } });
  assert.match(underscore.content, /No quote matches/, '_ is not a one-character wildcard');

  const [none] = await run(w, { sub: 'search', options: { text: 'zzz' } });
  assert.match(none.content, /No quote matches/);
  const [blank] = await run(w, { sub: 'search', options: { text: '   ' } });
  assert.match(blank.content, /Write what to look for/);
});

test('a search query is cut to 100 characters', async () => {
  const w = world();
  await enable(w);
  await menu(w, { target: w.message({ content: 'a'.repeat(100) }) });
  const [r] = await run(w, { sub: 'search', options: { text: 'a'.repeat(400) } });
  assert.match(r.embeds[0].data.title, /^Quotes matching "a{60}"$/);
  assert.match(r.embeds[0].data.description, /#1/);
});

test('/quote user lists the latest 10 of a member with the total', async () => {
  const w = world();
  await enable(w);
  for (let i = 1; i <= 12; i += 1) {
    await menu(w, { target: w.message({ authorId: USER.alice, name: 'Alice', content: `a${i}` }) });
  }
  await menu(w, { target: w.message({ authorId: USER.bob, name: 'Bob', content: 'b1' }) });
  const [r] = await run(w, { sub: 'user', options: { member: USER.alice } });
  const e = r.embeds[0].data;
  assert.equal(e.title, 'Quotes of Alice');
  assert.equal(e.description.split('\n').length, 10);
  assert.match(e.description.split('\n')[0], /\*\*#12\*\* Alice: a12/);
  assert.match(e.footer.text, /latest 10 of 12/);
  assert.doesNotMatch(e.description, /b1/);

  const [bob] = await run(w, { sub: 'user', options: { member: USER.bob } });
  assert.equal(bob.embeds[0].data.footer, undefined);
  const [nobody] = await run(w, { sub: 'user', options: { member: USER.carol } });
  assert.match(nobody.content, /no quotes from that member/);
});

test('who may remove: the author, whoever saved it, and staff; nobody else', async () => {
  const w = world();
  await enable(w, { staffRoles: [ROLE.staff] });
  const save = (authorId, savedBy, content) =>
    menu(w, { who: savedBy, target: w.message({ authorId, content }) });
  await save(USER.alice, USER.bob, 'q1'); // #1 by Alice, saved by Bob
  await save(USER.alice, USER.bob, 'q2');
  await save(USER.alice, USER.bob, 'q3');
  await save(USER.alice, USER.bob, 'q4');
  await save(USER.alice, USER.bob, 'q5');

  const remove = async (number, who, member) =>
    (await run(w, { sub: 'remove', who, member, options: { number } }))[0];

  const denied = await remove(1, USER.carol);
  assert.match(denied.content, /only remove quotes you wrote or saved/);
  assert.ok(await getQuoteByNumber(w.rawId, 1));

  assert.match((await remove(1, USER.alice)).content, /Removed quote \*\*#1\*\*/); // the author
  assert.match((await remove(2, USER.bob)).content, /Removed quote \*\*#2\*\*/); // the saver
  assert.match(
    (await remove(3, USER.mod, memberOf(USER.mod, { perms: ['ManageMessages'] }))).content,
    /Removed quote \*\*#3\*\*/
  );
  assert.match(
    (await remove(4, USER.mod, memberOf(USER.mod, { perms: ['ManageGuild'] }))).content,
    /Removed quote \*\*#4\*\*/
  );
  assert.match(
    (await remove(5, USER.mod, memberOf(USER.mod, { roles: [ROLE.staff] }))).content,
    /Removed quote \*\*#5\*\*/
  );
  assert.equal(await quoteCount(w.rawId), 0);

  // Manage Roles is not staff here, and a staff role of another kind does not count
  await save(USER.alice, USER.bob, 'q6');
  const no = await remove(
    6,
    USER.mod,
    memberOf(USER.mod, { perms: ['ManageRoles'], roles: ['1'.repeat(18)] })
  );
  assert.match(no.content, /only remove quotes you wrote or saved/);
  assert.match((await remove(99, USER.alice)).content, /no quote with that number/);
});

test("a removed quote's number is never handed out again", async () => {
  const w = world();
  await enable(w);
  const a = w.message({ content: 'first' });
  const b = w.message({ content: 'second' });
  await menu(w, { target: a });
  await menu(w, { target: b });
  await run(w, { sub: 'remove', options: { number: 2 } }); // the newest one
  await run(w, { sub: 'remove', options: { number: 1 } });
  const [r] = await menu(w, { target: w.message({ content: 'third' }) });
  assert.match(r.content, /Saved as quote \*\*#3\*\*/);
  assert.deepEqual(
    (await recentQuotes(w.rawId)).map((q) => q.number),
    [3]
  );
  // saving a removed message again makes a new quote with a new number
  const [again] = await menu(w, { target: a });
  assert.match(again.content, /Saved as quote \*\*#4\*\*/);
});

test('numbers are per server', async () => {
  const w1 = world();
  await enable(w1);
  await menu(w1, { target: w1.message() });
  const w2 = world();
  await enable(w2);
  const [r] = await menu(w2, { target: w2.message() });
  assert.match(r.content, /quote \*\*#1\*\*/);
});

test('the same message id can be quoted in two servers', async () => {
  const w = world();
  await enable(w);
  await insertQuote({
    guildId: '900000000000000999',
    channelId: CH.open,
    messageId: 'shared',
    authorId: USER.alice,
    messageAt: 1,
    body: 'other server',
  });
  const result = await saveQuote({
    guild: w.guild,
    message: { ...w.message(), id: 'shared' },
    savedBy: USER.bob,
  });
  assert.equal(result.ok, true);
  assert.equal(result.existing, false);
});

test('a quote of a member who left is still shown with the name saved with it', async () => {
  const w = world();
  await enable(w);
  await menu(w, { target: w.message({ authorId: '100000000000009998', name: 'Gone Girl' }) });
  const [r] = await run(w, { sub: 'show', options: { number: 1 } });
  assert.match(embedText(r), /Gone Girl/);
  assert.equal((await quotesByAuthor(w.rawId, '100000000000009998')).length, 1);
});

// --- the menu command plumbing -------------------------------------------------------------------------

test('loadContextMenus finds "Save quote" and keeps it out of the slash commands', async () => {
  const menus = await loadContextMenus();
  assert.deepEqual([...menus.keys()], ['Save quote']);
  assert.equal(typeof menus.get('Save quote').execute, 'function');
  const { loadCommands } = await import('../src/bot/loadCommands.js');
  assert.ok(!(await loadCommands()).has('Save quote'));
});

test('registerCommands sends the menu commands together with the slash commands', async () => {
  const sent = [];
  const put = mock.method(REST.prototype, 'put', async (route, options) => {
    sent.push(options.body);
    return [];
  });
  try {
    const { loadCommands } = await import('../src/bot/loadCommands.js');
    const commands = await loadCommands();
    const count = await registerCommands(commands, await loadContextMenus());
    assert.equal(count, commands.size + 1);
    const names = sent.at(-1).map((c) => c.name);
    assert.ok(names.includes('quote'));
    assert.ok(names.includes('Save quote'));
    // without menus nothing changes
    assert.equal(await registerCommands(commands), commands.size);
  } finally {
    put.mock.restore();
  }
});

test('the interaction listener runs a message menu command and answers an unknown one quietly', async () => {
  const w = world();
  await enable(w);
  const m = w.message({ content: 'via the listener' });
  const i = interact(w, { target: m });
  i.isMessageComponent = () => false;
  i.isMessageContextMenuCommand = () => true;
  i.isChatInputCommand = () => false;
  i.inGuild = () => true;
  i.commandName = 'Save quote';
  i.client = { contextMenus: await loadContextMenus() };
  await onInteraction(i);
  assert.match(i.replies[0].content, /Saved as quote/);

  const unknown = interact(w, { target: m });
  Object.assign(unknown, {
    isMessageComponent: () => false,
    isMessageContextMenuCommand: () => true,
    isChatInputCommand: () => false,
    inGuild: () => true,
    commandName: 'Nope',
    client: { contextMenus: new Map() },
  });
  await onInteraction(unknown);
  assert.deepEqual(unknown.replies, []);
});

test('a menu command that throws is answered with the generic error, not a crash', async () => {
  const w = world();
  const i = interact(w, { target: undefined });
  Object.assign(i, {
    isMessageComponent: () => false,
    isMessageContextMenuCommand: () => true,
    isChatInputCommand: () => false,
    inGuild: () => true,
    commandName: 'Save quote',
    client: { contextMenus: await loadContextMenus() },
  });
  await setGuildModule(w.rawId, 'quote-board', { enabled: true, config: {} });
  await onInteraction(i); // targetMessage is missing: the save throws
  assert.match(i.replies.at(-1).content, /Something went wrong/);
});

// --- quotes from private channels stay out of other channels ----------------------------------------------------------

const insider = (id) => memberOf(id, { canSee: [CH.open, CH.nsfw, CH.hidden] });

/** A server with one quote from the hidden channel (#1, by Dana) and one from the open channel (#2, by Dana). */
async function privateWorld() {
  const w = world();
  await enable(w);
  await menu(w, {
    channelId: CH.hidden,
    member: insider(USER.mod),
    who: USER.mod,
    target: w.message({
      channelId: CH.hidden,
      authorId: USER.carol,
      name: 'Dana',
      content: 'secret staff plan',
    }),
  });
  await menu(w, {
    target: w.message({ authorId: USER.carol, name: 'Dana', content: 'public joke' }),
  });
  assert.equal((await getQuoteByNumber(w.rawId, 1)).public_source, 0);
  assert.equal((await getQuoteByNumber(w.rawId, 2)).public_source, 1);
  return w;
}
const text = (replies) => JSON.stringify(replies);

test('a quote from a private channel never shows up in another channel through random, search or user', async () => {
  const w = await privateWorld();
  for (let i = 0; i < 20; i += 1) {
    const [r] = await run(w, { sub: 'random' });
    assert.doesNotMatch(text(r), /secret staff plan/);
    assert.equal(footer(r), 'Quote #2');
  }
  const [mine] = await run(w, { sub: 'random', options: { member: USER.carol } });
  assert.equal(footer(mine), 'Quote #2');

  const [found] = await run(w, { sub: 'search', options: { text: 'secret' } });
  assert.match(found.content, /No quote matches/);
  assert.doesNotMatch(text(found), /staff plan/);
  const [both] = await run(w, { sub: 'search', options: { text: 'Dana' } });
  assert.doesNotMatch(text(both), /staff plan/);
  assert.match(both.embeds[0].data.description, /#2/);

  const [list] = await run(w, { sub: 'user', options: { member: USER.carol } });
  assert.doesNotMatch(text(list), /staff plan/);
  assert.equal(list.embeds[0].data.description.split('\n').length, 1);
  assert.equal(list.embeds[0].data.footer, undefined, 'the total counts only what may be shown here');

  // a member with only private quotes looks like a member with none
  const only = world();
  await enable(only);
  await menu(only, {
    channelId: CH.hidden,
    member: insider(USER.mod),
    who: USER.mod,
    target: only.message({ channelId: CH.hidden, authorId: USER.bob, content: 'hidden only' }),
  });
  assert.match((await run(only, { sub: 'random' }))[0].content, /no quotes to show here yet/);
  assert.match(
    (await run(only, { sub: 'user', options: { member: USER.bob } }))[0].content,
    /no quotes from that member/
  );
  assert.match(
    (await run(only, { sub: 'random', options: { member: USER.bob } }))[0].content,
    /no quotes from that member/
  );
});

test('/quote show of a private quote elsewhere is private, and only for someone who can still see its channel', async () => {
  const w = await privateWorld();
  const [seen] = await run(w, {
    sub: 'show',
    who: USER.mod,
    member: insider(USER.mod),
    options: { number: 1 },
  });
  assert.equal(flagsEphemeral(seen), true, 'only the caller sees it');
  assert.match(seen.content, /private channel/);
  assert.match(embedText(seen), /secret staff plan/);

  const [denied] = await run(w, { sub: 'show', options: { number: 1 } });
  assert.equal(flagsEphemeral(denied), true);
  assert.match(denied.content, /not available here/);
  assert.equal(denied.embeds, undefined);
  assert.doesNotMatch(text(denied), /secret staff plan/);

  // someone who lost access since is treated like anyone else
  const [lost] = await run(w, {
    sub: 'show',
    who: USER.mod,
    member: memberOf(USER.mod),
    options: { number: 1 },
  });
  assert.match(lost.content, /not available here/);

  // a quote that does not exist and one that is private look different only by the wording, never by content
  const [none] = await run(w, { sub: 'show', options: { number: 77 } });
  assert.match(none.content, /no quote with that number/);

  // the public quote is shown to all, in public
  const [open] = await run(w, { sub: 'show', options: { number: 2 } });
  assert.equal(flagsEphemeral(open), false);
  assert.match(embedText(open), /public joke/);
});

test('a private quote shows normally, in public, in its own channel', async () => {
  const w = await privateWorld();
  const here = { channelId: CH.hidden, member: insider(USER.bob), who: USER.bob };
  const [shown] = await run(w, { sub: 'show', options: { number: 1 }, ...here });
  assert.equal(flagsEphemeral(shown), false);
  assert.match(embedText(shown), /secret staff plan/);

  const picks = new Set();
  for (let i = 0; i < 30; i += 1) picks.add(footer((await run(w, { sub: 'random', ...here }))[0]));
  assert.deepEqual([...picks].sort(), ['Quote #1', 'Quote #2']);

  const [found] = await run(w, { sub: 'search', options: { text: 'secret' }, ...here });
  assert.match(found.embeds[0].data.description, /#1\*\*/);
  const [list] = await run(w, { sub: 'user', options: { member: USER.carol }, ...here });
  assert.equal(list.embeds[0].data.description.split('\n').length, 2);
  const [byMember] = await run(w, { sub: 'random', options: { member: USER.carol }, ...here });
  assert.ok(footer(byMember));
});

test('another private channel does not see it either (only its own source and public ones)', async () => {
  const w = await privateWorld();
  const [r] = await run(w, { sub: 'search', options: { text: 'secret' }, channelId: CH.nsfw });
  assert.match(r.content, /No quote matches/);
});

test('saving a private message by link from another channel answers only the caller', async () => {
  const w = world();
  await enable(w);
  const secret = w.message({ channelId: CH.hidden, content: 'staff only joke' });
  const [r] = await run(w, {
    sub: 'save',
    who: USER.mod,
    member: insider(USER.mod),
    options: { message: link(w, secret) },
  });
  assert.equal(flagsEphemeral(r), true, 'not announced to the public channel');
  assert.match(r.content, /Saved as quote \*\*#1\*\*.*private channel/);
  // saving it again says the same, privately
  const [again] = await run(w, {
    sub: 'save',
    who: USER.mod,
    member: insider(USER.mod),
    options: { message: link(w, secret) },
  });
  assert.equal(flagsEphemeral(again), true);
  assert.match(again.content, /already quote \*\*#1\*\*/);
  // and in its own channel it is announced as usual
  const [home] = await run(w, {
    sub: 'save',
    channelId: CH.hidden,
    who: USER.mod,
    member: insider(USER.mod),
    options: { message: link(w, w.message({ channelId: CH.hidden, content: 'another one' })) },
  });
  assert.equal(flagsEphemeral(home), false);
});
