import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRankCard, renderLeaderboardCard, rankCardAvailable } from '../src/bot/lib/rankCard.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // "\x89PNG"

test(
  'renderRankCard produces a PNG buffer',
  { skip: !rankCardAvailable && 'canvas not installed' },
  async () => {
    const buf = await renderRankCard({
      name: 'A really quite long display name that must be ellipsized',
      avatarUrl: 'https://invalid.example/none.png', // load fails -> placeholder circle
      level: 12,
      rank: 3,
      totalRanked: 250,
      xpInto: 640,
      xpNeed: 1780,
      messages: 4213,
    });
    assert.ok(Buffer.isBuffer(buf), 'returns a Buffer');
    assert.ok(buf.length > 1000, 'buffer is non-trivial');
    assert.deepEqual(buf.subarray(0, 4), PNG_MAGIC);
  }
);

test(
  'renderRankCard tolerates zero / missing progress',
  { skip: !rankCardAvailable && 'canvas not installed' },
  async () => {
    const buf = await renderRankCard({
      name: 'x',
      avatarUrl: '',
      level: 0,
      rank: 1,
      xpInto: 0,
      xpNeed: 100,
      messages: 0,
    });
    assert.deepEqual(buf.subarray(0, 4), PNG_MAGIC);
  }
);

test(
  'renderLeaderboardCard produces a PNG for a full top-10',
  { skip: !rankCardAvailable && 'canvas not installed' },
  async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      rank: i + 1,
      name: `Member number ${i + 1} with a long-ish name`,
      avatarUrl: '',
      level: 30 - i * 2,
      xp: 90000 - i * 7000,
    }));
    const buf = await renderLeaderboardCard({
      title: 'Leaderboard — My Server',
      rows,
      footer: 'Your rank: #42',
    });
    assert.ok(Buffer.isBuffer(buf) && buf.length > 1000);
    assert.deepEqual(buf.subarray(0, 4), PNG_MAGIC);
  }
);

test(
  'renderLeaderboardCard handles a single row and no footer',
  { skip: !rankCardAvailable && 'canvas not installed' },
  async () => {
    const buf = await renderLeaderboardCard({
      title: 'x',
      rows: [{ rank: 1, name: 'Solo', avatarUrl: '', level: 1, xp: 10 }],
    });
    assert.deepEqual(buf.subarray(0, 4), PNG_MAGIC);
  }
);
