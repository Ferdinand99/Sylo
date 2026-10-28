// The overview's card links are built twice: the server (src/web/lib/overviewSummary.js) for the
// cards it returns, and the app (web-v2's SPECIAL_V2_PATHS) for the sidebar and the overview page.
// They must name the same pages. The app's file is JSX-adjacent, so it is read as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { V2_CARD_PAGES, v2CardHref } from '../src/web/lib/overviewSummary.js';

const source = readFileSync(new URL('../web-v2/src/moduleForms/index.js', import.meta.url), 'utf8');

// `  messages: (guildId) => \`/guilds/${guildId}/messages\`,`  ->  { messages: 'messages' }
function specialPaths() {
  const block = /export const SPECIAL_V2_PATHS = \{([\s\S]*?)\n\};/.exec(source)?.[1];
  assert.ok(block, 'SPECIAL_V2_PATHS found in web-v2/src/moduleForms/index.js');
  const out = {};
  for (const m of block.matchAll(/^\s*(\w+): \(guildId\) => `\/guilds\/\$\{guildId\}\/([^`]+)`,?\s*$/gm)) {
    out[m[1]] = m[2];
  }
  return out;
}

test('the app has the special pages the server links to, and the same addresses', () => {
  const special = specialPaths();
  assert.ok(Object.keys(special).length >= 4, 'parsed the special pages');
  for (const [id, path] of Object.entries(special)) {
    assert.equal(v2CardHref(id, 'G1'), `/v2/guilds/G1/${path}`, id);
  }
});

test('the server has no special page the app does not know', () => {
  const special = specialPaths();
  assert.deepEqual(Object.keys(V2_CARD_PAGES).sort(), Object.keys(special).sort());
});
