import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCase,
  getCase,
  listUserCases,
  listGuildCases,
  editCaseReason,
  setCaseActive,
  deactivateLatest,
  addWarning,
  clearWarnings,
  removeWarning,
} from '../src/db/modCases.js';

const G = '900000000000000100';
const G2 = '900000000000000101';
const U = '900000000000000110';

test('addCase: per-guild sequential numbering, isolated between guilds', () => {
  const a = addCase({ guildId: G, userId: U, moderatorId: 'm1', action: 'warn', reason: 'one' });
  const b = addCase({ guildId: G, userId: U, moderatorId: 'm1', action: 'kick', reason: 'two' });
  const c = addCase({ guildId: G2, userId: U, moderatorId: 'm1', action: 'ban', reason: 'other guild' });
  assert.equal(a.caseNumber, 1);
  assert.equal(b.caseNumber, 2);
  assert.equal(c.caseNumber, 1); // fresh sequence for G2
  assert.equal(getCase(G, 2).action, 'kick');
  assert.equal(getCase(G, 99), null);
});

test('addCase: warnCount counts only active warn rows for that user', () => {
  const g = '900000000000000102';
  addCase({ guildId: g, userId: U, moderatorId: 'm', action: 'warn' });
  addCase({ guildId: g, userId: U, moderatorId: 'm', action: 'note' }); // not a warn
  const third = addCase({ guildId: g, userId: U, moderatorId: 'm', action: 'warn' });
  assert.equal(third.warnCount, 2);
  setCaseActive(g, 1, false); // soft-delete the first warn
  const fourth = addCase({ guildId: g, userId: U, moderatorId: 'm', action: 'warn' });
  assert.equal(fourth.warnCount, 2); // #1 no longer counts, #3 + #5 do
});

test('listUserCases: newest first, paginated, hides inactive unless asked', () => {
  const g = '900000000000000103';
  for (let i = 0; i < 5; i += 1) {
    addCase({ guildId: g, userId: U, moderatorId: 'm', action: 'warn', reason: `r${i}` });
  }
  setCaseActive(g, 2, false);

  const page1 = listUserCases(g, U, { limit: 2, offset: 0 });
  assert.equal(page1.total, 4); // 5 minus the soft-deleted one
  assert.deepEqual(
    page1.rows.map((r) => r.case_number),
    [5, 4]
  );

  const withInactive = listUserCases(g, U, { limit: 10, includeInactive: true });
  assert.equal(withInactive.total, 5);
  assert.ok(withInactive.rows.some((r) => r.case_number === 2));
});

test('editCaseReason + setCaseActive', () => {
  const g = '900000000000000104';
  addCase({ guildId: g, userId: U, moderatorId: 'm', action: 'ban', reason: 'orig' });
  assert.equal(editCaseReason(g, 1, 'edited'), true);
  assert.equal(getCase(g, 1).reason, 'edited');
  assert.equal(editCaseReason(g, 99, 'x'), false);
  assert.equal(setCaseActive(g, 1, false), true);
  assert.equal(getCase(g, 1).active, 0);
});

test('deactivateLatest: flips the newest active case of that action, returns its number', () => {
  const g = '900000000000000105';
  addCase({ guildId: g, userId: U, moderatorId: 'm', action: 'ban', reason: 'a' }); // #1
  addCase({ guildId: g, userId: U, moderatorId: 'm', action: 'ban', reason: 'b' }); // #2
  const n = deactivateLatest(g, U, 'ban');
  assert.equal(n, 2);
  assert.equal(getCase(g, 2).active, 0);
  assert.equal(getCase(g, 1).active, 1);
  assert.equal(deactivateLatest(g, U, 'timeout'), null); // none of that action
});

test('listGuildCases: every action type, newest first', () => {
  const g = '900000000000000106';
  addCase({ guildId: g, userId: U, moderatorId: 'm', action: 'warn' });
  addCase({ guildId: g, userId: U, moderatorId: 'm', action: 'ban' });
  const { rows, total } = listGuildCases(g, 50);
  assert.equal(total, 2);
  assert.equal(rows[0].case_number, 2);
});

test('warning wrappers stay compatible', () => {
  const g = '900000000000000107';
  const w1 = addWarning({ guildId: g, userId: U, moderatorId: 'm', reason: 'a' });
  const w2 = addWarning({ guildId: g, userId: U, moderatorId: 'm', reason: 'b' });
  assert.deepEqual([w1.id, w1.count], [1, 1]);
  assert.deepEqual([w2.id, w2.count], [2, 2]);
  assert.equal(removeWarning(g, 1), true); // hard delete
  assert.equal(getCase(g, 1), null);
  assert.equal(clearWarnings(g, U), 1); // #2 remains
});
