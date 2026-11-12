// What a member types is read in time that grows with its length, never with its square or worse: the numbers
// of the options in DM, a long answer, a text with long runs of white space or backslashes.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalise,
  chunkText,
  dmQuestionOf,
  exportCsv,
  fillTemplate,
  normaliseQuestions,
  parseNumberList,
  trailingBackslashes,
} from '../src/modules/lib/applicationsForm.js';
import { cut } from '../src/modules/introductions.js';

const [pick, multi, text] = normaliseQuestions([
  { id: 'p', type: 'choice', label: 'Pick', options: [{ label: 'a' }, { label: 'b' }] },
  {
    id: 'm',
    type: 'choice',
    label: 'Many',
    multiple: true,
    options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
  },
  { id: 't', type: 'text', label: 'Text', long: true, maxLength: 4000 },
]);

/** Run `fn` and fail if it takes longer than `ms`. */
function quick(name, fn, ms = 100) {
  const start = performance.now();
  const out = fn();
  const took = performance.now() - start;
  assert.ok(took < ms, `${name} took ${took.toFixed(1)} ms`);
  return out;
}

test('the numbers of the options are read the same way as before', () => {
  for (const [input, want] of [
    ['1', [1]],
    ['12', [12]],
    ['1 3', [1, 3]],
    ['1,3', [1, 3]],
    ['1 , 3', [1, 3]],
    ['1\t,\t3', [1, 3]],
    ['  2  ', [2]],
    ['1 2 3', [1, 2, 3]],
    ['1, 2,3', [1, 2, 3]],
    ['', null],
    ['   ', null],
    [',1', null],
    ['1,', null],
    ['1,,2', null],
    ['1 ,, 2', null],
    ['1;2', null],
    ['one', null],
    ['1a', null],
    ['-1', null],
    ['1.5', null],
  ]) {
    assert.deepEqual(parseNumberList(input), want, JSON.stringify(input));
  }
});

test('hostile answers to a numbered question are refused quickly, whatever their shape', () => {
  const hostile = [
    `${'\t\t0'.repeat(50000)}x`,
    `${'1 '.repeat(100000)}x`,
    `${'1,'.repeat(100000)}x`,
    `${' '.repeat(200000)}x`,
    `${'0'.repeat(200000)}x`,
    `${'1 ,'.repeat(70000)}`,
    '9'.repeat(200000),
  ];
  for (const q of [pick, multi]) {
    const normalise = dmQuestionOf(q).normalise;
    for (const input of hostile) {
      const out = quick(`${q.id}: ${input.slice(0, 12)}…`, () => normalise(input));
      assert.ok(typeof out === 'object' && out.error, 'refused with a message');
    }
  }
});

test('long runs of white space, backslashes and separators in an answer or a text cost no more than their length', () => {
  const runs = ['\\', ' ', '\t', ';', ',', '\n', '=', '😀'];
  for (const run of runs) {
    const big = `${run.repeat(60000)}x`;
    quick(`canonicalise ${JSON.stringify(run)}`, () => canonicalise(text, big));
    quick(`chunkText ${JSON.stringify(run)}`, () => chunkText(big));
    quick(`fillTemplate ${JSON.stringify(run)}`, () => fillTemplate(`${big} {user}`, { user: 'x' }));
    quick(`cut ${JSON.stringify(run)}`, () => cut(big, 1024));
    quick(`csv ${JSON.stringify(run)}`, () =>
      exportCsv([
        { id: 1, userId: '1', status: 'pending', createdAt: 0, questions: [text], answers: { t: big } },
      ])
    );
  }
});

test('the helpers still do what they did', () => {
  assert.equal(trailingBackslashes('ab\\\\\\'), 3);
  assert.equal(trailingBackslashes('ab'), 0);
  assert.equal(fillTemplate('Hi {user}   \n  next \t\nend  ', { user: 'x' }), 'Hi x\n  next\nend');
  const pieces = chunkText(`${'a'.repeat(1023)}\\\\b`, 1024);
  assert.ok(
    pieces.every((p) => trailingBackslashes(p) % 2 === 0),
    'a piece never ends in half an escape'
  );
  // the cut would end after one backslash, half an escape: it ends before it
  assert.equal(cut(`${'x'.repeat(10)}\\\\\\\\`, 12), 'xxxxxxxxxx…');
});
