// A network blip in the Twitch or Kick poll must not reach the operator: it is retried once, and a
// run of failed polls is one warning, with the cause code in it.
process.env.TWITCH_CLIENT_ID = 'tid';
process.env.TWITCH_CLIENT_SECRET = 'tsecret';
process.env.KICK_CLIENT_ID = 'kid';
process.env.KICK_CLIENT_SECRET = 'ksecret';
await import('./helpers/tmpDb.js');
const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { runtime } = await import('../src/runtime.js');
const { log } = await import('../src/lib/log.js');
const { setGuildModule } = await import('../src/db/modules.js');
const pollErrors = await import('../src/modules/lib/pollErrors.js');
const {
  causeCode,
  describeError,
  isNetworkError,
  isTransient,
  httpError,
  withRetry,
  createPollHealth,
  tokenError,
  pollRetry,
} = pollErrors;
const { startSchedules, stopSchedules } = await import('../src/modules/schedule.js');
const { createQuarantine, fetchIsolated } = await import('../src/modules/lib/batchIsolation.js');
const twitch = await import('../src/modules/twitchAlerts.js');
const kick = await import('../src/modules/kickAlerts.js');

const CH_A = '100000000000000001';
const GUILD = '900000000000000601';

/** What undici throws for a dropped connection: the reason is in `cause`. */
const fetchFailed = (code = 'ECONNRESET') =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(`read ${code}`), { code }) });
const fakeResponse = (status, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers(headers),
});

function recordSleep(t) {
  const waits = [];
  t.mock.method(pollRetry, 'sleep', async (ms) => void waits.push(ms));
  return waits;
}

// --- helper ---------------------------------------------------------------------------------

test('describeError: puts the cause code of "fetch failed" in the text', () => {
  assert.equal(describeError(fetchFailed('ECONNRESET')), 'fetch failed (ECONNRESET)');
  assert.equal(
    describeError(fetchFailed('UND_ERR_CONNECT_TIMEOUT')),
    'fetch failed (UND_ERR_CONNECT_TIMEOUT)'
  );
  assert.equal(describeError(fetchFailed('ENOTFOUND')), 'fetch failed (ENOTFOUND)');
  // dual-stack connect failures hide the code one level further down, in an AggregateError
  const aggregate = new TypeError('fetch failed', {
    cause: new AggregateError([Object.assign(new Error('x'), { code: 'ETIMEDOUT' })]),
  });
  assert.equal(describeError(aggregate), 'fetch failed (ETIMEDOUT)');
  assert.equal(causeCode(new Error('plain')), null);
});

test('describeError: a timeout names itself, and no URL or credential gets into the text', () => {
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.match(describeError(timeout), /\(TimeoutError\)$/);
  const text = describeError(new Error('request to https://user:hunter2@api.example.com/x?token=abc failed'));
  assert.doesNotMatch(text, /hunter2|token=abc|https:/);
  assert.equal(describeError(httpError('Twitch /streams', fakeResponse(503))), 'Twitch /streams 503');
});

test('isTransient: network errors, 5xx and 429 only', () => {
  assert.equal(isNetworkError(fetchFailed()), true);
  assert.equal(isNetworkError(new DOMException('x', 'TimeoutError')), true);
  assert.equal(isNetworkError(new TypeError("Cannot read properties of undefined (reading 'data')")), false);
  assert.equal(isNetworkError(new SyntaxError('Unexpected token < in JSON')), false);
  for (const status of [500, 502, 503, 504, 429]) {
    assert.equal(isTransient(httpError('x', fakeResponse(status))), true, String(status));
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isTransient(httpError('x', fakeResponse(status))), false, String(status));
  }
});

test('httpError: reads Retry-After for 429 (seconds or a date) and ignores it elsewhere', () => {
  assert.equal(httpError('x', fakeResponse(429, { 'retry-after': '2' })).retryAfterMs, 2000);
  const at = new Date(Date.now() + 5000).toUTCString();
  const wait = httpError('x', fakeResponse(429, { 'retry-after': at })).retryAfterMs;
  assert.ok(wait > 2000 && wait <= 5000, String(wait));
  assert.equal(httpError('x', fakeResponse(429)).retryAfterMs, undefined);
  assert.equal(httpError('x', fakeResponse(400, { 'retry-after': '2' })).retryAfterMs, undefined);
});

test('withRetry: repeats once for a transient error, after the configured delay', async (t) => {
  const waits = recordSleep(t);
  let calls = 0;
  const out = await withRetry(async () => {
    calls += 1;
    if (calls === 1) throw fetchFailed();
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [pollRetry.delayMs]);
});

test('withRetry: a second failure is thrown, not retried again', async (t) => {
  recordSleep(t);
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw httpError('x', fakeResponse(503));
    }),
    /x 503/
  );
  assert.equal(calls, 2);
});

test('withRetry: 429 waits for Retry-After; a wait that is too long is not waited for', async (t) => {
  const waits = recordSleep(t);
  let calls = 0;
  await withRetry(async () => {
    calls += 1;
    if (calls === 1) throw httpError('x', fakeResponse(429, { 'retry-after': '4' }));
  });
  assert.deepEqual(waits, [4000]);

  waits.length = 0;
  calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw httpError('x', fakeResponse(429, { 'retry-after': '3600' }));
    }),
    /x 429/
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('withRetry: 4xx answers and programming errors are not retried', async (t) => {
  const waits = recordSleep(t);
  for (const err of [
    httpError('x', fakeResponse(400)),
    httpError('x', fakeResponse(401)),
    httpError('x', fakeResponse(403)),
    new TypeError("Cannot read properties of undefined (reading 'data')"),
  ]) {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls += 1;
        throw err;
      }),
      (e) => e === err
    );
    assert.equal(calls, 1);
  }
  assert.deepEqual(waits, []);
});

test('createPollHealth: warns once after 3 failures in a row, once when it works again', (t) => {
  const warn = t.mock.method(log, 'warn', () => {});
  const error = t.mock.method(log, 'error', () => {});
  const health = createPollHealth('x-alerts');
  health.failed(fetchFailed());
  health.failed(fetchFailed());
  assert.equal(warn.mock.callCount(), 0);
  health.failed(fetchFailed('ETIMEDOUT'));
  assert.equal(warn.mock.callCount(), 1);
  health.failed(fetchFailed());
  health.failed(fetchFailed());
  assert.equal(warn.mock.callCount(), 1, 'silent while it keeps failing');
  health.ok();
  assert.equal(warn.mock.callCount(), 2);
  assert.match(warn.mock.calls[1].arguments[1], /works again after 5 failed polls/);
  health.ok();
  assert.equal(warn.mock.callCount(), 2, 'a working poll is not logged again');
  assert.equal(error.mock.callCount(), 0);
});

test('createPollHealth: a run of failures that ends before the third says nothing', (t) => {
  const warn = t.mock.method(log, 'warn', () => {});
  const health = createPollHealth('x-alerts');
  health.failed(fetchFailed());
  health.failed(fetchFailed());
  health.ok();
  health.failed(fetchFailed());
  health.failed(fetchFailed());
  assert.equal(warn.mock.callCount(), 0);
});

test('isNetworkError: only the connection and timeout codes of undici count', () => {
  const coded = (code) => new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code }) });
  for (const code of [
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ]) {
    assert.equal(isNetworkError(coded(code)), true, code);
  }
  for (const code of ['UND_ERR_INVALID_ARG', 'UND_ERR_NOT_SUPPORTED', 'UND_ERR_INVALID_RETURN_VALUE']) {
    const err = Object.assign(new Error('bad call'), { code });
    assert.equal(isNetworkError(err), false, code);
    assert.equal(isTransient(err), false, code);
  }
});

test('isNetworkError: a fetch failure with a cause is classified by the cause code', () => {
  const wrapped = (code) => new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code }) });
  for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ENOTFOUND']) {
    assert.equal(isNetworkError(wrapped(code)), true, code);
    assert.equal(isTransient(wrapped(code)), true, code);
  }
  for (const code of ['UND_ERR_INVALID_ARG', 'UND_ERR_NOT_SUPPORTED', 'UND_ERR_INVALID_RETURN_VALUE']) {
    assert.equal(isNetworkError(wrapped(code)), false, code);
    assert.equal(isTransient(wrapped(code)), false, code);
  }
  // the wrapper alone, or with a cause that has no code, still counts as a network failure
  assert.equal(isNetworkError(new TypeError('fetch failed')), true);
  assert.equal(isNetworkError(new TypeError('fetch failed', { cause: new Error('no code') })), true);
  assert.equal(isNetworkError(new TypeError('Cannot read properties of undefined')), false);
});

test('httpError: Ratelimit-Reset is only the wait for a 429, never for a 503', () => {
  const reset = String(Math.floor(Date.now() / 1000) + 8);
  const wait = httpError('x', fakeResponse(429, { 'ratelimit-reset': reset })).retryAfterMs;
  assert.ok(wait > 4000 && wait <= 8000, String(wait));
  assert.equal(httpError('x', fakeResponse(503, { 'ratelimit-reset': reset })).retryAfterMs, undefined);
  assert.equal(httpError('x', fakeResponse(503, { 'retry-after': '2' })).retryAfterMs, 2000);
  const past = new Date(Date.now() - 60_000).toUTCString();
  assert.equal(httpError('x', fakeResponse(503, { 'retry-after': past })).retryAfterMs, 0);
});

test('tokenError: a refused token never carries a status that batch isolation reads as a value fault', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const err = tokenError('Twitch token', fakeResponse(status));
    assert.equal(err.status, undefined, String(status));
    assert.equal(err.httpStatus, status);
    assert.equal(err.message, `Twitch token ${status}`);
    assert.equal(isTransient(err), false);
  }
  for (const status of [429, 500, 503]) {
    const err = tokenError('Twitch token', fakeResponse(status));
    assert.equal(err.status, status);
    assert.equal(isTransient(err), true);
  }
});

test('withRetry: an error marked retryNow is retried at once, but only once', async (t) => {
  const waits = recordSleep(t);
  let calls = 0;
  await withRetry(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(httpError('x', fakeResponse(401)), { retryNow: true });
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [0]);
  calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw Object.assign(httpError('x', fakeResponse(401)), { retryNow: true });
    }),
    /x 401/
  );
  assert.equal(calls, 2);
});

test('createPollHealth: an error that is not transient is logged once, again when it changes, then hourly', (t) => {
  const warn = t.mock.method(log, 'warn', () => {});
  const error = t.mock.method(log, 'error', () => {});
  let now = 1_000_000;
  const health = createPollHealth('x-alerts', { now: () => now });
  const denied = () => httpError('Twitch /streams', fakeResponse(403));
  const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
  health.failed(bug);
  assert.equal(error.mock.callCount(), 1);
  assert.equal(error.mock.calls[0].arguments[2], bug, 'the Error itself, so its stack is logged');
  for (let i = 0; i < 100; i += 1) {
    now += 60_000;
    health.failed(bug);
  }
  assert.equal(error.mock.callCount(), 2, 'silent for the first hour, then one reminder');
  assert.match(error.mock.calls[1].arguments[1], /still failing after \d+ polls: Cannot read properties/);
  health.failed(denied()); // a different message: logged at once
  assert.equal(error.mock.callCount(), 3);
  now += 61 * 60_000;
  health.failed(denied());
  health.failed(denied());
  assert.equal(error.mock.callCount(), 4);
  assert.match(error.mock.calls[3].arguments[1], /still failing after 2 polls: Twitch \/streams 403/);
  assert.equal(health.failures, 0, 'not a network failure');
  health.ok();
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[1], /works again after 104 failed polls/);
  health.ok();
  assert.equal(warn.mock.callCount(), 1);
});

test('createPollHealth: alternating errors, or a message with a changing number, are not logged on every poll', (t) => {
  const error = t.mock.method(log, 'error', () => {});
  let now = 9_000_000;
  const health = createPollHealth('x-alerts', { now: () => now });
  const a = () => httpError('Twitch /streams', fakeResponse(403));
  const b = () => httpError('Twitch token', fakeResponse(401));
  for (let i = 0; i < 20; i += 1) {
    health.failed(a());
    health.failed(b());
    now += 60_000;
  }
  assert.equal(error.mock.callCount(), 2, 'one line for each of the two kinds');
  for (let i = 0; i < 30; i += 1) {
    health.failed(new RangeError(`index ${i} is out of range 0..${100 + i}`));
    now += 60_000;
  }
  assert.equal(error.mock.callCount(), 3, 'the number in the message does not make a new kind');
  // a different status is a different kind
  health.failed(httpError('Twitch /streams', fakeResponse(404)));
  assert.equal(error.mock.callCount(), 4);
});

test('createPollHealth: a long network outage gets a reminder every hour', (t) => {
  const warn = t.mock.method(log, 'warn', () => {});
  let now = 5_000_000;
  const health = createPollHealth('x-alerts', { now: () => now });
  for (let i = 0; i < 130; i += 1) {
    health.failed(fetchFailed('ENOTFOUND'));
    now += 60_000;
  }
  // 130 minutes: the warning at the 3rd failure, then one reminder per hour
  assert.equal(warn.mock.callCount(), 3);
  assert.match(warn.mock.calls[0].arguments[1], /3 times in a row/);
  assert.match(
    warn.mock.calls[1].arguments[1],
    /still failing after \d+ polls \(fetch failed \(ENOTFOUND\)\)/
  );
  assert.match(warn.mock.calls[2].arguments[1], /still failing after \d+ polls/);
});

// --- ticks ----------------------------------------------------------------------------------

function installClient(sent) {
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      sent.push(payload);
      return { id: `msg-${sent.length}` };
    },
  };
  const guild = {
    id: GUILD,
    channels: { cache: new Map([[CH_A, channel]]), fetch: async () => channel },
    members: { me: {} },
  };
  runtime.client = { isReady: () => true, guilds: { cache: new Map([[GUILD, guild]]) } };
  guild.client = runtime.client;
}

const tokenOk = () => Response.json({ access_token: 't', expires_in: 3600 });

/**
 * Run `body` with a fake global fetch. `answer(url, n)` gets the URL and how many requests the
 * platform's data endpoints have seen and returns a Response or throws. `token(n)` answers the n-th
 * request of the token endpoint (default: it works).
 */
async function withFakeFetch(dataHost, answer, body, { token } = {}) {
  const realFetch = globalThis.fetch;
  const seen = { data: 0, token: 0 };
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.includes('token')) {
      seen.token += 1;
      return token ? token(seen.token) : tokenOk();
    }
    assert.equal(u.hostname, dataHost);
    seen.data += 1;
    return answer(u, seen.data);
  };
  try {
    await body(seen);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const PLATFORMS = [
  {
    name: 'twitch',
    mod: twitch,
    scope: 'twitch-alerts',
    host: 'api.twitch.tv',
    save: (value) =>
      setGuildModule(GUILD, 'twitch-alerts', {
        enabled: true,
        config: { alerts: [{ login: value, channelId: CH_A }] },
      }),
    liveAnswer: (u, login) =>
      Response.json({
        data: u.pathname.endsWith('/users')
          ? []
          : [
              {
                id: `s-${login}`,
                user_login: login,
                user_name: login,
                title: 'hi',
                game_name: 'g',
                viewer_count: 3,
                started_at: '2026-11-16T00:00:00Z',
                thumbnail_url: '',
              },
            ],
      }),
  },
  {
    name: 'kick',
    mod: kick,
    scope: 'kick-alerts',
    host: 'api.kick.com',
    save: (value) =>
      setGuildModule(GUILD, 'kick-alerts', {
        enabled: true,
        config: { alerts: [{ slug: value, channelId: CH_A }] },
      }),
    liveAnswer: (u, slug) =>
      Response.json({
        data: [
          {
            slug,
            stream_title: 'hi',
            category: { name: 'g' },
            stream: {
              is_live: true,
              start_time: '2026-11-16T00:00:00Z',
              viewer_count: 2,
              url: `https://kick.com/${slug}`,
            },
          },
        ],
      }),
  },
];

for (const p of PLATFORMS) {
  const prep = async (t, value) => {
    const sent = [];
    installClient(sent);
    p.mod.pollHealth.reset();
    p.mod._resetToken();
    const waits = recordSleep(t);
    const warn = t.mock.method(log, 'warn', () => {});
    const error = t.mock.method(log, 'error', () => {});
    await p.save(value);
    return { sent, waits, warn, error };
  };

  test(`${p.name} tick: one network blip is retried silently and the stream is announced`, async (t) => {
    const { sent, waits, warn, error } = await prep(t, 'blipone');
    await withFakeFetch(
      p.host,
      (u, n) => (n === 1 ? Promise.reject(fetchFailed('ECONNRESET')) : p.liveAnswer(u, 'blipone')),
      async (seen) => {
        await p.mod.tick();
        assert.ok(seen.data >= 2, 'the request was repeated');
      }
    );
    assert.equal(sent.length, 1, 'announced as usual');
    assert.deepEqual(waits, [pollRetry.delayMs]);
    assert.equal(warn.mock.callCount(), 0);
    assert.equal(error.mock.callCount(), 0);
    assert.equal(p.mod.pollHealth.failures, 0);
  });

  test(`${p.name} tick: a 503 is retried once too`, async (t) => {
    const { sent, warn, error } = await prep(t, 'fivehundred');
    await withFakeFetch(
      p.host,
      (u, n) => (n === 1 ? new Response('{}', { status: 503 }) : p.liveAnswer(u, 'fivehundred')),
      async () => {
        await p.mod.tick();
      }
    );
    assert.equal(sent.length, 1);
    assert.equal(warn.mock.callCount() + error.mock.callCount(), 0);
  });

  test(`${p.name} tick: 429 waits for Retry-After before the retry`, async (t) => {
    const { sent, waits } = await prep(t, 'slowdown');
    await withFakeFetch(
      p.host,
      (u, n) =>
        n === 1
          ? new Response('{}', { status: 429, headers: { 'Retry-After': '3' } })
          : p.liveAnswer(u, 'slowdown'),
      async () => {
        await p.mod.tick();
      }
    );
    assert.deepEqual(waits, [3000]);
    assert.equal(sent.length, 1);
  });

  test(`${p.name} tick: 3 failed polls in a row are one warning with the cause code, recovery is one more line`, async (t) => {
    const { sent, warn, error } = await prep(t, 'flaky');
    let down = true;
    await withFakeFetch(
      p.host,
      (u) => (down ? Promise.reject(fetchFailed('ECONNRESET')) : p.liveAnswer(u, 'flaky')),
      async (seen) => {
        await p.mod.tick();
        await p.mod.tick();
        assert.equal(seen.data, 4, 'each failed poll tried twice');
        assert.equal(warn.mock.callCount(), 0, 'one or two failed polls are not logged');
        await p.mod.tick();
        assert.equal(warn.mock.callCount(), 1);
        const [scope, line] = warn.mock.calls[0].arguments;
        assert.equal(scope, p.scope);
        assert.match(line, /3 times in a row/);
        assert.match(line, /fetch failed \(ECONNRESET\)/);
        assert.doesNotMatch(line, /https?:|tsecret|ksecret|Bearer/);
        await p.mod.tick();
        await p.mod.tick();
        assert.equal(warn.mock.callCount(), 1, 'no repeat while it stays down');
        assert.equal(sent.length, 0);

        down = false;
        await p.mod.tick();
      }
    );
    assert.equal(warn.mock.callCount(), 2);
    assert.match(warn.mock.calls[1].arguments[1], /works again after 5 failed polls/);
    assert.equal(sent.length, 1, 'the recovered poll announces as usual');
    assert.equal(error.mock.callCount(), 0);
  });

  test(`${p.name} tick: a programming error is still an error, and is not retried`, async (t) => {
    const { waits, warn, error } = await prep(t, 'buggy');
    await withFakeFetch(
      p.host,
      () => Promise.reject(new TypeError("Cannot read properties of undefined (reading 'x')")),
      async (seen) => {
        await p.mod.tick();
        assert.equal(seen.data, 1, 'not retried');
      }
    );
    assert.equal(error.mock.callCount(), 1);
    assert.equal(error.mock.calls[0].arguments[0], p.scope);
    assert.match(error.mock.calls[0].arguments[2].message, /Cannot read properties/);
    assert.ok(error.mock.calls[0].arguments[2].stack, 'the Error itself is logged, with its stack');
    assert.equal(warn.mock.callCount(), 0);
    assert.deepEqual(waits, []);
    assert.equal(p.mod.pollHealth.failures, 0, 'does not count as a network failure');
  });

  test(`${p.name} tick: a 4xx answer is not retried and still logged as an error`, async (t) => {
    const { waits, warn, error } = await prep(t, 'denied');
    await withFakeFetch(
      p.host,
      () => new Response('{}', { status: 403 }),
      async (seen) => {
        await p.mod.tick();
        assert.equal(seen.data, 1);
      }
    );
    assert.equal(error.mock.callCount(), 1);
    assert.match(error.mock.calls[0].arguments[2].message, /403/);
    assert.equal(warn.mock.callCount(), 0);
    assert.deepEqual(waits, []);
  });

  const tokenBlips = [
    ['a 503', () => new Response('{}', { status: 503 })],
    ['a network blip', () => Promise.reject(fetchFailed('ECONNRESET'))],
  ];
  for (const [i, [what, first]] of tokenBlips.entries()) {
    test(`${p.name} tick: the token endpoint answering with ${what} is retried silently`, async (t) => {
      const { sent, waits, warn, error } = await prep(t, `tokenblip${i}`);
      await withFakeFetch(
        p.host,
        (u) => p.liveAnswer(u, `tokenblip${i}`),
        async (seen) => {
          await p.mod.tick();
          assert.equal(seen.token, 2, 'the token request was repeated');
        },
        { token: (n) => (n === 1 ? first() : tokenOk()) }
      );
      assert.equal(sent.length, 1);
      assert.deepEqual(waits, [pollRetry.delayMs]);
      assert.equal(warn.mock.callCount() + error.mock.callCount(), 0);
    });
  }

  test(`${p.name} tick: a token endpoint that refuses with 400 is one error, with no search and no data request`, async (t) => {
    const { sent, waits, warn, error } = await prep(t, 'badclient');
    await withFakeFetch(
      p.host,
      (u) => p.liveAnswer(u, 'badclient'),
      async (seen) => {
        await p.mod.tick();
        assert.equal(seen.token, 1, 'one token request, not one per isolated batch');
        assert.equal(seen.data, 0);
      },
      { token: () => new Response('{"error":"invalid client"}', { status: 400 }) }
    );
    assert.equal(sent.length, 0);
    assert.equal(error.mock.callCount(), 1);
    assert.match(error.mock.calls[0].arguments[2].message, /token 400/);
    assert.equal(warn.mock.callCount(), 0, 'no "every request was refused" warning');
    assert.deepEqual(waits, []);
    assert.equal(p.mod.pollHealth.failures, 0);
  });

  const retryAfters = [
    ['seconds', '2', 2000],
    ['a date that has passed', new Date(Date.now() - 60_000).toUTCString(), 0],
  ];
  for (const [i, [what, header, expected]] of retryAfters.entries()) {
    test(`${p.name} tick: a 503 honours Retry-After given as ${what}`, async (t) => {
      const { sent, waits, warn, error } = await prep(t, `retryafter${i}`);
      await withFakeFetch(
        p.host,
        (u, n) =>
          n === 1
            ? new Response('{}', { status: 503, headers: { 'Retry-After': header } })
            : p.liveAnswer(u, `retryafter${i}`),
        async () => {
          await p.mod.tick();
        }
      );
      assert.deepEqual(waits, [expected]);
      assert.equal(sent.length, 1);
      assert.equal(warn.mock.callCount() + error.mock.callCount(), 0);
    });
  }

  test(`${p.name} tick: a request timeout is retried silently`, async (t) => {
    const { sent, warn, error } = await prep(t, 'timedout');
    await withFakeFetch(
      p.host,
      (u, n) =>
        n === 1
          ? Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
          : p.liveAnswer(u, 'timedout'),
      async () => {
        await p.mod.tick();
      }
    );
    assert.equal(sent.length, 1);
    assert.equal(warn.mock.callCount() + error.mock.callCount(), 0);
  });

  test(`${p.name} tick: a rejected token (401) is refreshed and the request retried at once, silently`, async (t) => {
    const { sent, waits, warn, error } = await prep(t, 'rotated');
    await withFakeFetch(
      p.host,
      (u, n) => (n === 1 ? new Response('{}', { status: 401 }) : p.liveAnswer(u, 'rotated')),
      async (seen) => {
        await p.mod.tick();
        assert.equal(seen.token, 2, 'a fresh token for the retry');
      }
    );
    assert.deepEqual(waits, [0]);
    assert.equal(sent.length, 1);
    assert.equal(warn.mock.callCount() + error.mock.callCount(), 0);
  });

  test(`${p.name} tick: a 401 that stays is an error`, async (t) => {
    const { sent, error } = await prep(t, 'norights');
    await withFakeFetch(
      p.host,
      () => new Response('{}', { status: 401 }),
      async (seen) => {
        await p.mod.tick();
        assert.equal(seen.data, 2, 'tried once more, not more');
      }
    );
    assert.equal(sent.length, 0);
    assert.equal(error.mock.callCount(), 1);
  });

  test(`${p.name} tick: bad credentials are one error line for many polls, then one recovery line`, async (t) => {
    const { sent, warn, error } = await prep(t, 'badsecret');
    let denied = true;
    await withFakeFetch(
      p.host,
      (u) => (denied ? new Response('{}', { status: 403 }) : p.liveAnswer(u, 'badsecret')),
      async () => {
        for (let i = 0; i < 5; i += 1) await p.mod.tick();
        assert.equal(error.mock.callCount(), 1, 'logged once, not on every poll');
        denied = false;
        await p.mod.tick();
      }
    );
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[1], /works again after 5 failed polls/);
    assert.equal(sent.length, 1);
  });
}

test('the poll callbacks hand their tick to the scheduler: a tick that is still running is not started twice', async (t) => {
  const sent = [];
  installClient(sent);
  recordSleep(t);
  t.mock.method(log, 'warn', () => {});
  t.mock.method(log, 'error', () => {});
  for (const p of PLATFORMS) {
    p.mod.pollHealth.reset();
    p.mod._resetToken();
    await p.save('slowtick');
  }
  const hits = {};
  const release = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const u = new URL(String(url));
    if (u.pathname.includes('token')) return Promise.resolve(tokenOk());
    hits[u.hostname] = (hits[u.hostname] ?? 0) + 1;
    const p = PLATFORMS.find((x) => x.host === u.hostname);
    return new Promise((resolve) => release.push(() => resolve(p.liveAnswer(u, 'slowtick'))));
  };
  const flush = async () => {
    for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    startSchedules();
    t.mock.timers.tick(30_000); // the first ticks (Twitch 25 s, Kick 30 s), now waiting on the network
    await flush();
    t.mock.timers.tick(60_000); // the next interval comes while they are still waiting
    await flush();
    assert.deepEqual(hits, { 'api.twitch.tv': 1, 'api.kick.com': 1 }, 'no second tick on top of the first');
    for (let i = 0; i < 10 && release.length > 0; i += 1) {
      for (const go of release.splice(0)) go();
      await flush();
    }
    await stopSchedules();
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- composition with the batch isolation of rejected values ---------------------------------

for (const p of PLATFORMS) {
  // a different rejected value per test: a quarantined one is left out of the next poll
  const poisonFor = (n) => (p.name === 'twitch' ? '_poison' : '-poison') + n;
  const names = (u) =>
    p.name === 'twitch'
      ? u.searchParams.getAll(u.pathname.endsWith('/users') ? 'login' : 'user_login')
      : u.searchParams.getAll('slug');
  const saveTwo = (value, poison) =>
    p.name === 'twitch'
      ? setGuildModule(GUILD, 'twitch-alerts', {
          enabled: true,
          config: {
            alerts: [
              { login: poison, channelId: CH_A },
              { login: value, channelId: CH_A },
            ],
          },
        })
      : setGuildModule(GUILD, 'kick-alerts', {
          enabled: true,
          config: {
            alerts: [
              { slug: poison, channelId: CH_A },
              { slug: value, channelId: CH_A },
            ],
          },
        });

  test(`${p.name} tick: a blip and a rejected value in the same poll: retried, isolated, victim announced`, async (t) => {
    const sent = [];
    installClient(sent);
    const poison = poisonFor('a');
    p.mod.pollHealth.reset();
    p.mod._resetToken();
    recordSleep(t);
    const warn = t.mock.method(log, 'warn', () => {});
    const error = t.mock.method(log, 'error', () => {});
    await saveTwo('victimblip', poison);
    await withFakeFetch(
      p.host,
      (u, n) => {
        if (n === 1) return Promise.reject(fetchFailed('ECONNRESET'));
        if (names(u).includes(poison)) return new Response('{}', { status: 400 });
        return p.liveAnswer(u, 'victimblip');
      },
      async () => {
        await p.mod.tick();
      }
    );
    assert.equal(sent.length, 1, 'the victim is announced');
    assert.equal(error.mock.callCount(), 0);
    assert.equal(warn.mock.callCount(), 1, 'only the warning about the rejected value');
    assert.match(warn.mock.calls[0].arguments[1], /rejected 1 of the/);
    assert.equal(p.mod.pollHealth.failures, 0);
  });

  test(`${p.name} tick: a network error while values are being isolated fails the poll as a network failure, nothing is quarantined`, async (t) => {
    const sent = [];
    installClient(sent);
    const poison = poisonFor('b');
    p.mod.pollHealth.reset();
    p.mod._resetToken();
    recordSleep(t);
    const warn = t.mock.method(log, 'warn', () => {});
    const error = t.mock.method(log, 'error', () => {});
    await saveTwo('victimdown', poison);
    const quarantine = p.name === 'twitch' ? p.mod.rejectedLogins : p.mod.rejectedSlugs;
    const before = quarantine.size;
    const asked = [];
    await withFakeFetch(
      p.host,
      (u) => {
        asked.push(names(u));
        // the value known to be good (the canary) is still answered, so the search starts
        if (names(u).length === 1 && names(u)[0] === quarantine.lastGood)
          return p.liveAnswer(u, quarantine.lastGood);
        if (names(u).length === 2) return new Response('{}', { status: 400 });
        if (names(u).includes(poison)) return new Response('{}', { status: 400 });
        return Promise.reject(fetchFailed('UND_ERR_CONNECT_TIMEOUT'));
      },
      async () => {
        await p.mod.tick();
      }
    );
    assert.deepEqual(asked[0].sort(), [poison, 'victimdown'].sort(), 'both values were asked together first');
    assert.ok(
      asked.some((names) => names.length === 1 && names[0] === poison),
      'the search got to the rejected value'
    );
    assert.ok(
      asked.some((names) => names.length === 1 && names[0] === 'victimdown'),
      'and was cut short by the network error'
    );
    assert.equal(sent.length, 0);
    assert.equal(error.mock.callCount(), 0);
    assert.equal(warn.mock.callCount(), 0, 'one failed poll is not logged');
    assert.equal(p.mod.pollHealth.failures, 1);
    assert.equal(quarantine.size, before, 'a network error is not a value fault');
  });
}

test('fetchIsolated: a network failure of the canary fails the poll as that failure and keeps the canary', async () => {
  const quarantine = createQuarantine();
  quarantine.setGood('known-good');
  const refused = (status) => Object.assign(new Error(`refused ${status}`), { status });
  await assert.rejects(
    fetchIsolated(
      ['a', 'b'],
      2,
      async (batch) => {
        if (batch[0] === 'known-good') throw fetchFailed('ECONNRESET');
        throw refused(400);
      },
      { quarantine }
    ),
    (err) => err.message === 'fetch failed',
    'not the 400 of the first batch'
  );
  assert.equal(quarantine.lastGood, 'known-good', 'the canary was not thrown away');
  assert.equal(quarantine.size, 0);
});

test('fetchIsolated: a network failure of the canary while the platform flaps quarantines nothing and remembers the value for the next poll', async () => {
  const quarantine = createQuarantine();
  quarantine.setGood('known-good');
  const out = await fetchIsolated(
    ['fine1', 'flaky'],
    1,
    async (batch) => {
      if (batch[0] === 'flaky') throw Object.assign(new Error('refused 404'), { status: 404 });
      if (batch[0] === 'known-good') throw fetchFailed('ETIMEDOUT');
      return batch;
    },
    { quarantine }
  );
  assert.deepEqual(out.results, ['fine1']);
  assert.equal(quarantine.size, 0, 'a value is not quarantined on the word of a failing request');
  assert.ok(out.unresolved.has('flaky'));
  assert.ok(quarantine.suspects.has('flaky'), 'it is batched apart from the clean values next time');
});

test('twitch tick: a failed user lookup is neither retried nor logged, the stream is still announced', async (t) => {
  const sent = [];
  installClient(sent);
  twitch.pollHealth.reset();
  const waits = recordSleep(t);
  const warn = t.mock.method(log, 'warn', () => {});
  const error = t.mock.method(log, 'error', () => {});
  await PLATFORMS[0].save('nousers');
  let userCalls = 0;
  await withFakeFetch(
    'api.twitch.tv',
    (u) => {
      if (u.pathname.endsWith('/users')) {
        userCalls += 1;
        return Promise.reject(fetchFailed('ECONNRESET'));
      }
      return PLATFORMS[0].liveAnswer(u, 'nousers');
    },
    async () => {
      await twitch.tick();
    }
  );
  assert.equal(sent.length, 1);
  assert.equal(userCalls, 1);
  assert.deepEqual(waits, []);
  assert.equal(warn.mock.callCount() + error.mock.callCount(), 0);
});

test.after(() => {
  runtime.client = null;
});
