import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../src/db/index.js';

const hasTable = (d, t) =>
  d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) != null;

test('the scattered dedupe tables are folded into posted_keys on upgrade', () => {
  const d = new Database(':memory:');
  let seeded = false;

  // Replay the schema migration by migration. Just before the one that
  // introduces posted_keys, drop a row into each legacy table so we can prove
  // it is carried across. Finding the boundary this way keeps the test valid
  // no matter how many migrations come after it.
  for (const migration of MIGRATIONS) {
    if (
      !seeded &&
      !hasTable(d, 'posted_keys') &&
      ['free_games_posted', 'twitch_live', 'youtube_live', 'youtube_video_seen'].every((t) => hasTable(d, t))
    ) {
      d.prepare('INSERT INTO free_games_posted (guild_id, game_key, posted_at) VALUES (?,?,?)').run(
        'g1',
        'epic:witcher',
        111
      );
      d.prepare('INSERT INTO twitch_live (guild_id, login, stream_id, posted_at) VALUES (?,?,?,?)').run(
        'g1',
        'ninja',
        'S9',
        222
      );
      d.prepare('INSERT INTO youtube_live (guild_id, yt_channel, video_id, posted_at) VALUES (?,?,?,?)').run(
        'g1',
        'UCabc',
        'VLIVE',
        333
      );
      d.prepare(
        'INSERT INTO youtube_video_seen (guild_id, yt_channel, video_id, seen_at) VALUES (?,?,?,?)'
      ).run('g1', 'UCabc', 'V1', 444);
      seeded = true;
    }
    migration(d);
  }

  assert.ok(seeded, 'the legacy tables existed before the posted_keys migration');

  const rows = d.prepare('SELECT scope, key, value, posted_at FROM posted_keys ORDER BY scope, key').all();
  assert.deepEqual(rows, [
    { scope: 'free-games', key: 'epic:witcher', value: null, posted_at: 111 },
    { scope: 'twitch', key: 'ninja', value: 'S9', posted_at: 222 },
    { scope: 'yt-live', key: 'UCabc', value: 'VLIVE', posted_at: 333 },
    { scope: 'yt-video', key: 'UCabc:V1', value: null, posted_at: 444 },
  ]);

  for (const t of ['free_games_posted', 'twitch_live', 'youtube_live', 'youtube_video_seen']) {
    assert.equal(hasTable(d, t), false, `${t} should be dropped`);
  }
});
