import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODULES } from '../src/modules/registry.js';
import { MODULE_ICONS, moduleIcon } from '../src/web/lib/moduleIcons.js';

const header = readFileSync(new URL('../src/web/views/partials/header.ejs', import.meta.url), 'utf8');
const defined = new Set([...header.matchAll(/id="i-([\w-]+)"/g)].map((m) => m[1]));

test('every registry module has a sidebar/overview icon', () => {
  for (const m of MODULES) {
    assert.ok(MODULE_ICONS[m.id], `MODULE_ICONS missing ${m.id}`);
  }
});

test('every icon name maps to an #i-* symbol in header.ejs', () => {
  for (const name of [...Object.values(MODULE_ICONS), moduleIcon('nope')]) {
    assert.ok(defined.has(name), `#i-${name} not defined in header.ejs`);
  }
});
