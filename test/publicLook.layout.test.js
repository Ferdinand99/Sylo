// The panel a server's background picture shows through: on a phone it keeps a margin all round (so the picture is
// seen on every side, not just as a strip above and below), and on the dashboard-app pages it is as tall as its page
// instead of the window. Read from the style sheets themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** The declarations of the first rule whose selector is exactly `selector`, inside the text `css`. */
function ruleBody(css, selector) {
  const at = css.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `no rule for ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

test('the server-rendered pages (public.css) keep a margin round the panel on a phone', () => {
  const css = read('src/web/public/public.css');
  const media = css.slice(css.indexOf('@media (max-width: 600px) {\n  body.has-look-image main'));
  assert.match(ruleBody(media, '  body.has-look-image main'), /margin: 12px;/);
});

test('the pages of the dashboard app (p3-look.css) keep the margin and are as tall as their content', () => {
  const css = read('web-v2/src/styles/p3-look.css');
  const media = css.slice(css.indexOf('@media (max-width: 600px) {\n  body.has-look-image .v2-public-page'));
  assert.match(ruleBody(media, '  body.has-look-image .v2-public-page'), /margin: 12px;/);
  assert.match(ruleBody(css, 'body.has-look-image .v2-public-page'), /flex: none;/);
});

test('the period pills of the leaderboard are not underlined like running text', () => {
  const css = read('src/web/public/public.css');
  assert.match(ruleBody(css, 'body.has-look main .lb-periods a'), /text-decoration: none;/);
});
