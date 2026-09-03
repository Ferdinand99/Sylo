// Unit tests for the RuneScape adapter's parsing and error handling.
// No network: globalThis.fetch is stubbed per test. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';

const { runescapeAdapter } = await import('../src/adapters/games/runescape.js');
const {
  PlayerNotFoundError,
  RateLimitedError,
  UpstreamUnavailableError,
  UnsupportedGameError,
  InvalidPlatformError,
} = await import('../src/adapters/games/gameAdapter.js');

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Install a fake fetch. `impl(url)` returns a Response-like object or throws. */
function stubFetch(impl) {
  globalThis.fetch = async (url) => impl(url.toString());
}
function jsonResponse(body, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return { ok, status, json: async () => body };
}

const OSRS_PAYLOAD = {
  skills: [
    { id: 0, name: 'Overall', rank: 50000, level: 2000, xp: 150000000 },
    { id: 1, name: 'Attack', rank: 100000, level: 99, xp: 13034431 },
    { id: 2, name: 'Defence', rank: 120000, level: 99, xp: 13034431 },
    { id: 3, name: 'Strength', rank: 90000, level: 99, xp: 13034431 },
    { id: 4, name: 'Hitpoints', rank: 80000, level: 99, xp: 14000000 },
    { id: 5, name: 'Ranged', rank: 110000, level: 99, xp: 13034431 },
    { id: 6, name: 'Prayer', rank: 130000, level: 80, xp: 2000000 },
    { id: 7, name: 'Magic', rank: 95000, level: 99, xp: 13034431 },
    { id: 8, name: 'Cooking', rank: 200000, level: 90, xp: 5000000 },
    { id: 9, name: 'Woodcutting', rank: -1, level: -1, xp: -1 },
  ],
  activities: [
    { id: 0, name: 'League Points', rank: -1, score: -1 },
    { id: 1, name: 'Zulrah', rank: 5000, score: 1200 },
    { id: 2, name: 'Vorkath', rank: 8000, score: 800 },
  ],
};

test('happy path (OSRS) → normalized stats with computed combat level', async () => {
  let calledUrl = '';
  stubFetch((url) => {
    calledUrl = url;
    return jsonResponse(OSRS_PAYLOAD);
  });

  const stats = await runescapeAdapter.getPlayerStats('Zezima', 'main', { title: 'osrs' });

  assert.equal(calledUrl, 'https://secure.runescape.com/m=hiscore_oldschool/index_lite.json?player=Zezima');
  assert.equal(stats.game, 'runescape');
  assert.equal(stats.title, 'osrs');
  assert.equal(stats.titleLabel, 'Old School RuneScape');
  assert.equal(stats.username, 'Zezima');
  assert.equal(stats.platform, 'main');
  assert.equal(stats.combatLevel, '123'); // base 59.5 + melee 64.35
  assert.equal(stats.totalLevel, '2,000');
  assert.equal(stats.totalXp, '150,000,000');
  assert.equal(stats.overallRank, '#50,000');
  assert.ok(stats.profileUrl.includes('Zezima'));
  assert.equal(stats.avatar, null); // OSRS has no avatar endpoint
  assert.equal(
    stats.skills.some((s) => s.name === 'Overall'),
    false
  );
  assert.equal(stats.activities.length, 2); // the -1 activity is dropped
  assert.equal(stats.activities[0].name, 'Zulrah');
});

test('happy path (RS3) → RS3 label, avatar, and the m=hiscore path', async () => {
  let calledUrl = '';
  stubFetch((url) => {
    calledUrl = url;
    return jsonResponse({
      skills: [{ name: 'Overall', rank: 1, level: 2736, xp: 5600000000 }],
      activities: [],
    });
  });

  const stats = await runescapeAdapter.getPlayerStats('Player', 'main', { title: 'rs3' });
  assert.equal(calledUrl, 'https://secure.runescape.com/m=hiscore/index_lite.json?player=Player');
  assert.equal(stats.titleLabel, 'RuneScape 3');
  assert.match(stats.avatar, /avatar-rs\/Player\/chat\.png$/);
});

test('OSRS ironman mode → labelled title and the ironman hiscores path', async () => {
  let calledUrl = '';
  stubFetch((url) => {
    calledUrl = url;
    return jsonResponse(OSRS_PAYLOAD);
  });

  const stats = await runescapeAdapter.getPlayerStats('Iron', 'ironman', { title: 'osrs' });
  assert.match(calledUrl, /m=hiscore_oldschool_ironman\/index_lite\.json/);
  assert.equal(stats.titleLabel, 'Old School RuneScape (Ironman)');
  assert.equal(stats.platform, 'ironman');
});

test('HTTP 404 → PlayerNotFoundError', async () => {
  stubFetch(() => jsonResponse({}, { status: 404 }));
  await assert.rejects(
    runescapeAdapter.getPlayerStats('ghost', 'main', { title: 'osrs' }),
    PlayerNotFoundError
  );
});

test('HTTP 429 → RateLimitedError', async () => {
  stubFetch(() => jsonResponse({}, { status: 429 }));
  await assert.rejects(runescapeAdapter.getPlayerStats('x', 'main', { title: 'osrs' }), RateLimitedError);
});

test('HTTP 500 → UpstreamUnavailableError', async () => {
  stubFetch(() => jsonResponse({}, { status: 500 }));
  await assert.rejects(
    runescapeAdapter.getPlayerStats('x', 'main', { title: 'rs3' }),
    UpstreamUnavailableError
  );
});

test('fetch throwing (network/timeout) → UpstreamUnavailableError', async () => {
  stubFetch(() => {
    throw new Error('ETIMEDOUT');
  });
  await assert.rejects(
    runescapeAdapter.getPlayerStats('x', 'main', { title: 'osrs' }),
    UpstreamUnavailableError
  );
});

test('empty skills array → PlayerNotFoundError', async () => {
  stubFetch(() => jsonResponse({ skills: [], activities: [] }));
  await assert.rejects(runescapeAdapter.getPlayerStats('x', 'main', { title: 'osrs' }), PlayerNotFoundError);
});

test('malformed JSON → UpstreamUnavailableError', async () => {
  stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error('Unexpected token <');
    },
  }));
  await assert.rejects(
    runescapeAdapter.getPlayerStats('x', 'main', { title: 'osrs' }),
    UpstreamUnavailableError
  );
});

test('unknown title → UnsupportedGameError (no fetch)', async () => {
  let fetched = false;
  stubFetch(() => {
    fetched = true;
    return jsonResponse(OSRS_PAYLOAD);
  });
  await assert.rejects(runescapeAdapter.getPlayerStats('x', 'main', { title: 'rs4' }), UnsupportedGameError);
  assert.equal(fetched, false);
});

test('invalid account type for the title → InvalidPlatformError (no fetch)', async () => {
  let fetched = false;
  stubFetch(() => {
    fetched = true;
    return jsonResponse(OSRS_PAYLOAD);
  });
  // RS3 has no ironman hiscores.
  await assert.rejects(
    runescapeAdapter.getPlayerStats('x', 'ironman', { title: 'rs3' }),
    InvalidPlatformError
  );
  assert.equal(fetched, false);
});

test('titles() and platformsFor() expose the supported set', () => {
  assert.deepEqual(runescapeAdapter.titles().sort(), ['osrs', 'rs3']);
  assert.deepEqual(runescapeAdapter.platformsFor('osrs'), ['main', 'ironman', 'hardcore', 'ultimate']);
  assert.deepEqual(runescapeAdapter.platformsFor('rs3'), ['main']);
  assert.deepEqual(runescapeAdapter.platformsFor('nope'), []);
});
