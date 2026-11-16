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
  pollRetry,
} = pollErrors;
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

/**
 * Run `body` with a fake global fetch. `answer(url, n)` gets the URL and how many requests the
 * platform's data endpoints have seen (the token endpoint always works) and returns a Response or throws.
 */
async function withFakeFetch(dataHost, answer, body) {
  const realFetch = globalThis.fetch;
  const seen = { data: 0 };
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.includes('token')) return Response.json({ access_token: 't', expires_in: 3600 });
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
    assert.match(error.mock.calls[0].arguments[2], /Cannot read properties/);
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
    assert.match(error.mock.calls[0].arguments[2], /403/);
    assert.equal(warn.mock.callCount(), 0);
    assert.deepEqual(waits, []);
  });
}

test.after(() => {
  runtime.client = null;
});
