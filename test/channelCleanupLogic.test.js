import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { todayStr, isDue, cleanupChannel } from '../src/modules/channelCleanup.js';

test('todayStr formats as YYYY-MM-DD in local time', () => {
  assert.equal(todayStr(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(todayStr(new Date(2026, 8, 1, 0, 0)), '2026-09-01');
});

test('isDue: matches day-of-week and a short window after the scheduled time', () => {
  const schedule = { dayList: [1, 3, 5], time_hhmm: '09:00' };
  // Wednesday 2026-01-07
  assert.ok(isDue(schedule, new Date(2026, 0, 7, 9, 0)));
  assert.ok(isDue(schedule, new Date(2026, 0, 7, 9, 9)));
  assert.ok(!isDue(schedule, new Date(2026, 0, 7, 8, 59)));
  assert.ok(!isDue(schedule, new Date(2026, 0, 7, 9, 20)));
  // Tuesday 2026-01-06 — not a scheduled day
  assert.ok(!isDue(schedule, new Date(2026, 0, 6, 9, 0)));
});

test('isDue: rejects a malformed time string', () => {
  assert.ok(!isDue({ dayList: [0, 1, 2, 3, 4, 5, 6], time_hhmm: 'nope' }, new Date()));
});

function fakeMessage(id, ageMs, pinned = false) {
  return { id, createdTimestamp: Date.now() - ageMs, pinned, delete: async () => {} };
}

function fakeChannel(messages, { bulkDeletable = () => true } = {}) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const ordered = [...messages]; // newest-first, as Discord returns
  return {
    messages: {
      async fetch({ limit, before }) {
        let startIndex = 0;
        if (before) {
          const idx = ordered.findIndex((m) => m.id === before);
          startIndex = idx + 1;
        }
        const page = ordered.slice(startIndex, startIndex + limit);
        return new Collection(page.map((m) => [m.id, m]));
      },
    },
    async bulkDelete(candidates) {
      const deleted = new Collection();
      for (const m of candidates.values()) {
        if (bulkDeletable(m)) {
          deleted.set(m.id, m);
          byId.delete(m.id);
        }
      }
      return deleted;
    },
  };
}

test('cleanupChannel: bulk-deletes recent old messages, skips pinned ones', async () => {
  const messages = [
    fakeMessage('1', 20 * 3600_000), // 20h old
    fakeMessage('2', 30 * 3600_000, true), // 30h old, pinned
    fakeMessage('3', 1 * 3600_000), // 1h old — under threshold
  ];
  const channel = fakeChannel(messages);
  const result = await cleanupChannel(channel, { maxAgeHours: 12, skipPinned: true });
  assert.equal(result.bulkDeleted, 1);
  assert.equal(result.individualDeleted, 0);
  assert.equal(result.scanned, 3);
});

test('cleanupChannel: falls back to individual deletes for messages bulkDelete refuses (>14 days)', async () => {
  let individuallyDeleted = 0;
  const old = fakeMessage('1', 20 * 24 * 3600_000); // 20 days old
  old.delete = async () => {
    individuallyDeleted += 1;
  };
  const messages = [old, fakeMessage('2', 1 * 3600_000)];
  const channel = fakeChannel(messages, {
    bulkDeletable: (m) => Date.now() - m.createdTimestamp < 14 * 24 * 3600_000,
  });
  const result = await cleanupChannel(channel, { maxAgeHours: 1, skipPinned: true });
  assert.equal(result.bulkDeleted, 0);
  assert.equal(result.individualDeleted, 1);
  assert.equal(individuallyDeleted, 1);
});

test('cleanupChannel: skipPinned=false deletes pinned messages too', async () => {
  const messages = [fakeMessage('1', 5 * 3600_000, true)];
  const channel = fakeChannel(messages);
  const result = await cleanupChannel(channel, { maxAgeHours: 1, skipPinned: false });
  assert.equal(result.bulkDeleted, 1);
});
