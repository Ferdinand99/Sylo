import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scheduledCount, activeTimerCount } from '../src/modules/schedule.js';

test('importing every module registers its timers but starts none', async () => {
  await import('../src/modules/index.js');
  // 18 modules with one recurring job each, plus leveling with two.
  assert.ok(scheduledCount() >= 20, `expected at least 20 registrations, got ${scheduledCount()}`);
  assert.equal(activeTimerCount(), 0);
});

test('no module starts a timer of its own at import time', () => {
  const dir = fileURLToPath(new URL('../src/modules/', import.meta.url));
  const offenders = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'schedule.js')) {
    const source = readFileSync(dir + file, 'utf8');
    if (/\bsetInterval\s*\(/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'recurring work goes through every() in modules/schedule.js');
});
