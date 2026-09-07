// Proves insights.js against a real Postgres connection — in particular the
// ON CONFLICT ... DO UPDATE SET upserts, whose bare `col = col + excluded.col`
// form is ambiguous on Postgres (42702, checklist item 8 in docs/roadmap.md)
// even though SQLite never complains; both are qualified with the real table
// name here, and this test is what actually proves that against Postgres.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'insights against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      accrueDaily,
      accrueHourly,
      dailySeries,
      hourlySeries,
      topChannels,
      topVoiceChannels,
      pruneInsights,
      utcDay,
      utcHour,
    } = await import('../src/db/insights.js');
    const { prepare } = await import('../src/db/driver.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-insights-${Date.now()}`;

    await t.test('accrueDaily adds counters, MAXes the *_members / peak, merges both maps', async () => {
      const day = utcDay();
      await accrueDaily(G, day, {
        joins: 2,
        leaves: 1,
        messages: 10,
        activeCount: 4,
        voiceMinutes: 30,
        voiceActiveCount: 3,
        voicePeak: 5,
        channels: { c1: 7, c2: 3 },
        voiceChannels: { v1: 20 },
      });
      await accrueDaily(G, day, {
        joins: 1,
        messages: 5,
        activeCount: 3,
        voiceMinutes: 15,
        voiceActiveCount: 6,
        voicePeak: 2,
        channels: { c1: 2, c3: 5 },
        voiceChannels: { v1: 10, v2: 4 },
      });

      const s = await dailySeries(G, 1);
      const today = s[0];
      assert.equal(today.messages, 15);
      assert.equal(today.joins, 3);
      assert.equal(today.activeMembers, 4); // MAX(4, 3)
      assert.equal(today.voiceMinutes, 45); // 30 + 15
      assert.equal(today.voiceActiveMembers, 6); // MAX(3, 6)
      assert.equal(today.voicePeak, 5); // MAX(5, 2)

      const tc = await topChannels(G, 1, 5);
      assert.deepEqual(tc.map((t) => t.channelId).sort(), ['c1', 'c2', 'c3']);
      assert.equal(tc.find((t) => t.channelId === 'c1').messages, 9);
    });

    await t.test('accrueHourly + hourlySeries: per-hour buckets, additive across calls', async () => {
      const h = utcHour();
      await accrueHourly(G, h, { messages: 8, voiceMinutes: 12, voiceActiveCount: 2 });
      await accrueHourly(G, h, { messages: 2 });
      const s = await hourlySeries(G, 1);
      assert.equal(s[0].messages, 10);
      assert.equal(s[0].voiceMinutes, 12);
    });

    await t.test('topVoiceChannels: merged, sorted desc, limited', async () => {
      const earlier = utcDay(Date.now() - 2 * 86_400_000);
      await accrueDaily(G, earlier, { channels: { c2: 100 }, voiceChannels: { v2: 500 } });
      const tv = await topVoiceChannels(G, 30, 2);
      assert.deepEqual(
        tv.map((t) => t.channelId),
        ['v2', 'v1']
      );
      // v2: 500 (this call) + 4 (today's row, from the accrueDaily test above)
      assert.equal(tv[0].minutes, 504);
    });

    await t.test('pruneInsights drops old daily and hourly rows, keeps recent ones', async () => {
      const old = '2020-01-01';
      await accrueDaily(G, old, { messages: 9 });
      await accrueHourly(G, `${old}T05`, { messages: 9 });
      const today = utcDay();

      await pruneInsights(180, 72);

      const checkDay = prepare('SELECT 1 AS x FROM guild_daily WHERE guild_id = ? AND day = ?');
      const checkHour = prepare('SELECT 1 AS x FROM guild_hourly WHERE guild_id = ? AND hour = ?');
      assert.equal(await checkDay.get(G, old), undefined, 'old day pruned');
      assert.equal(await checkHour.get(G, `${old}T05`), undefined, 'old hour pruned');
      assert.ok(await checkDay.get(G, today), 'recent day kept');
    });
  }
);
