import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(src, ...p), 'utf8');
const cssFiles = [
  ...['styles.css', 'forms.css', 'pages.css', 'dashux.css'],
  ...readdirSync(join(src, 'styles'))
    .filter((f) => f.endsWith('.css'))
    .map((f) => join('styles', f)),
];

describe('stylesheets', () => {
  it('loads every stylesheet of styles/ with the entry, so a page does not depend on which one was opened first', () => {
    const main = read('main.jsx');
    for (const f of readdirSync(join(src, 'styles')).filter((name) => name.endsWith('.css'))) {
      expect(main, f).toContain(`import './styles/${f}';`);
    }
  });

  it('clears the top bar and the jump list once for a jump: in scroll-padding, never also in scroll-margin', () => {
    expect(read('dashux.css')).toMatch(
      /html \{\s*scroll-padding-top: calc\(var\(--topbar-h\) \+ var\(--sticky-index-h, 0px\) \+ 8px\);/
    );
    for (const file of cssFiles) {
      const css = read(file);
      for (const m of css.matchAll(/scroll-margin-top:([^;]+);/g)) {
        expect(m[1], `${file}: ${m[0]}`).not.toMatch(/--topbar-h|--sticky-index-h/);
      }
    }
  });

  it('wraps a row of tabs at one breakpoint, 600 px, in one rule', () => {
    const all = cssFiles.map((f) => read(f)).join('\n');
    expect(all).toMatch(/@media \(max-width: 600px\) \{\s*\.v2-tabs\.v2-tabs-wrap \{/);
    expect(all).not.toMatch(/hub-tabs-wrap/);
    expect(all).not.toContain('max-width: 599px');
  });
});
