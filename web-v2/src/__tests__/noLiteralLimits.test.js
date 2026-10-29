// Module forms take their field limits (maxLength, min, max) from the server, through
// components/useModuleLimits.js, instead of hard-coding a number that can drift from the module's
// normaliser (src/modules/<id>.js, `LIMITS`). This scans the forms for numeric literals.
//
// A form that still has literals must be on ALLOWED with the reason. Convert the form and remove
// it from the list; the last test fails when a listed file no longer has any literal, so the list
// can only shrink.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const FORMS = here('../moduleForms/');

// maxLength={256}  max="30"  min={0.1}  (a number written straight into the attribute)
const LITERAL = /\b(maxLength|max|min)\s*=\s*(?:\{\s*[0-9.]+\s*\}|"[0-9.]+"|'[0-9.]+')/g;

const ALLOWED = {
  // Min/max picks of a dropdown set, 0..25: Discord's own cap of 25 options in a select menu. The
  // server stores whatever number is sent and clamps it to the real option count when it publishes
  // (modules/roles.js), so there is no setting limit to share. Every text and list limit of the
  // form is read from the server.
  'Roles.jsx': 'UI-only: Discord select menu holds at most 25 options (picks are clamped at publish)',
};

// Shared components that carry field limits for several forms; never allowed to hard-code them.
const SHARED = ['../components/EmbedCard.jsx', '../components/EmbedEditor.jsx'];

const literalsIn = (path) => [...readFileSync(path, 'utf8').matchAll(LITERAL)].map((m) => m[0]);
const forms = readdirSync(FORMS).filter((f) => f.endsWith('.jsx'));

describe('no hard-coded limits in module forms', () => {
  it('finds the module forms', () => {
    expect(forms.length).toBeGreaterThan(20);
    expect(forms).toContain('Sticky.jsx');
  });

  it.each(forms.filter((f) => !(f in ALLOWED)))('%s has no numeric maxLength/min/max literal', (file) => {
    expect(literalsIn(FORMS + file)).toEqual([]);
  });

  it.each(SHARED)('%s reads the embed limits from the server', (rel) => {
    expect(literalsIn(here(rel))).toEqual([]);
  });

  it('keeps the allow-list honest: every entry names a real form that still has a literal', () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(reason, `${file} needs a reason`).toBeTruthy();
      expect(forms, `${file} no longer exists, remove it from ALLOWED`).toContain(file);
      expect(
        literalsIn(FORMS + file).length,
        `${file} has no literal left, remove it from ALLOWED`
      ).toBeGreaterThan(0);
    }
  });
});
