// What Fluxer sees of the Quote board: the chat forms of /quote are understood by the prefix-command
// parser, saving works by link or by replying to the message (there is no message menu), the quote is
// keyed with the platform prefix and its jump link opens the Fluxer web app, and the dashboard tells
// Fluxer users about all of it.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { setGuildModule } from '../src/db/modules.js';
import { getQuoteByNumber, recentQuotes } from '../src/db/quotes.js';
import { data as quoteData } from '../src/bot/commands/quote.js';
import { loadCommands } from '../src/bot/loadCommands.js';
import { handleMessage } from '../src/bot/framework/router.js';
import { parseArgs, ParseError } from '../src/bot/framework/parser.js';
import { modulePlatformNote } from '../src/platform/modulePlatformNotes.js';

const schema = quoteData.toJSON();
const plain = (r) => Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, v.value]));

// each test gets its own server, so the quote numbers start again
let RAW = '900000000000000810';
let KEY = `fluxer:${RAW}`;
let seq = 0;
const CHANNEL = '200000000000000001';
const AUTHOR = '200000000000000011';
const ASKER = '200000000000000012';
const BOT_ID = '200000000000000099';

test('!quote save takes a message link, or nothing when replying', () => {
  const url = `https://web.fluxer.app/channels/${RAW}/${CHANNEL}/300000000000000001`;
  assert.deepEqual(plain(parseArgs(schema, `save ${url}`)), { message: url });
  assert.deepEqual(plain(parseArgs(schema, `save message:${url}`)), { message: url });
  const reply = parseArgs(schema, 'save');
  assert.equal(reply.subcommand, 'save');
  assert.deepEqual(plain(reply), {});
});

test('!quote random|search|user|show|remove', () => {
  assert.equal(parseArgs(schema, 'random').subcommand, 'random');
  assert.equal(plain(parseArgs(schema, 'random <@200000000000000011>')).member, '<@200000000000000011>');
  assert.deepEqual(plain(parseArgs(schema, 'search big red button')), { text: 'big red button' });
  assert.deepEqual(plain(parseArgs(schema, 'search text:"big red"')), { text: 'big red' });
  assert.equal(plain(parseArgs(schema, 'user <@200000000000000011>')).member, '<@200000000000000011>');
  assert.deepEqual(plain(parseArgs(schema, 'show 12')), { number: 12 });
  assert.deepEqual(plain(parseArgs(schema, 'remove number:3')), { number: 3 });
});

test('missing or oversized parts are parse errors', () => {
  assert.throws(() => parseArgs(schema, 'search'), /text/);
  assert.throws(() => parseArgs(schema, `search ${'a'.repeat(101)}`), ParseError);
  assert.throws(() => parseArgs(schema, 'show'), /number/);
  assert.throws(() => parseArgs(schema, 'show 0'), ParseError);
  assert.throws(() => parseArgs(schema, 'show abc'), ParseError);
  assert.throws(() => parseArgs(schema, 'user'), /member/);
  assert.throws(() => parseArgs(schema, 'wipe'), /Unknown subcommand/);
  assert.throws(() => parseArgs(schema, `save ${'a'.repeat(301)}`), ParseError);
});

// --- end to end through the prefix router ----------------------------------------------------------------

function fluxerWorld() {
  seq += 1;
  RAW = String(900000000000000810n + BigInt(seq));
  KEY = `fluxer:${RAW}`;
  const stored = new Map();
  const channel = {
    id: CHANNEL,
    isTextBased: () => true,
    permissionsFor: (who) => ({ has: () => who?.id === ASKER || who === everyone }),
    messages: { fetch: async (id) => stored.get(id) ?? Promise.reject(new Error('Unknown Message')) },
    send: async () => ({}),
    sendTyping: async () => {},
  };
  const everyone = { id: RAW };
  const guild = {
    id: RAW,
    name: 'Fluxer Guild',
    roles: { everyone },
    channels: { cache: new Map([[CHANNEL, channel]]), fetch: async () => channel },
    members: { cache: new Map(), fetch: async () => null },
  };
  const client = {
    users: { cache: new Map() },
    user: { id: BOT_ID },
    guilds: { cache: new Map([[RAW, guild]]) },
  };
  guild.client = client;
  runtime.clients.discord = null;
  runtime.clients.fluxer = client;

  const quoted = {
    id: '300000000000000001',
    channelId: CHANNEL,
    channel,
    content: 'said on Fluxer',
    author: { id: AUTHOR, username: 'fluxy', globalName: 'Fluxy' },
    attachments: { size: 0 },
    createdTimestamp: Date.UTC(2030, 5, 6),
  };
  stored.set(quoted.id, quoted);

  const replies = [];
  const command = (content, extra = {}) => ({
    content,
    createdTimestamp: 1,
    author: { id: ASKER, bot: false },
    member: { id: ASKER, permissions: { has: () => false }, roles: { cache: new Map() } },
    guild,
    channel,
    channelId: CHANNEL,
    client,
    reply: async (p) => {
      replies.push(p);
      return { delete: async () => {}, edit: async () => {} };
    },
    delete: async () => {},
    ...extra,
  });
  return { guild, quoted, replies, command };
}

const run = async (message) =>
  handleMessage(message, { commands: await loadCommands(), prefix: '!', botId: BOT_ID });
const said = (replies) =>
  replies.map((r) => `${r.content ?? ''} ${JSON.stringify(r.embeds ?? [])}`).join('\n');

test('!quote save <link> saves under the platform-prefixed server key and shows a Fluxer jump link', async () => {
  const w = fluxerWorld();
  await setGuildModule(KEY, 'quote-board', { enabled: true, config: {} });
  await run(w.command(`!quote save https://web.fluxer.app/channels/${RAW}/${CHANNEL}/${w.quoted.id}`));
  const row = await getQuoteByNumber(KEY, 1);
  assert.equal(row.body, 'said on Fluxer');
  assert.equal(row.author_name, 'Fluxy');
  assert.equal(row.saved_by, ASKER);
  assert.equal(row.public_source, 1);
  assert.equal(await getQuoteByNumber(RAW, 1), null, 'not under the raw id');
  assert.match(said(w.replies), /Saved as quote \*\*#1\*\*/);
  assert.ok(
    said(w.replies).includes(`https://web.fluxer.app/channels/${RAW}/${CHANNEL}/${w.quoted.id}`),
    'the jump link opens the Fluxer web app'
  );
});

test('!quote save as a reply saves the message that was replied to', async () => {
  const w = fluxerWorld();
  await setGuildModule(KEY, 'quote-board', { enabled: true, config: {} });
  await run(
    w.command('!quote save', {
      messageReference: { channelId: CHANNEL, messageId: w.quoted.id, guildId: RAW },
    })
  );
  assert.equal((await recentQuotes(KEY)).length, 1);
  assert.match(said(w.replies), /Saved as quote \*\*#1\*\*/);

  // saving it again through its link finds the same quote
  w.replies.length = 0;
  await run(w.command(`!quote save https://discord.com/channels/${RAW}/${CHANNEL}/${w.quoted.id}`));
  assert.match(said(w.replies), /already quote \*\*#1\*\*/);
  assert.equal((await recentQuotes(KEY)).length, 1);
});

test('!quote save without a link or a reply explains what to do; show, search and remove work in chat', async () => {
  const w = fluxerWorld();
  await setGuildModule(KEY, 'quote-board', { enabled: true, config: {} });
  await run(w.command('!quote save'));
  assert.match(said(w.replies), /Give a message link, or reply to the message/);

  await run(w.command(`!quote save ${`https://web.fluxer.app/channels/${RAW}/${CHANNEL}/${w.quoted.id}`}`));
  w.replies.length = 0;
  await run(w.command('!quote show 1'));
  assert.match(said(w.replies), /said on Fluxer/);
  w.replies.length = 0;
  await run(w.command('!quote search FLUXER'));
  assert.match(said(w.replies), /Fluxy: said on Fluxer/);
  w.replies.length = 0;
  await run(w.command('!quote remove 1', { author: { id: '200000000000000077', bot: false } }));
  assert.match(said(w.replies), /only remove quotes you wrote or saved/);
  w.replies.length = 0;
  await run(w.command('!quote remove 1')); // the person who saved it
  assert.match(said(w.replies), /Removed quote \*\*#1\*\*/);
  assert.deepEqual(await recentQuotes(KEY), []);
});

test('the dashboard tells Fluxer users there is no menu and what to type instead', () => {
  const note = modulePlatformNote('fluxer', 'quote-board');
  assert.match(note, /no message menu/);
  assert.match(note, /!quote save/);
  assert.match(note, /replying to the message/);
  assert.match(note, /public page work as on Discord/);
  assert.equal(modulePlatformNote('discord', 'quote-board'), null);
});
