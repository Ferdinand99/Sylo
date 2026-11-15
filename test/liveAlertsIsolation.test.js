// One rejected Twitch login or Kick slug must not stop live alerts for every other server.
process.env.TWITCH_CLIENT_ID = 'tid';
process.env.TWITCH_CLIENT_SECRET = 'tsecret';
process.env.KICK_CLIENT_ID = 'kid';
process.env.KICK_CLIENT_SECRET = 'ksecret';
await import('./helpers/tmpDb.js');
const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { runtime } = await import('../src/runtime.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { createQuarantine, fetchIsolated, isRejectedStatus } =
  await import('../src/modules/lib/batchIsolation.js');
const twitch = await import('../src/modules/twitchAlerts.js');
const kick = await import('../src/modules/kickAlerts.js');

const CH_A = '100000000000000001';
const ATTACKER = '900000000000000501';
const VICTIM = '900000000000000502';

const rejected = (status) => Object.assign(new Error(`rejected ${status}`), { status });

test('isRejectedStatus: 4xx except 401/429 only', () => {
  assert.equal(isRejectedStatus(400), true);
  assert.equal(isRejectedStatus(404), true);
  assert.equal(isRejectedStatus(401), false);
  assert.equal(isRejectedStatus(429), false);
  assert.equal(isRejectedStatus(500), false);
  assert.equal(isRejectedStatus(undefined), false);
});

test('fetchIsolated: bisects to the rejected item and keeps the rest', async () => {
  const quarantine = createQuarantine();
  const calls = [];
  const items = Array.from({ length: 8 }, (_, i) => `item${i}`);
  const got = await fetchIsolated(
    items,
    8,
    async (batch) => {
      calls.push(batch.length);
      if (batch.includes('item5')) throw rejected(400);
      return batch;
    },
    { quarantine }
  );
  assert.deepEqual(got.sort(), items.filter((i) => i !== 'item5').sort());
  assert.equal(quarantine.has('item5'), true);
  assert.equal(quarantine.has('item4'), false);
  assert.ok(calls.length <= 1 + 2 * 3 + 1, `bounded request count, got ${calls.length}`);
});

test('fetchIsolated: a non-4xx failure still fails the whole poll', async () => {
  const quarantine = createQuarantine();
  await assert.rejects(
    fetchIsolated(['a', 'b'], 2, async () => Promise.reject(rejected(503)), { quarantine }),
    /rejected 503/
  );
  assert.equal(quarantine.size, 0);
  await assert.rejects(
    fetchIsolated(['a', 'b'], 2, async () => Promise.reject(rejected(429)), { quarantine }),
    /rejected 429/
  );
  assert.equal(quarantine.size, 0);
});

test('fetchIsolated: when everything is rejected the request is at fault, nothing is quarantined', async () => {
  const quarantine = createQuarantine();
  const items = Array.from({ length: 40 }, (_, i) => `item${i}`);
  let calls = 0;
  await assert.rejects(
    fetchIsolated(
      items,
      40,
      async () => {
        calls++;
        throw rejected(403);
      },
      { quarantine }
    ),
    /rejected 403/
  );
  assert.equal(quarantine.size, 0);
  assert.ok(calls < 40, `gave up early, made ${calls} calls`);
});

test('quarantine: backoff doubles, expires, and clears', () => {
  let now = 1_000;
  const q = createQuarantine({ baseMs: 100, maxMs: 350, now: () => now });
  assert.equal(q.add('x'), 100);
  assert.equal(q.has('x'), true);
  now += 101;
  assert.equal(q.has('x'), false);
  assert.equal(q.add('x'), 200);
  assert.equal(q.add('x'), 350); // capped
  q.clear('x');
  assert.equal(q.has('x'), false);
  assert.equal(q.add('x'), 100);
});

// --- tick-level: the victim still gets an alert while a poisoned record is stored ------------

function fakeGuild(id, sent) {
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      sent.push({ guild: id, payload });
      return { id: `msg-${sent.length}` };
    },
  };
  return {
    id,
    channels: { cache: new Map([[CH_A, channel]]), fetch: async () => channel },
    members: { me: {} },
  };
}

function installClient(sent) {
  const guilds = new Map([
    [ATTACKER, fakeGuild(ATTACKER, sent)],
    [VICTIM, fakeGuild(VICTIM, sent)],
  ]);
  runtime.client = { isReady: () => true, guilds: { cache: guilds } };
  for (const g of guilds.values()) g.client = runtime.client;
}

test('twitch tick: a rejected login does not stop alerts for another server', async () => {
  const sent = [];
  installClient(sent);
  await setGuildModule(ATTACKER, 'twitch-alerts', {
    enabled: true,
    config: { alerts: [{ login: '_poison', channelId: CH_A }] },
  });
  await setGuildModule(VICTIM, 'twitch-alerts', {
    enabled: true,
    config: { alerts: [{ login: 'victim1', channelId: CH_A }] },
  });

  const realFetch = globalThis.fetch;
  const streamUrls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'id.twitch.tv') return Response.json({ access_token: 't', expires_in: 3600 });
    const logins = u.searchParams.getAll(u.pathname.endsWith('/users') ? 'login' : 'user_login');
    if (logins.some((l) => l.startsWith('_'))) return new Response('{}', { status: 400 });
    if (u.pathname.endsWith('/streams')) {
      streamUrls.push(logins);
      return Response.json({
        data: logins
          .filter((l) => l === 'victim1')
          .map((l) => ({
            id: 's1',
            user_login: l,
            user_name: l,
            title: 'hi',
            game_name: 'g',
            viewer_count: 3,
            started_at: '2026-11-16T00:00:00Z',
            thumbnail_url: '',
          })),
      });
    }
    return Response.json({ data: [] });
  };
  try {
    await twitch.tick();
    assert.equal(sent.length, 1, 'victim announced on the first poll');
    assert.equal(sent[0].guild, VICTIM);
    assert.equal(twitch.rejectedLogins.has('_poison'), true);

    // Next poll: the poisoned login is skipped, no more requests for it.
    streamUrls.length = 0;
    await twitch.tick();
    assert.ok(streamUrls.every((b) => !b.includes('_poison')));
    assert.equal(sent.length, 1, 'no duplicate announcement');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('kick tick: a rejected slug does not stop alerts for another server', async () => {
  const sent = [];
  installClient(sent);
  await setGuildModule(ATTACKER, 'kick-alerts', {
    enabled: true,
    config: { alerts: [{ slug: '-poison', channelId: CH_A }] },
  });
  await setGuildModule(VICTIM, 'kick-alerts', {
    enabled: true,
    config: { alerts: [{ slug: 'victimk', channelId: CH_A }] },
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'id.kick.com') return Response.json({ access_token: 't', expires_in: 3600 });
    const slugs = u.searchParams.getAll('slug');
    if (slugs.some((s) => s.startsWith('-'))) return new Response('{}', { status: 400 });
    return Response.json({
      data: slugs
        .filter((s) => s === 'victimk')
        .map((slug) => ({
          slug,
          stream_title: 'hi',
          category: { name: 'g' },
          stream: {
            is_live: true,
            start_time: '2026-11-16T00:00:00Z',
            viewer_count: 2,
            url: 'https://kick.com/victimk',
          },
        })),
    });
  };
  try {
    await kick.tick();
    assert.equal(sent.length, 1, 'victim announced on the first poll');
    assert.equal(sent[0].guild, VICTIM);
    assert.equal(kick.rejectedSlugs.has('-poison'), true);
  } finally {
    globalThis.fetch = realFetch;
    runtime.client = null;
  }
});
