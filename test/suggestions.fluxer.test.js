// What Fluxer sees of Suggestions: the chat forms of /suggest and /suggestion are understood by the
// prefix-command parser, and the two vote buttons become two different reactions with a legend.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { data as suggestData } from '../src/bot/commands/suggest.js';
import { data as suggestionData } from '../src/bot/commands/suggestion.js';
import { parseArgs, ParseError } from '../src/bot/framework/parser.js';
import { planComponents, withComponentText } from '../src/platform/components.js';
import { buildSuggestionPayload } from '../src/modules/suggestions.js';
import { modulePlatformNote } from '../src/platform/modulePlatformNotes.js';

const suggest = suggestData.toJSON();
const suggestion = suggestionData.toJSON();
const plain = (r) => Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, v.value]));

test('!suggest takes a quoted text, with or without names, and an optional title', () => {
  assert.deepEqual(plain(parseArgs(suggest, 'text:"Add a movie night" title:Movies')), {
    text: 'Add a movie night',
    title: 'Movies',
  });
  assert.deepEqual(plain(parseArgs(suggest, '"Add a movie night"')), { text: 'Add a movie night' });
  assert.throws(() => parseArgs(suggest, ''), /text/);
  assert.throws(() => parseArgs(suggest, `text:${'a'.repeat(1001)}`), ParseError);
  assert.throws(() => parseArgs(suggest, `text:x title:${'a'.repeat(101)}`), ParseError);
});

test('!suggestion approve|deny|implement|consider id:12 reason:"..."', () => {
  for (const sub of ['approve', 'deny', 'implement', 'consider']) {
    const r = parseArgs(suggestion, `${sub} id:12 reason:"Starting next week"`);
    assert.equal(r.subcommand, sub);
    assert.equal(r.values.id.value, 12);
    assert.equal(r.values.reason.value, 'Starting next week');
  }
  assert.equal(parseArgs(suggestion, 'approve 12').values.id.value, 12);
  assert.equal(parseArgs(suggestion, 'deny 3').values.reason, undefined, 'the reason is optional');
  assert.throws(() => parseArgs(suggestion, 'approve'), /id/);
  assert.throws(() => parseArgs(suggestion, `approve id:1 reason:${'a'.repeat(501)}`), ParseError);
  assert.throws(() => parseArgs(suggestion, 'approve id:0'), ParseError);
});

test('the 👍 / 👎 buttons become two reactions with a legend; a decided suggestion has none', () => {
  const base = {
    id: 4,
    guild_id: '1',
    number: 9,
    channel_id: '2',
    author_id: '3',
    anonymous: false,
    title: '',
    body: 'Idea',
    status: 'open',
    reason: '',
    decided_by: null,
    created_at: 0,
  };
  const payload = buildSuggestionPayload(base, { up: 5, down: 2 });
  const plan = planComponents(payload.components);
  assert.deepEqual(
    plan.actions.map((a) => [a.emoji, a.customId]),
    [
      ['👍', 'sug:up:4'],
      ['👎', 'sug:down:4'],
    ]
  );
  assert.match(withComponentText({}, plan).content, /👍 5\n👎 2/);
  assert.deepEqual(
    planComponents(buildSuggestionPayload({ ...base, status: 'approved' }).components).actions,
    []
  );
});

test('the dashboard tells Fluxer users about the reactions and the missing thread', () => {
  const note = modulePlatformNote('fluxer', 'suggestions');
  assert.match(note, /reacting/);
  assert.match(note, /no discussion thread/);
  assert.match(note, /!suggest text:/);
  assert.equal(modulePlatformNote('discord', 'suggestions'), null);
});
