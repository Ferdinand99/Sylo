import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODULES } from '../src/modules/registry.js';
import { MODULE_ICONS, moduleIcon } from '../src/web/lib/moduleIcons.js';

// The overview API names each card's icon from MODULE_ICONS. The web dashboard (web-v2) draws its
// own sidebar icons and ignores that field; the one consumer is the Sylo app, which translates
// each name to an SF Symbol in ModuleSymbol.swift. A name missing from that table shows the
// fallback symbol, so keep the two in step.
const swift = readFileSync(
  new URL('../apps/sylo-ios/SyloKit/Sources/SyloKit/Presentation/ModuleSymbol.swift', import.meta.url),
  'utf8'
);
const known = new Set([...swift.matchAll(/^\s*"([\w-]+)":\s*"[\w.]+",?\s*$/gm)].map((m) => m[1]));

test('every registry module has an overview icon', () => {
  for (const m of MODULES) {
    assert.ok(MODULE_ICONS[m.id], `MODULE_ICONS missing ${m.id}`);
  }
});

test('every icon name has an SF Symbol in the Sylo app (ModuleSymbol.swift)', () => {
  assert.ok(known.size > 20, 'could not read the ModuleSymbol table');
  for (const name of Object.values(MODULE_ICONS)) {
    assert.ok(known.has(name), `"${name}" is not in ModuleSymbol.swift`);
  }
});

test('an unknown module gets the neutral icon', () => {
  assert.equal(moduleIcon('nope'), 'sliders');
});
