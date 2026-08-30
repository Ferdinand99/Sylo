import test from 'node:test';
import assert from 'node:assert/strict';
import {
  xpForLevel,
  totalXpForLevel,
  levelFromXp,
  levelProgress,
  progressBar,
} from '../src/modules/lib/levels.js';

test('xpForLevel: MEE6 curve', () => {
  assert.equal(xpForLevel(0), 100);
  assert.equal(xpForLevel(1), 155);
  assert.equal(xpForLevel(5), 475);
});

test('totalXpForLevel: cumulative', () => {
  assert.equal(totalXpForLevel(0), 0);
  assert.equal(totalXpForLevel(1), 100);
  assert.equal(totalXpForLevel(2), 255); // 100 + 155
});

test('levelFromXp: inverse of totalXpForLevel', () => {
  assert.equal(levelFromXp(0), 0);
  assert.equal(levelFromXp(99), 0);
  assert.equal(levelFromXp(100), 1);
  assert.equal(levelFromXp(254), 1);
  assert.equal(levelFromXp(255), 2);
  for (let l = 0; l < 40; l += 1) {
    assert.equal(levelFromXp(totalXpForLevel(l)), l);
    assert.equal(levelFromXp(totalXpForLevel(l + 1) - 1), l);
  }
});

test('levelProgress: into / need / pct', () => {
  const p = levelProgress(130); // level 1 (base 100), 30 into a 155 requirement
  assert.equal(p.level, 1);
  assert.equal(p.into, 30);
  assert.equal(p.need, 155);
  assert.ok(Math.abs(p.pct - 30 / 155) < 1e-9);
});

test('progressBar: clamps and renders width', () => {
  assert.equal(progressBar(0, 10), '░░░░░░░░░░ 0%');
  assert.equal(progressBar(1, 10), '██████████ 100%');
  assert.equal(progressBar(2, 10), '██████████ 100%'); // clamped
});
