// What Fluxer sees of Temporary roles: the chat forms of /temprole are understood by the
// prefix-command parser (member and role mentions, a duration, a free-text reason), and the dashboard
// tells Fluxer users about the chat commands.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { data as temproleData } from '../src/bot/commands/temprole.js';
import { parseArgs, ParseError } from '../src/bot/framework/parser.js';
import { modulePlatformNote } from '../src/platform/modulePlatformNotes.js';

const schema = temproleData.toJSON();
const plain = (r) => Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, v.value]));

test('!temprole add @member @role 7d and a free-text reason', () => {
  const r = parseArgs(
    schema,
    'add <@100000000000000011> <@&100000000000000700> 7d Trial period for the new mod'
  );
  assert.equal(r.subcommand, 'add');
  assert.deepEqual(plain(r), {
    member: '<@100000000000000011>',
    role: '<@&100000000000000700>',
    duration: '7d',
    reason: 'Trial period for the new mod',
  });
});

test('the same with names, and with the reason quoted', () => {
  const r = parseArgs(
    schema,
    'add member:<@100000000000000011> role:<@&100000000000000700> duration:1d12h reason:"Trial period"'
  );
  assert.deepEqual(plain(r), {
    member: '<@100000000000000011>',
    role: '<@&100000000000000700>',
    duration: '1d12h',
    reason: 'Trial period',
  });
  assert.equal(plain(parseArgs(schema, 'add <@1> <@&2> 30m')).reason, undefined, 'the reason is optional');
});

test('missing or oversized parts are parse errors, not half commands', () => {
  assert.throws(() => parseArgs(schema, 'add <@1> <@&2>'), /duration/);
  assert.throws(() => parseArgs(schema, 'add <@1>'), /role|duration/);
  assert.throws(() => parseArgs(schema, 'add'), /member/);
  assert.throws(() => parseArgs(schema, `add <@1> <@&2> 7d reason:${'a'.repeat(501)}`), ParseError);
  assert.throws(() => parseArgs(schema, `add <@1> <@&2> ${'1d'.repeat(30)}`), ParseError);
});

test('!temprole remove and !temprole list', () => {
  const r = parseArgs(schema, 'remove <@1> <@&2> Not needed any more');
  assert.equal(r.subcommand, 'remove');
  assert.equal(plain(r).reason, 'Not needed any more');
  assert.equal(parseArgs(schema, 'list').subcommand, 'list');
  assert.equal(plain(parseArgs(schema, 'list <@1>')).member, '<@1>');
  assert.throws(() => parseArgs(schema, 'remove <@1>'), /role/);
  assert.throws(() => parseArgs(schema, 'wipe'), /Unknown subcommand/);
});

test('the dashboard tells Fluxer users about the chat commands', () => {
  const note = modulePlatformNote('fluxer', 'temp-roles');
  assert.match(note, /!temprole add @member @role 7d/);
  assert.match(note, /expire on their own/);
  assert.equal(modulePlatformNote('discord', 'temp-roles'), null);
});
