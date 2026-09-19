import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCommands } from '../src/bot/loadCommands.js';
import { GROUPS, otherCommands } from '../src/bot/commands/help.js';

// Regression test for a real bug: /help crashed ("Received one or more
// errors") once the commands left ungrouped under "Other" pushed that
// field's value past Discord's 1024-char-per-field limit. /help was then
// rebuilt as a select-menu-paginated command (one category per page) partly
// to fix this and partly so it reads better — this test's job is making
// sure nothing added later can silently cross the same limit again without
// a test failure pointing at it, and that every category actually has a
// real command in it (a typo'd name would otherwise render as an empty
// page instead of erroring).
const FIELD_LIMIT = 1024;

test("help: every category's page stays under Discord's 1024-char description limit", async () => {
  const all = await loadCommands();

  for (const group of GROUPS) {
    const lines = group.commands.map((n) => all.get(n)).filter(Boolean);
    assert.equal(
      lines.length,
      group.commands.length,
      `"${group.name}" references a command name that doesn't exist: ` +
        group.commands.filter((n) => !all.has(n)).join(', ')
    );
    const value = lines.map((c) => `/${c.data.name} — ${c.data.description}`).join('\n');
    assert.ok(
      value.length <= FIELD_LIMIT,
      `"${group.name}" page is ${value.length} chars — over the ${FIELD_LIMIT} limit`
    );
  }

  const other = otherCommands(all);
  const otherValue = other.map((c) => `/${c.data.name} — ${c.data.description}`).join('\n');
  assert.ok(
    otherValue.length <= FIELD_LIMIT,
    `"Other" page is ${otherValue.length} chars (commands: ${other.map((c) => c.data.name).join(', ')}) — ` +
      `over the ${FIELD_LIMIT} limit; add the new command(s) to a group in help.js`
  );
});

test('help: every real command is covered by exactly one GROUPS entry (or falls through to Other)', async () => {
  const all = await loadCommands();
  const counts = new Map();
  for (const group of GROUPS) {
    for (const name of group.commands) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const duplicates = [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
  assert.deepEqual(duplicates, [], `command(s) listed in more than one group: ${duplicates.join(', ')}`);

  // Not asserting `other` is empty — a brand new command legitimately lands
  // there until someone groups it — just that GROUPS hasn't drifted to
  // reference a command that no longer exists (covered above) and that the
  // "Other" catch-all still works as a safety net either way.
  assert.ok(Array.isArray(otherCommands(all)));
});

test("help: GROUPS names are unique and stay within Discord's 25-option select-menu limit", () => {
  const names = GROUPS.map((g) => g.name);
  assert.equal(new Set(names).size, names.length);
  // +1 for "Overview" and +1 for a possible "Other" option.
  assert.ok(GROUPS.length + 2 <= 25);
});
