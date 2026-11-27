// Text a server admin or moderator types with line breaks (an appeal question, a decision note) keeps
// them on the public appeal page: the element gets `u-pre-line`, which public.css sets to
// `white-space: pre-line`. Without it the browser joins the lines into one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { SAMPLES, VIEWS } from './helpers/publicViews.js';

const render = (name, extra) =>
  ejs.renderFile(join(VIEWS, SAMPLES[name].file), { ...SAMPLES[name].data, ...extra });

test('public.css keeps line breaks for u-pre-line', () => {
  const file = fileURLToPath(new URL('../src/web/public/public.css', import.meta.url));
  const css = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  assert.match(css, /\.u-pre-line \{\n {2}white-space: pre-line;\n\}/);
});

test('appeal form: each question keeps its line breaks', async () => {
  const html = await render('appeal-form', { questions: ['Why were you banned?\nBe honest.'] });
  assert.match(html, /<label for="appeal-a-0" class="u-pre-line">Why were you banned\?\nBe honest\./);
});

test('appeal decided: the note from the moderators keeps its line breaks', async () => {
  const accepted = await render('appeal-accepted', { decisionReason: 'Welcome back.\nRead the rules.' });
  assert.match(
    accepted,
    /<p class="u-pre-line"><strong>Note from the moderators:<\/strong> Welcome back\.\n/
  );

  const denied = await render('appeal-denied', { decisionReason: 'Spam.\nTwice.' });
  assert.match(denied, /<p class="u-pre-line"><strong>Reason:<\/strong> Spam\.\nTwice\./);

  const other = await render('appeal-denied', { verdict: 'other', decisionReason: 'Line one\nLine two' });
  assert.match(other, /<p class="muted u-pre-line">Line one\nLine two<\/p>/);
});
