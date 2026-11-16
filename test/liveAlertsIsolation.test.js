// One rejected Twitch login or Kick slug must not stop live alerts for every other server.
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
const { createQuarantine, fetchIsolated, isRejectedStatus, rejectedWarning } =
  await import('../src/modules/lib/batchIsolation.js');
const twitch = await import('../src/modules/twitchAlerts.js');
const kick = await import('../src/modules/kickAlerts.js');

const CH_A = '100000000000000001';
const ATTACKER = '900000000000000501';
const VICTIM = '900000000000000502';

const rejected = (status) => Object.assign(new Error(`rejected ${status}`), { status });

test('isRejectedStatus: only 400, 404 and 422 can mean "this value"', () => {
  for (const status of [400, 404, 422]) assert.equal(isRejectedStatus(status), true, String(status));
  for (const status of [401, 403, 408, 409, 425, 429, 500, 503, undefined]) {
    assert.equal(isRejectedStatus(status), false, String(status));
  }
});

test('fetchIsolated: bisects to the rejected item and keeps the rest', async () => {
  const quarantine = createQuarantine();
  const calls = [];
  const items = Array.from({ length: 8 }, (_, i) => `item${i}`);
  const out = await fetchIsolated(
    items,
    8,
    async (batch) => {
      calls.push(batch.length);
      if (batch.includes('item5')) throw rejected(400);
      return batch;
    },
    { quarantine }
  );
  assert.deepEqual(out.results.sort(), items.filter((i) => i !== 'item5').sort());
  assert.deepEqual(
    out.rejected.map((r) => [r.item, r.strikes]),
    [['item5', 1]]
  );
  assert.deepEqual([...out.unresolved], ['item5']);
  assert.equal(quarantine.has('item5'), true);
  assert.equal(quarantine.has('item4'), false);
  assert.ok(calls.length <= 1 + 2 * 3 + 1, `bounded request count, got ${calls.length}`);
});

test('fetchIsolated: any number of rejected items is fine while the rest succeeds', async () => {
  const quarantine = createQuarantine();
  const items = [...Array.from({ length: 15 }, (_, i) => `_bad${i}`), 'victim'];
  const out = await fetchIsolated(
    items,
    100,
    async (batch) => {
      if (batch.some((i) => i.startsWith('_'))) throw rejected(400);
      return batch;
    },
    { quarantine }
  );
  assert.deepEqual(out.results, ['victim']);
  assert.equal(out.rejected.length, 15);
  assert.equal(quarantine.size, 15);
});

test('fetchIsolated: a failure that is not about a value still fails the whole poll', async () => {
  for (const status of [503, 429, 401, 403, 408, 425]) {
    const quarantine = createQuarantine();
    await assert.rejects(
      fetchIsolated(['a', 'b'], 2, async () => Promise.reject(rejected(status)), { quarantine }),
      new RegExp(`rejected ${status}`)
    );
    assert.equal(quarantine.size, 0, String(status));
  }
});

test('fetchIsolated: when nothing succeeds and a value known to be good is refused too, the request is at fault', async () => {
  for (const count of [3, 40]) {
    const quarantine = createQuarantine();
    quarantine.setGood('known-good'); // accepted in an earlier poll
    const items = Array.from({ length: count }, (_, i) => `item${i}`);
    await assert.rejects(
      fetchIsolated(items, 50, async () => Promise.reject(rejected(400)), { quarantine }),
      /rejected 400/
    );
    assert.equal(quarantine.size, 0, `${count} items`);
  }
});

test('fetchIsolated: nothing succeeds but the known-good value is accepted: the values are at fault', async () => {
  const quarantine = createQuarantine();
  quarantine.setGood('known-good');
  const out = await fetchIsolated(
    ['bad1', 'bad2'],
    50,
    async (batch) => {
      if (batch.every((i) => i === 'known-good')) return batch;
      throw rejected(400);
    },
    { quarantine }
  );
  assert.deepEqual(out.rejected.map((r) => r.item).sort(), ['bad1', 'bad2']);
  assert.equal(quarantine.size, 2);
  assert.equal(out.inconclusive, false);
});

test('fetchIsolated: nothing succeeds and nothing is known to be good: nothing is quarantined, and it says so', async () => {
  const quarantine = createQuarantine();
  const out = await fetchIsolated(['a', 'b', 'c'], 50, async () => Promise.reject(rejected(400)), {
    quarantine,
  });
  assert.equal(out.inconclusive, true);
  assert.equal(quarantine.size, 0);
  assert.deepEqual([...out.unresolved].sort(), ['a', 'b', 'c']);
});

test('fetchIsolated: when the platform flaps (some answer, some are refused) and the canary is refused, nothing is quarantined', async () => {
  const quarantine = createQuarantine();
  quarantine.setGood('known-good');
  const out = await fetchIsolated(
    ['fine1', 'flaky', 'fine2'],
    1,
    async (batch) => {
      if (batch[0] === 'flaky' || batch[0] === 'known-good') throw rejected(404);
      return batch;
    },
    { quarantine }
  );
  assert.deepEqual(out.results.sort(), ['fine1', 'fine2']);
  assert.equal(quarantine.size, 0, 'a value the platform refuses only while it flaps is not quarantined');
  assert.ok(out.unresolved.has('flaky'), 'its state is left alone this poll');
  assert.equal(quarantine.lastGood, 'fine2', 'a fresh good value for the next canary');
});

test('fetchIsolated: poison values filling the first batch cannot fail the poll or leave later batches out', async () => {
  const quarantine = createQuarantine();
  const poison = Array.from({ length: 100 }, (_, i) => `_bad${i}`);
  const victims = Array.from({ length: 30 }, (_, i) => `victim${i}`);
  const ask = async (batch) => {
    if (batch.some((i) => i.startsWith('_'))) throw rejected(400);
    return batch;
  };
  // Bisecting 100 poison values takes about 199 requests; the budget is 120.
  const first = await fetchIsolated([...poison, ...victims], 100, ask, { quarantine });
  assert.deepEqual([...first.results].sort(), [...victims].sort(), 'the later batch was fetched');
  assert.ok(first.rejected.length > 0 && first.rejected.length < 100, 'some found, the budget ended');
  // Later polls finish the job, with what was found left out.
  let polls = 1;
  while (polls < 6 && poison.some((p) => !quarantine.has(p))) {
    const next = await fetchIsolated([...poison, ...victims], 100, ask, { quarantine });
    assert.ok(next.results.length > 0 || next.unresolved.size > 0);
    polls += 1;
  }
  assert.ok(
    poison.every((p) => quarantine.has(p)),
    `all quarantined within ${polls} polls`
  );
  assert.ok(polls <= 4, `bounded: ${polls} polls`);
  const last = await fetchIsolated([...poison, ...victims], 100, ask, { quarantine });
  assert.deepEqual(
    [...last.results].sort(),
    [...victims].sort(),
    'once the poison is quarantined, a clean poll'
  );
});

test('fetchIsolated: the start rotates, so the same values are not always last', async () => {
  const quarantine = createQuarantine();
  const items = Array.from({ length: 8 }, (_, i) => `i${i}`);
  const firsts = [];
  for (let n = 0; n < 4; n += 1) {
    await fetchIsolated(
      items,
      2,
      async (batch) => {
        if (n === firsts.length && !firsts[n]) firsts.push(batch[0]);
        return batch;
      },
      { quarantine }
    );
  }
  assert.equal(new Set(firsts).size, 4, 'each poll starts somewhere else');
});

test('fetchIsolated: a request budget leaves the rest of the poll out instead of failing it', async () => {
  const quarantine = createQuarantine();
  const items = [
    ...Array.from({ length: 8 }, (_, i) => `ok${i}`),
    ...Array.from({ length: 8 }, (_, i) => `_bad${i}`),
  ];
  let calls = 0;
  const out = await fetchIsolated(
    items,
    4,
    async (batch) => {
      calls++;
      if (batch.some((i) => i.startsWith('_'))) throw rejected(400);
      return batch;
    },
    { quarantine, extraRequests: 2 }
  );
  assert.equal(calls, 6);
  assert.ok(out.results.length > 0, 'what was fetched is kept');
  assert.ok(out.unresolved.size > 0, 'unreached items are reported as unresolved');
  for (const item of out.results) assert.ok(!out.unresolved.has(item));
});

test('fetchIsolated: a value quarantined earlier is not asked about, and comes back after its time', async () => {
  let now = 1_000;
  const quarantine = createQuarantine({ baseMs: 100, now: () => now });
  quarantine.add('old');
  const asked = [];
  const ask = async (batch) => {
    asked.push(...batch);
    return batch;
  };
  const first = await fetchIsolated(['old', 'new'], 10, ask, { quarantine });
  assert.deepEqual(asked, ['new']);
  assert.deepEqual([...first.unresolved], ['old']);
  now += 101;
  const second = await fetchIsolated(['old', 'new'], 10, ask, { quarantine });
  assert.deepEqual(second.results.sort(), ['new', 'old']);
  assert.equal(quarantine.strikes('old'), 0, 'accepted again: the strikes reset');
});

test('rejectedWarning: one line for the new values, nothing for a repeat', () => {
  const r = (item, strikes) => ({ item, waitMs: 600_000, strikes });
  const line = rejectedWarning('Twitch logins', [r('a', 1), r('b', 1), r('c', 2)], (i) => [`guild-${i}`]);
  assert.match(line, /rejected 2 of the Twitch logins/);
  assert.match(line, /"a" \(guild-a\)/);
  assert.doesNotMatch(line, /"c"/);
  assert.equal(
    rejectedWarning('Twitch logins', [r('c', 2)], () => []),
    null
  );
  const many = Array.from({ length: 30 }, (_, i) => r(`v${i}`, 1));
  assert.match(
    rejectedWarning('Kick slugs', many, () => ['g']),
    /and 20 more/
  );
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

// --- tick-level: many poisoned values, request-level failures, recovery -------------------------

const twitchStream = (login) => ({
  id: `s-${login}`,
  user_login: login,
  user_name: login,
  title: 'hi',
  game_name: 'g',
  viewer_count: 3,
  started_at: '2026-11-16T00:00:00Z',
  thumbnail_url: '',
});

test('twitch tick: 15 poisoned logins in one guild do not stop another guild, and each is quarantined', async (t) => {
  const warned = t.mock.method(log, 'warn', () => {});
  const sent = [];
  installClient(sent);
  const poisoned = Array.from({ length: 15 }, (_, i) => ({ login: `_many${i}`, channelId: CH_A }));
  await setGuildModule(ATTACKER, 'twitch-alerts', { enabled: true, config: { alerts: poisoned } });
  await setGuildModule(VICTIM, 'twitch-alerts', {
    enabled: true,
    config: { alerts: [{ login: 'victim15', channelId: CH_A }] },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'id.twitch.tv') return Response.json({ access_token: 't', expires_in: 3600 });
    const logins = u.searchParams.getAll(u.pathname.endsWith('/users') ? 'login' : 'user_login');
    if (logins.some((l) => l.startsWith('_'))) return new Response('{}', { status: 400 });
    if (u.pathname.endsWith('/streams')) {
      return Response.json({ data: logins.filter((l) => l === 'victim15').map(twitchStream) });
    }
    return Response.json({ data: [] });
  };
  try {
    await twitch.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].guild, VICTIM);
    for (const p of poisoned) assert.equal(twitch.rejectedLogins.has(p.login), true, p.login);
    assert.equal(warned.mock.callCount(), 1, 'one aggregated warning, not one per value');
    assert.match(String(warned.mock.calls[0].arguments[1]), /rejected 15 of the Twitch logins/);
    // The next poll asks about none of them and warns about none.
    await twitch.tick();
    assert.equal(warned.mock.callCount(), 1);
    assert.equal(sent.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('twitch tick: a request-level 403 quarantines no good value and fails the poll like before', async (t) => {
  const failed = t.mock.method(log, 'error', () => {});
  const sent = [];
  installClient(sent);
  await setGuildModule(ATTACKER, 'twitch-alerts', { enabled: false, config: { alerts: [] } });
  await setGuildModule(VICTIM, 'twitch-alerts', {
    enabled: true,
    config: { alerts: ['waf001', 'waf002', 'waf003'].map((login) => ({ login, channelId: CH_A })) },
  });
  const realFetch = globalThis.fetch;
  let blocked = true;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'id.twitch.tv') return Response.json({ access_token: 't', expires_in: 3600 });
    if (blocked) return new Response('{}', { status: 403 });
    const logins = u.searchParams.getAll(u.pathname.endsWith('/users') ? 'login' : 'user_login');
    if (u.pathname.endsWith('/streams')) return Response.json({ data: logins.map(twitchStream) });
    return Response.json({ data: [] });
  };
  try {
    await twitch.tick();
    assert.equal(sent.length, 0);
    assert.equal(failed.mock.callCount(), 1, 'poll failed, as before');
    for (const login of ['waf001', 'waf002', 'waf003']) assert.equal(twitch.rejectedLogins.has(login), false);
    // The outage ends: the very next poll announces them all.
    blocked = false;
    await twitch.tick();
    assert.equal(sent.length, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('twitch tick: a quarantined login that Twitch accepts again is announced and its strikes reset', async (t) => {
  t.mock.method(log, 'warn', () => {});
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const sent = [];
  installClient(sent);
  await setGuildModule(ATTACKER, 'twitch-alerts', { enabled: false, config: { alerts: [] } });
  await setGuildModule(VICTIM, 'twitch-alerts', {
    enabled: true,
    config: {
      alerts: [
        { login: '_flaky1', channelId: CH_A },
        { login: 'steady1', channelId: CH_A },
      ],
    },
  });
  const realFetch = globalThis.fetch;
  let rejectFlaky = true;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'id.twitch.tv') return Response.json({ access_token: 't', expires_in: 3600 });
    const logins = u.searchParams.getAll(u.pathname.endsWith('/users') ? 'login' : 'user_login');
    if (rejectFlaky && logins.includes('_flaky1')) return new Response('{}', { status: 400 });
    if (u.pathname.endsWith('/streams')) return Response.json({ data: logins.map(twitchStream) });
    return Response.json({ data: [] });
  };
  try {
    await twitch.tick();
    assert.equal(sent.length, 1, 'steady1 announced, _flaky1 not');
    assert.equal(twitch.rejectedLogins.strikes('_flaky1'), 1);
    rejectFlaky = false;
    t.mock.timers.tick(11 * 60_000); // past the first backoff
    await twitch.tick();
    assert.equal(sent.length, 2, '_flaky1 announced once Twitch accepts it');
    assert.equal(twitch.rejectedLogins.strikes('_flaky1'), 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('kick tick: a request-level 403 quarantines no good slug', async (t) => {
  const failed = t.mock.method(log, 'error', () => {});
  const sent = [];
  installClient(sent);
  await setGuildModule(ATTACKER, 'kick-alerts', { enabled: false, config: { alerts: [] } });
  await setGuildModule(VICTIM, 'kick-alerts', {
    enabled: true,
    config: { alerts: ['wafk1', 'wafk2'].map((slug) => ({ slug, channelId: CH_A })) },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'id.kick.com') return Response.json({ access_token: 't', expires_in: 3600 });
    return new Response('{}', { status: 403 });
  };
  try {
    await kick.tick();
    assert.equal(sent.length, 0);
    assert.equal(failed.mock.callCount(), 1);
    assert.equal(kick.rejectedSlugs.has('wafk1') || kick.rejectedSlugs.has('wafk2'), false);
  } finally {
    globalThis.fetch = realFetch;
    runtime.client = null;
  }
});

test('twitch tick: two guilds with 50 poisoned logins each, first in order, cannot block the guilds after them', async (t) => {
  twitch.rejectedLogins.setGood(null); // an earlier test may have left a value this one's stub refuses
  t.mock.method(log, 'warn', () => {});
  const failed = t.mock.method(log, 'error', () => {});
  const sent = [];
  const second = '900000000000000503';
  const guilds = new Map([
    [ATTACKER, fakeGuild(ATTACKER, sent)],
    [second, fakeGuild(second, sent)],
    [VICTIM, fakeGuild(VICTIM, sent)],
  ]);
  runtime.client = { isReady: () => true, guilds: { cache: guilds } };
  for (const g of guilds.values()) g.client = runtime.client;
  const poisoned = (tag) =>
    Array.from({ length: 50 }, (_, i) => ({
      login: `_${tag}${String(i).padStart(2, '0')}`,
      channelId: CH_A,
    }));
  await setGuildModule(ATTACKER, 'twitch-alerts', { enabled: true, config: { alerts: poisoned('aa') } });
  await setGuildModule(second, 'twitch-alerts', { enabled: true, config: { alerts: poisoned('bb') } });
  await setGuildModule(VICTIM, 'twitch-alerts', {
    enabled: true,
    config: { alerts: [{ login: 'victimlate', channelId: CH_A }] },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'id.twitch.tv') return Response.json({ access_token: 't', expires_in: 3600 });
    const logins = u.searchParams.getAll(u.pathname.endsWith('/users') ? 'login' : 'user_login');
    if (logins.some((l) => l.startsWith('_'))) return new Response('{}', { status: 400 });
    if (u.pathname.endsWith('/streams')) {
      return Response.json({ data: logins.filter((l) => l === 'victimlate').map(twitchStream) });
    }
    return Response.json({ data: [] });
  };
  try {
    // The batches are cut from a rotating start, so a guild behind the poisoned ones may share a
    // batch with them in a poll; the poll still does not fail, and within a few polls the poisoned
    // logins are quarantined and the guild is announced.
    const all = [...poisoned('aa'), ...poisoned('bb')];
    let polls = 0;
    while (polls < 8 && (sent.length === 0 || all.some((p) => !twitch.rejectedLogins.has(p.login)))) {
      await twitch.tick();
      polls += 1;
      assert.equal(failed.mock.callCount(), 0, `poll ${polls} did not fail`);
    }
    assert.equal(sent.length, 1, `the guild after the poisoned ones is announced (after ${polls} polls)`);
    assert.equal(sent[0].guild, VICTIM);
    assert.ok(
      all.every((p) => twitch.rejectedLogins.has(p.login)),
      'all poisoned logins quarantined'
    );
    assert.ok(polls <= 6, `bounded: ${polls} polls`);
  } finally {
    globalThis.fetch = realFetch;
    runtime.client = null;
  }
});

// --- round 4: enough poisoned values that one poll cannot search them all ------------------------

/** Poll until every poisoned value is quarantined; report how many polls it took and how long a victim waited. */
async function converge({ size, poisonCount, victimsEachSide, maxPolls }) {
  const quarantine = createQuarantine();
  const poison = Array.from({ length: poisonCount }, (_, i) => `_p${i}`);
  const victims = [
    ...Array.from({ length: victimsEachSide }, (_, i) => `va${i}`),
    ...Array.from({ length: victimsEachSide }, (_, i) => `vb${i}`),
  ];
  const items = [...victims.slice(0, victimsEachSide), ...poison, ...victims.slice(victimsEachSide)];
  const ask = async (batch) => {
    if (batch.some((i) => i.startsWith('_'))) throw rejected(400);
    return batch;
  };
  const waited = new Map(victims.map((v) => [v, 0]));
  let longest = 0;
  let polls = 0;
  while (polls < maxPolls && poison.some((p) => !quarantine.has(p))) {
    const out = await fetchIsolated(items, size, ask, { quarantine });
    polls += 1;
    for (const v of victims) {
      waited.set(v, out.results.includes(v) ? 0 : waited.get(v) + 1);
      longest = Math.max(longest, waited.get(v));
    }
  }
  const clean = await fetchIsolated(items, size, ask, { quarantine });
  return { polls, longest, clean, victims, poison, quarantine };
}

for (const [label, size, poisonCount] of [
  ['200 Twitch logins', 100, 200],
  ['250 Kick slugs', 50, 250],
]) {
  test(`fetchIsolated: ${label} spread over several guilds are all quarantined within a bounded number of polls`, async () => {
    const r = await converge({ size, poisonCount, victimsEachSide: 30, maxPolls: 12 });
    assert.ok(
      r.poison.every((p) => r.quarantine.has(p)),
      'all quarantined'
    );
    assert.ok(r.polls <= 6, `${r.polls} polls`);
    assert.ok(r.longest <= r.polls, `a victim next to them waited ${r.longest} polls`);
    assert.deepEqual(
      [...r.clean.results].sort(),
      [...r.victims].sort(),
      'then every poll fetches the victims'
    );
    assert.equal(r.clean.skipped, 0);
  });
}

test('fetchIsolated: every poll isolates values, however many there are', async () => {
  const quarantine = createQuarantine();
  const poison = Array.from({ length: 400 }, (_, i) => `_p${i}`);
  const ask = async (batch) => {
    if (batch.some((i) => i.startsWith('_'))) throw rejected(400);
    return batch;
  };
  let before = 0;
  for (let n = 0; n < 4; n += 1) {
    await fetchIsolated([...poison, 'victim'], 100, ask, { quarantine });
    assert.ok(quarantine.size >= before + 20, `poll ${n + 1} added ${quarantine.size - before}`);
    before = quarantine.size;
  }
});

test('fetchIsolated: a 429 or 5xx on the canary does not throw away what the poll fetched', async () => {
  for (const status of [429, 503]) {
    const quarantine = createQuarantine();
    quarantine.setGood('known-good');
    const out = await fetchIsolated(
      ['fine1', 'bad', 'fine2'],
      1,
      async (batch) => {
        if (batch[0] === 'bad') throw rejected(400);
        if (batch[0] === 'known-good') throw rejected(status);
        return batch;
      },
      { quarantine }
    );
    assert.deepEqual(out.results.sort(), ['fine1', 'fine2'], String(status));
    assert.equal(quarantine.size, 0, 'not quarantined this poll');
  }
});

test('twitch tick: 200 poisoned logins in four guilds converge, with warnings that count and name nothing', async (t) => {
  const warned = t.mock.method(log, 'warn', () => {});
  const failed = t.mock.method(log, 'error', () => {});
  twitch.rejectedLogins.setGood(null);
  const sent = [];
  const owners = ['900000000000000511', '900000000000000512', '900000000000000513', '900000000000000514'];
  const guilds = new Map(owners.map((id) => [id, fakeGuild(id, sent)]));
  guilds.set(VICTIM, fakeGuild(VICTIM, sent));
  runtime.client = { isReady: () => true, guilds: { cache: guilds } };
  for (const g of guilds.values()) g.client = runtime.client;
  const names = [];
  for (const [n, id] of owners.entries()) {
    const alerts = Array.from({ length: 50 }, (_, i) => ({
      login: `_r4${n}x${String(i).padStart(2, '0')}`,
      channelId: CH_A,
    }));
    names.push(...alerts.map((a) => a.login));
    await setGuildModule(id, 'twitch-alerts', { enabled: true, config: { alerts } });
  }
  await setGuildModule(VICTIM, 'twitch-alerts', {
    enabled: true,
    config: { alerts: [{ login: 'victimr4', channelId: CH_A }] },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'id.twitch.tv') return Response.json({ access_token: 't', expires_in: 3600 });
    const logins = u.searchParams.getAll(u.pathname.endsWith('/users') ? 'login' : 'user_login');
    if (logins.some((l) => l.startsWith('_'))) return new Response('{}', { status: 400 });
    if (u.pathname.endsWith('/streams')) {
      return Response.json({ data: logins.filter((l) => l === 'victimr4').map(twitchStream) });
    }
    return Response.json({ data: [] });
  };
  try {
    let polls = 0;
    while (polls < 8 && (sent.length === 0 || names.some((l) => !twitch.rejectedLogins.has(l)))) {
      await twitch.tick();
      polls += 1;
    }
    assert.equal(failed.mock.callCount(), 0);
    assert.ok(polls <= 7, `${polls} polls`);
    assert.equal(sent.length, 1);
    assert.ok(names.every((l) => twitch.rejectedLogins.has(l)));
    const skippedWarnings = warned.mock.calls
      .map((c) => String(c.arguments[1]))
      .filter((m) => /could not be checked this poll/.test(m));
    assert.ok(skippedWarnings.length >= 1, 'warned while the search was cut short');
    for (const m of skippedWarnings) assert.doesNotMatch(m, /_r4/, 'counts only, no values');
  } finally {
    globalThis.fetch = realFetch;
    runtime.client = null;
  }
});

test('kick tick: 250 poisoned slugs in five guilds converge and a guild behind them is announced', async (t) => {
  t.mock.method(log, 'warn', () => {});
  const failed = t.mock.method(log, 'error', () => {});
  kick.rejectedSlugs.setGood(null);
  const sent = [];
  const owners = [
    '900000000000000521',
    '900000000000000522',
    '900000000000000523',
    '900000000000000524',
    '900000000000000525',
  ];
  const guilds = new Map(owners.map((id) => [id, fakeGuild(id, sent)]));
  guilds.set(VICTIM, fakeGuild(VICTIM, sent));
  runtime.client = { isReady: () => true, guilds: { cache: guilds } };
  for (const g of guilds.values()) g.client = runtime.client;
  const names = [];
  for (const [n, id] of owners.entries()) {
    const alerts = Array.from({ length: 50 }, (_, i) => ({
      slug: `-r4${n}x${String(i).padStart(2, '0')}`,
      channelId: CH_A,
    }));
    names.push(...alerts.map((a) => a.slug));
    await setGuildModule(id, 'kick-alerts', { enabled: true, config: { alerts } });
  }
  await setGuildModule(VICTIM, 'kick-alerts', {
    enabled: true,
    config: { alerts: [{ slug: 'victimkr4', channelId: CH_A }] },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === 'id.kick.com') return Response.json({ access_token: 't', expires_in: 3600 });
    const slugs = u.searchParams.getAll('slug');
    if (slugs.some((s) => s.startsWith('-'))) return new Response('{}', { status: 400 });
    return Response.json({
      data: slugs
        .filter((s) => s === 'victimkr4')
        .map((slug) => ({
          slug,
          stream_title: 'hi',
          category: { name: 'g' },
          stream: {
            is_live: true,
            start_time: '2026-11-16T00:00:00Z',
            viewer_count: 2,
            url: 'https://kick.com/victimkr4',
          },
        })),
    });
  };
  try {
    let polls = 0;
    while (polls < 9 && (sent.length === 0 || names.some((s) => !kick.rejectedSlugs.has(s)))) {
      await kick.tick();
      polls += 1;
    }
    assert.equal(failed.mock.callCount(), 0);
    assert.ok(polls <= 8, `${polls} polls`);
    assert.equal(sent.length, 1);
    assert.ok(names.every((s) => kick.rejectedSlugs.has(s)));
  } finally {
    globalThis.fetch = realFetch;
    runtime.client = null;
  }
});

// --- round 5: fresh poison every poll from a few servers, the canary before the search -----------

for (const [label, size, perGuild] of [
  ['Twitch: 150 new rejected logins per poll from 3 servers', 100, 50],
  ['Kick: 100 new rejected slugs per poll from 3 servers', 50, 34],
]) {
  test(`fetchIsolated: ${label} do not keep other servers' values unresolved`, async () => {
    const quarantine = createQuarantine();
    const victims = Array.from({ length: 20 }, (_, i) => `victim${i}`);
    const owner = new Map();
    victims.forEach((v, i) => owner.set(v, `v${i % 2}`));
    const ask = async (batch) => {
      if (batch.some((i) => i.startsWith('_'))) throw rejected(400);
      return batch;
    };
    const fetchedEveryPoll = [];
    for (let poll = 1; poll <= 8; poll += 1) {
      // The same three servers save new rejected values every poll.
      const fresh = [];
      for (const g of ['a', 'b', 'c']) {
        for (let i = 0; i < perGuild; i += 1) {
          const name = `_${g}${poll}x${i}`;
          owner.set(name, `bad-${g}`);
          fresh.push(name);
        }
      }
      const items = [...fresh.slice(0, perGuild), ...victims, ...fresh.slice(perGuild)];
      const out = await fetchIsolated(items, size, ask, { quarantine, groupOf: (i) => owner.get(i) ?? null });
      fetchedEveryPoll.push(victims.every((v) => out.results.includes(v)));
    }
    assert.ok(
      fetchedEveryPoll.slice(1).every(Boolean),
      `victims fetched in every poll after the first: ${fetchedEveryPoll.join(',')}`
    );
  });
}

test('fetchIsolated: a server is flagged when one of its values is found rejected, and only then', async () => {
  const quarantine = createQuarantine();
  const ask = async (batch) => {
    if (batch.includes('_bad')) throw rejected(400);
    return batch;
  };
  const group = (i) => (i === '_bad' ? 'guild-a' : 'guild-b');
  await fetchIsolated(['_bad', 'ok1', 'ok2'], 10, ask, { quarantine, groupOf: group });
  assert.equal(quarantine.isFlagged('guild-a'), true);
  assert.equal(quarantine.isFlagged('guild-b'), false);
});

test('fetchIsolated: when no batch answers and the canary is refused too, the poll fails before the search', async () => {
  const quarantine = createQuarantine();
  quarantine.setGood('known-good');
  const items = Array.from({ length: 300 }, (_, i) => `_x${i}`);
  let calls = 0;
  await assert.rejects(
    fetchIsolated(
      items,
      100,
      async () => {
        calls += 1;
        throw rejected(400);
      },
      { quarantine }
    ),
    /rejected 400/
  );
  assert.equal(calls, 3 + 1, 'three batches and the canary, no search');
  assert.equal(quarantine.size, 0);
});

test('fetchIsolated: when no batch answers but the canary does, the search runs and the values are quarantined', async () => {
  const quarantine = createQuarantine();
  quarantine.setGood('known-good');
  const out = await fetchIsolated(
    ['_x1', '_x2'],
    10,
    async (batch) => {
      if (batch.every((i) => i === 'known-good')) return batch;
      throw rejected(400);
    },
    { quarantine }
  );
  assert.deepEqual(out.rejected.map((r) => r.item).sort(), ['_x1', '_x2']);
});
