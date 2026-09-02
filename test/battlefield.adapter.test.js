// Unit tests for the Battlefield adapter's parsing and error handling.
// No network: globalThis.fetch is stubbed per test. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';

// config.js validates required env vars on import — provide dummies before loading.
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.GAMETOOLS_API_BASE ||= 'https://api.example.test';

const { battlefieldAdapter } = await import('../src/adapters/games/battlefield.js');
const {
  PlayerNotFoundError,
  RateLimitedError,
  UpstreamUnavailableError,
  UnsupportedGameError,
  InvalidPlatformError,
} = await import('../src/adapters/games/gameAdapter.js');

const realFetch = globalThis.fetch;

/** Install a fake fetch. `impl` receives the URL and returns a Response-like object (or throws). */
function stubFetch(impl) {
  globalThis.fetch = async (url) => impl(url.toString());
}
function jsonResponse(body, { status = 200, ok = status >= 200 && status < 300 } = {}) {
  return { ok, status, json: async () => body };
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const OK_PAYLOAD = {
  userName: 'ExamplePlayer',
  avatar: 'https://cdn.example.test/a.png',
  rankName: 'Colonel 100',
  killDeath: '1.85',
  winPercent: '54%',
  timePlayed: '12d 4h',
  killsPerMinute: '1.2',
  scorePerMinute: '850',
  kills: '48213',
  deaths: '26010',
  wins: '1204',
  loses: '1010',
  bestClass: 'Assault',
  accuracy: '18%',
  headshots: '9123',
};

test('happy path → normalized stats object', async () => {
  let calledUrl = '';
  stubFetch((url) => {
    calledUrl = url;
    return jsonResponse(OK_PAYLOAD);
  });

  const stats = await battlefieldAdapter.getPlayerStats('ExamplePlayer', 'pc', { title: 'bf4' });

  assert.equal(
    calledUrl,
    'https://api.example.test/bf4/stats/?name=ExamplePlayer&platform=pc&format_values=true'
  );
  assert.equal(stats.game, 'battlefield');
  assert.equal(stats.title, 'bf4');
  assert.equal(stats.titleLabel, 'Battlefield 4');
  assert.equal(stats.username, 'ExamplePlayer');
  assert.equal(stats.platform, 'pc');
  assert.equal(stats.kd, '1.85');
  assert.equal(stats.winRate, '54%');
  assert.equal(stats.timePlayed, '12d 4h');
  assert.equal(stats.losses, '1010');
  assert.equal(stats.rank, 'Colonel 100');
  assert.ok(stats.profileUrl.includes('ExamplePlayer'));
  assert.equal(typeof stats.fetchedAt, 'number');
});

test('HTTP 404 → PlayerNotFoundError', async () => {
  stubFetch(() => jsonResponse({}, { status: 404 }));
  await assert.rejects(
    battlefieldAdapter.getPlayerStats('ghost', 'pc', { title: 'bf1' }),
    PlayerNotFoundError
  );
});

test('HTTP 429 → RateLimitedError', async () => {
  stubFetch(() => jsonResponse({}, { status: 429 }));
  await assert.rejects(battlefieldAdapter.getPlayerStats('x', 'pc', { title: 'bf1' }), RateLimitedError);
});

test('HTTP 500 → UpstreamUnavailableError', async () => {
  stubFetch(() => jsonResponse({}, { status: 500 }));
  await assert.rejects(
    battlefieldAdapter.getPlayerStats('x', 'pc', { title: 'bf1' }),
    UpstreamUnavailableError
  );
});

test('fetch throwing (network/timeout) → UpstreamUnavailableError', async () => {
  stubFetch(() => {
    throw new Error('ECONNRESET');
  });
  await assert.rejects(
    battlefieldAdapter.getPlayerStats('x', 'pc', { title: 'bf1' }),
    UpstreamUnavailableError
  );
});

test('error envelope with "not found" → PlayerNotFoundError', async () => {
  stubFetch(() => jsonResponse({ errors: ['player not found'] }));
  await assert.rejects(battlefieldAdapter.getPlayerStats('x', 'pc', { title: 'bf1' }), PlayerNotFoundError);
});

test('empty/identity-less payload → PlayerNotFoundError', async () => {
  stubFetch(() => jsonResponse({ someUnrelatedField: true }));
  await assert.rejects(battlefieldAdapter.getPlayerStats('x', 'pc', { title: 'bf1' }), PlayerNotFoundError);
});

test('invalid platform for the title → InvalidPlatformError (no fetch)', async () => {
  let fetched = false;
  stubFetch(() => {
    fetched = true;
    return jsonResponse(OK_PAYLOAD);
  });
  // ps5 is not valid for BF4.
  await assert.rejects(battlefieldAdapter.getPlayerStats('x', 'ps5', { title: 'bf4' }), InvalidPlatformError);
  assert.equal(fetched, false);
});

test('unknown title → UnsupportedGameError (no fetch)', async () => {
  await assert.rejects(
    battlefieldAdapter.getPlayerStats('x', 'pc', { title: 'bf9000' }),
    UnsupportedGameError
  );
});

test('titles() and platformsFor() expose the config map', () => {
  assert.ok(battlefieldAdapter.titles().includes('bf4'));
  assert.deepEqual(battlefieldAdapter.platformsFor('bf3'), ['pc', 'ps3', 'xbox360']);
  assert.deepEqual(battlefieldAdapter.platformsFor('nope'), []);
});
