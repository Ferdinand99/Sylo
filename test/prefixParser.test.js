import test from 'node:test';
import assert from 'node:assert/strict';
import { SlashCommandBuilder } from 'discord.js';
import { parseArgs, ParseError } from '../src/bot/framework/parser.js';

const USER = '<@123456789012345678>';

const ban = new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Ban')
  .addUserOption((o) => o.setName('user').setDescription('who').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('why').setMaxLength(20))
  .addIntegerOption((o) =>
    o
      .setName('delete_messages')
      .setDescription('history')
      .addChoices({ name: 'Previous hour', value: 3600 }, { name: 'Previous 24 hours', value: 86_400 })
  )
  .toJSON();

const say = new SlashCommandBuilder()
  .setName('say')
  .setDescription('Say')
  .addIntegerOption((o) =>
    o.setName('count').setDescription('n').setMinValue(1).setMaxValue(5).setRequired(true)
  )
  .addBooleanOption((o) => o.setName('loud').setDescription('l'))
  .addStringOption((o) => o.setName('text').setDescription('t').setRequired(true))
  .toJSON();

const warn = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Warn')
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('add')
      .addUserOption((o) => o.setName('user').setDescription('u').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('r').setRequired(true))
  )
  .addSubcommand((s) => s.setName('list').setDescription('list'))
  .toJSON();

const ping = new SlashCommandBuilder().setName('ping').setDescription('Ping').toJSON();

const err = (fn, re) => assert.throws(fn, (e) => e instanceof ParseError && re.test(e.message));

test('a command with no options takes no arguments', () => {
  assert.deepEqual(parseArgs(ping, ''), { subcommand: null, values: {} });
  err(() => parseArgs(ping, 'extra'), /too many/i);
});

test('positional options fill in order and the last string option takes the rest of the line', () => {
  const r = parseArgs(ban, `${USER} being rude`);
  assert.equal(r.subcommand, null);
  assert.deepEqual(r.values.user, { type: 6, value: USER });
  assert.deepEqual(r.values.reason, { type: 3, value: 'being rude' });
});

test('a missing required option is reported by name', () => {
  err(() => parseArgs(ban, ''), /user/);
});

test('name:value pairs work in any order and let you skip an optional option', () => {
  const r = parseArgs(ban, `reason:spam user:${USER}`);
  assert.equal(r.values.user.value, USER);
  assert.equal(r.values.reason.value, 'spam');
  const skip = parseArgs(ban, `${USER} delete_messages:3600`);
  assert.equal(skip.values.reason, undefined);
  assert.equal(skip.values.delete_messages.value, 3600);
});

test('a quoted value keeps its spaces', () => {
  const r = parseArgs(ban, `user:${USER} reason:"two words"`);
  assert.equal(r.values.reason.value, 'two words');
});

test('a quoted rest-of-line is unquoted, and unquoted rest keeps original spacing', () => {
  assert.equal(parseArgs(ban, `${USER} "just this"`).values.reason.value, 'just this');
  assert.equal(parseArgs(ban, `${USER} a   b`).values.reason.value, 'a   b');
});

test('integers, numeric bounds and booleans are coerced and checked', () => {
  const ok = parseArgs(say, '3 yes hello there');
  assert.equal(ok.values.count.value, 3);
  assert.equal(ok.values.loud.value, true);
  assert.equal(ok.values.text.value, 'hello there');
  err(() => parseArgs(say, 'abc yes hi'), /count.*whole number/i);
  err(() => parseArgs(say, '9 yes hi'), /count.*at most 5/i);
  err(() => parseArgs(say, '0 yes hi'), /count.*at least 1/i);
  err(() => parseArgs(say, '2 maybe hi'), /loud.*true or false/i);
});

test('string length limits are enforced', () => {
  err(() => parseArgs(ban, `${USER} ${'x'.repeat(21)}`), /reason.*at most 20/i);
});

test('choices match by value or by (quoted) name, case-insensitively', () => {
  assert.equal(parseArgs(ban, `user:${USER} delete_messages:3600`).values.delete_messages.value, 3600);
  assert.equal(
    parseArgs(ban, `user:${USER} delete_messages:"previous 24 hours"`).values.delete_messages.value,
    86_400
  );
  err(() => parseArgs(ban, `user:${USER} delete_messages:5`), /delete_messages.*one of/i);
});

test('subcommands: required, validated, and options are scoped to the chosen one', () => {
  const add = parseArgs(warn, `add ${USER} too loud`);
  assert.equal(add.subcommand, 'add');
  assert.equal(add.values.reason.value, 'too loud');
  assert.deepEqual(parseArgs(warn, 'LIST'), { subcommand: 'list', values: {} });
  err(() => parseArgs(warn, ''), /add.*list|list.*add/i);
  err(() => parseArgs(warn, 'remove'), /unknown.*remove/i);
  err(() => parseArgs(warn, 'add'), /user/);
});

test('extra arguments after a non-string last option are rejected', () => {
  err(() => parseArgs(say, '2 yes'), /text/i); // required "text" still missing
  const numeric = new SlashCommandBuilder()
    .setName('n')
    .setDescription('n')
    .addIntegerOption((o) => o.setName('a').setDescription('a').setRequired(true))
    .toJSON();
  err(() => parseArgs(numeric, '1 2'), /too many/i);
});

test('assigning the same option twice is an error', () => {
  err(() => parseArgs(ban, `${USER} user:${USER}`), /user.*twice|duplicate/i);
});

test('a required attachment option cannot be satisfied over a prefix command', () => {
  const up = new SlashCommandBuilder()
    .setName('up')
    .setDescription('up')
    .addAttachmentOption((o) => o.setName('file').setDescription('f').setRequired(true))
    .toJSON();
  err(() => parseArgs(up, ''), /attachment/i);
});
