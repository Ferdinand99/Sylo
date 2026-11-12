// The CSV export read the way spreadsheets read it: by a reader with a ";" separator (Excel in Norway and most
// of Europe) and by readers that leave quote mode early and split at every separator. No cell that comes out may
// start with a formula character, whatever the answer holds and whichever separator is used.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportCsv, normaliseQuestions } from '../src/modules/lib/applicationsForm.js';

const [question] = normaliseQuestions([{ id: 'q', type: 'text', label: 'Why', long: true }]);

const submission = (id, answer) => ({
  id,
  userId: '700000000000000010',
  status: 'pending',
  createdAt: 1_700_000_000_000,
  questions: [question],
  answers: { q: answer },
});

/** A strict reader (RFC 4180) with a given separator. */
function readStrict(text, separator) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === separator) {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += c;
  }
  return rows;
}

/** The worst case: a reader that ignores quotes and splits at every separator, tab and line break. */
const readNaive = (text) => text.split(/[;,\t\r\n]/).map((cell) => cell.replace(/^[" ]+/, ''));

const TRIGGER = /^[=+\-@]/;
const ANSWERS = [
  'x;=1+1;',
  'x,=1+1,',
  'a\t=cmd()',
  'a\r=cmd()',
  ';=1+1',
  ',+1',
  'one; -2',
  'x;@SUM(A1);',
  'plain, text; with = signs and - dashes, +too',
  '=1+1',
  'x;=WEBSERVICE(CHAR(104)&"y");',
];

test('no cell starts with a formula character, read with ";", with "," or with no care for the quotes', () => {
  const csv = exportCsv(ANSWERS.map((a, i) => submission(i + 1, a)));
  for (const separator of [';', ',']) {
    for (const row of readStrict(csv, separator)) {
      for (const cell of row) assert.doesNotMatch(cell, TRIGGER, `${separator}: ${JSON.stringify(cell)}`);
    }
  }
  for (const cell of readNaive(csv)) assert.doesNotMatch(cell, TRIGGER, `naive: ${JSON.stringify(cell)}`);
});

test('a ";" reader still gets the answer back in its own cell, with only the apostrophes added', () => {
  const csv = exportCsv([submission(1, 'x;=1+1;'), submission(2, 'fine')]);
  // read with "," as the separator the answer is one cell; the apostrophe stands where the formula would start
  const rows = readStrict(csv, ',');
  assert.deepEqual(
    rows.map((r) => r.at(-1)),
    ['Why', "x;'=1+1;", 'fine']
  );
  assert.ok(
    rows.every((r) => r.length === 5),
    'five cells in every row'
  );
});
