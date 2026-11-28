// The Wise Wren client (src/lib/wiseWren.js) against a fake Wise Wren: reading the target, approving, a run's
// progress, every kind of error, and that the token only ever goes in the Authorization header of a request
// to the configured address (never in an error, a redirect or an answer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { FAKE_TOKEN, startFakeWren } from './helpers/fakeWren.js';
import {
  WrenError,
  checkWrenUrl,
  createWrenClient,
  readWrenSettings,
  parseVersionKey,
  shapeRun,
  shapeTarget,
} from '../src/lib/wiseWren.js';

// The recommended token: limited to this one target (the run list and other targets answer 403).
const wren = await startFakeWren({ targetToken: true });
test.after(() => wren.close());

const settings = { url: wren.url, token: FAKE_TOKEN, targetId: wren.targetId };
const client = () => createWrenClient(settings);
const reset = () => {
  wren.requests.length = 0;
  wren.state.force = {};
  wren.state.delayMs = 0;
  wren.state.runs.clear();
  Object.assign(wren.state.target, {
    status: 'update',
    effective_mode: 'approve',
    blocked_reason: null,
    version_key: 'sylo=sha256:4f90abcd',
    require_snapshot: true,
  });
};
const KEY = 'sylo=sha256:4f90abcd';

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof WrenError, `expected a WrenError, got ${err}`);
    return err;
  }
  assert.fail('expected a failure');
}

test('settings: all three or none; the address must be https or a local http', () => {
  assert.deepEqual(readWrenSettings({}), { settings: null, problem: null });
  assert.deepEqual(readWrenSettings({ WISE_WREN_URL: '  ', WISE_WREN_TOKEN: '' }), {
    settings: null,
    problem: null,
  });
  const ok = readWrenSettings({
    WISE_WREN_URL: 'https://wren.example.com/',
    WISE_WREN_TOKEN: ' ww_abc ',
    WISE_WREN_TARGET_ID: '12',
  });
  assert.deepEqual(ok.settings, { url: 'https://wren.example.com', token: 'ww_abc', targetId: 12 });
  // Some missing: off, with a reason that names the variables, never a value.
  const partial = readWrenSettings({ WISE_WREN_URL: 'https://wren.example.com', WISE_WREN_TOKEN: 'ww_abc' });
  assert.equal(partial.settings, null);
  assert.match(partial.problem, /WISE_WREN_TARGET_ID/);
  assert.doesNotMatch(partial.problem, /ww_abc/);
  for (const id of ['0', '-1', '1.5', 'abc', '1e3', '99999999999']) {
    const r = readWrenSettings({
      WISE_WREN_URL: 'https://w.example.com',
      WISE_WREN_TOKEN: 't',
      WISE_WREN_TARGET_ID: id,
    });
    assert.equal(r.settings, null, id);
    assert.match(r.problem, /TARGET_ID/);
  }
  const bad = readWrenSettings({
    WISE_WREN_URL: 'http://wren.example.com',
    WISE_WREN_TOKEN: 'ww_secret_value',
    WISE_WREN_TARGET_ID: '1',
  });
  assert.equal(bad.settings, null);
  assert.doesNotMatch(bad.problem, /ww_secret_value/);
});

test('the address: https anywhere, http only on this machine or the local network, no credentials', () => {
  for (const u of [
    'https://wren.example.com',
    'http://localhost:3003',
    'http://127.0.0.1:3003/',
    'http://10.0.3.152:3003',
    'http://192.168.1.5',
    'http://wise-wren:3003',
    'http://wren.lan',
    'http://tower.ts.net',
    'http://[::1]:3003',
  ]) {
    assert.doesNotThrow(() => checkWrenUrl(u), u);
  }
  assert.equal(checkWrenUrl('https://wren.example.com/base/'), 'https://wren.example.com/base');
  for (const u of [
    'http://wren.example.com',
    'http://8.8.8.8',
    'ftp://wren.local',
    'https://user:pass@wren.example.com',
    'https://wren.example.com/?x=1',
    'https://wren.example.com/#x',
    'not a url',
    '',
  ]) {
    assert.throws(() => checkWrenUrl(u), Error, u);
  }
});

test('the target: what Wren sees, shaped, with the bearer token and no body', async () => {
  reset();
  const t = await client().target();
  assert.equal(t.status, 'update');
  assert.equal(t.name, 'sylo');
  assert.equal(t.server, 'docker-1');
  assert.equal(t.versionKey, 'sylo=sha256:4f90abcd');
  assert.equal(t.mode, 'approve');
  assert.equal(t.blockedReason, null);
  assert.equal(wren.requests.length, 1);
  const [req] = wren.requests;
  assert.equal(req.method, 'GET');
  assert.equal(req.url, `/api/v1/targets/${wren.targetId}`);
  assert.equal(req.headers.authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(req.body, '');
});

test('approve: the exact version key, then the run id; an approval without a key is never sent', async () => {
  reset();
  const started = await client().approve(KEY);
  assert.deepEqual(started, { runId: started.runId, status: 'queued' });
  assert.ok(Number.isSafeInteger(started.runId));
  const [req] = wren.requests;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, `/api/v1/targets/${wren.targetId}/approve`);
  assert.equal(req.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(req.body), { version_key: KEY });

  reset();
  for (const missing of [null, undefined, '']) {
    const err = await failure(client().approve(missing));
    assert.equal(err.kind, 'refused');
  }
  assert.equal(wren.requests.length, 0, 'nothing asked of Wren without a version key');
});

test("approve: Wren's refusals (400 and 409) are `refused`, with Wren's own words", async () => {
  // The version changed since Sylo looked: a 400 in the real Wren.
  reset();
  let err = await failure(client().approve('sylo=sha256:old'));
  assert.equal(err.kind, 'refused');
  assert.equal(err.status, 400);
  assert.match(err.message, /version changed/);

  // A second approval while a run is queued or running.
  reset();
  await client().approve(KEY);
  err = await failure(client().approve(KEY));
  assert.equal(err.kind, 'refused');
  assert.match(err.message, /already queued or running/);

  // Notify-only and no update are 400s too; an agent that would refuse the target is a 409.
  reset();
  wren.state.target.effective_mode = 'notify';
  assert.match((await failure(client().approve(KEY))).message, /notify-only/);
  reset();
  wren.state.target.status = 'current';
  assert.match((await failure(client().approve(KEY))).message, /no update/);
  reset();
  wren.state.target.blocked_reason = 'not allowed by its [updates] list';
  err = await failure(client().approve(KEY));
  assert.equal(err.kind, 'refused');
  assert.equal(err.status, 409);
  assert.match(err.message, /agent would refuse this update: not allowed/);
});

test('a run: steps without logs, only a run of this target', async () => {
  reset();
  const { runId } = await client().approve(KEY);
  const run = wren.state.runs.get(runId);
  run.status = 'running';
  run.steps = [
    { step: 'preflight', status: 'ok', duration_ms: 812, log: 'pulled ghcr.io/x/y@sha256:secret-ish' },
    { step: 'stop', status: 'running', duration_ms: null, log: '/mnt/user/appdata/sylo' },
  ];
  const r = await client().run(runId);
  assert.equal(r.status, 'running');
  assert.equal(r.finished, false);
  assert.equal(r.ok, false);
  assert.deepEqual(r.steps, [
    { step: 'preflight', status: 'ok', durationMs: 812 },
    { step: 'stop', status: 'running', durationMs: null },
  ]);
  assert.doesNotMatch(JSON.stringify(r), /sha256|appdata/, 'step logs stay in Wise Wren');

  run.status = 'succeeded';
  run.finished_at = '2026-11-16 10:05:00';
  const done = await client().run(runId);
  assert.equal(done.finished, true);
  assert.equal(done.ok, true);

  // A run of another target is "no such run", even though Wren has it.
  wren.state.runs.set(99, {
    id: 99,
    target: { id: 8, kind: 'container', name: 'other' },
    status: 'succeeded',
    steps: [],
  });
  // (A plain write token can read it; a target token is refused it by Wren, see below.)
  wren.state.targetToken = false;
  assert.equal((await failure(client().run(99))).kind, 'not_found');
  wren.state.targetToken = true;
  assert.equal((await failure(client().run(0))).kind, 'not_found');
  assert.equal((await failure(client().run('7; drop'))).kind, 'not_found');
});

test('a single-target token: the run list and other targets are refused, and Sylo never asks for them', async () => {
  reset();
  // What Wren does for such a token (so a client that asked would fail):
  const direct = (path) =>
    fetch(`${wren.url}${path}`, { headers: { authorization: `Bearer ${FAKE_TOKEN}` } });
  assert.equal((await direct(`/api/v1/runs?target_id=${wren.targetId}&limit=1`)).status, 403);
  assert.equal((await direct('/api/v1/targets/99')).status, 403);
  wren.requests.length = 0;
  const c = client();
  await c.target();
  const { runId } = await c.approve(KEY);
  await c.run(runId);
  assert.ok(
    wren.requests.every((r) => !r.url.startsWith('/api/v1/runs?')),
    'no run list'
  );
  // A run of another target: the token is refused it (403), and Sylo would not show it anyway.
  wren.state.runs.set(99, {
    id: 99,
    target: { id: 8, kind: 'container', name: 'other' },
    status: 'running',
    steps: [],
  });
  assert.equal((await failure(c.run(99))).kind, 'forbidden');
});

test('terminal states are finished; only succeeded is ok', () => {
  for (const status of [
    'succeeded',
    'rolled_back',
    'failed',
    'rollback_failed',
    'refused',
    'cancelled',
    'lapsed',
  ]) {
    assert.equal(shapeRun({ id: 1, status }).finished, true, status);
  }
  for (const status of ['queued', 'running', 'whatever'])
    assert.equal(shapeRun({ id: 1, status }).finished, false, status);
  assert.equal(shapeRun({ id: 1, status: 'rolled_back' }).ok, false);
  assert.equal(shapeRun({ status: 'x' }), null);
});

test('errors by status: unauthorized, forbidden, not found, rate limited, server, with safe messages', async () => {
  for (const [status, kind] of [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [400, 'bad_request'],
    [409, 'conflict'],
    [429, 'rate_limited'],
    [500, 'server'],
    [502, 'server'],
  ]) {
    reset();
    wren.state.force['GET target'] = [status, {}];
    const err = await failure(client().target());
    assert.equal(err.kind, kind, String(status));
    assert.equal(err.status, status);
    assert.ok(err.message.length > 5);
    assert.doesNotMatch(err.message, new RegExp(FAKE_TOKEN));
    assert.doesNotMatch(err.message, /127\.0\.0\.1/);
  }
  // Wren's own short error text is kept (its envelope is {"error": {"code", "message"}}), a long or missing
  // one is replaced, and a plain string error is read too.
  reset();
  wren.state.force['GET target'] = [
    403,
    { error: { code: 'forbidden', message: 'This token is for another target.' } },
  ];
  assert.match((await failure(client().target())).message, /for another target/);
  wren.state.force['GET target'] = [500, { error: { code: 'x', message: 'x'.repeat(500) } }];
  assert.doesNotMatch((await failure(client().target())).message, /xxxxx/);
  wren.state.force['GET target'] = [500, { error: 'Plain text error' }];
  assert.match((await failure(client().target())).message, /Plain text error/);
  reset();
});

test('a wrong token is a 401 from Wren: unauthorized, and the message does not echo it', async () => {
  reset();
  const err = await failure(createWrenClient({ ...settings, token: 'ww_wrong_token_value' }).target());
  assert.equal(err.kind, 'unauthorized');
  assert.doesNotMatch(err.message, /ww_wrong_token_value/);
});

test('an answer that is not JSON, or not an object, is invalid; a missing run id too', async () => {
  reset();
  wren.state.force['GET target'] = [200, 'not an object'];
  assert.equal((await failure(client().target())).kind, 'invalid');
  wren.state.force['POST approve'] = [200, { status: 'queued' }];
  assert.equal((await failure(client().approve(KEY))).kind, 'invalid');
  reset();
});

test('unreachable and too slow are their own kinds, and the error never carries the address or token', async () => {
  const dead = await startFakeWren();
  const url = dead.url;
  dead.close();
  const err = await failure(createWrenClient({ ...settings, url }).target());
  assert.equal(err.kind, 'unreachable');
  assert.doesNotMatch(err.message, /127\.0\.0\.1/);
  assert.doesNotMatch(err.message, new RegExp(FAKE_TOKEN));

  reset();
  wren.state.delayMs = 300;
  const slow = await failure(createWrenClient(settings, { readTimeoutMs: 50 }).target());
  assert.equal(slow.kind, 'unreachable');
  assert.match(slow.message, /in time/);
  reset();
});

test('a redirect is not followed, so the token never reaches another address', async () => {
  const seen = [];
  const elsewhere = createServer((req, res) => {
    seen.push(req.headers.authorization ?? null);
    res.end('{}');
  });
  await new Promise((r) => elsewhere.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${elsewhere.address().port}/stolen`;
  const redirecting = createServer((_req, res) => {
    res.writeHead(302, { location: target });
    res.end();
  });
  await new Promise((r) => redirecting.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${redirecting.address().port}`;
    const err = await failure(createWrenClient({ ...settings, url }).approve(KEY));
    assert.equal(err.kind, 'server');
    assert.match(err.message, /redirect/);
    assert.deepEqual(seen, [], 'nothing was sent to the redirect target');
  } finally {
    elsewhere.closeAllConnections?.();
    redirecting.closeAllConnections?.();
    elsewhere.close();
    redirecting.close();
  }
});

test('only the three routes on the one target are ever called', async () => {
  reset();
  const c = client();
  await c.target();
  const { runId } = await c.approve(KEY);
  await c.run(runId);
  for (const r of wren.requests) {
    assert.match(
      `${r.method} ${r.url}`,
      new RegExp(
        `^(GET /api/v1/targets/${wren.targetId}|POST /api/v1/targets/${wren.targetId}/approve|GET /api/v1/runs/\\d+)$`
      )
    );
    assert.equal(r.headers.authorization, `Bearer ${FAKE_TOKEN}`);
  }
});

test('an oversized answer is cut off while it streams, not buffered whole', async () => {
  let pulled = 0;
  const chunk = new TextEncoder().encode('x'.repeat(300_000));
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  const body = new ReadableStream({
    pull(controller) {
      pulled++;
      if (pulled > 50) return controller.close();
      controller.enqueue(chunk);
    },
  });
  const c = createWrenClient(settings, { fetchImpl: async () => new Response(body, { status: 200 }) });
  const err = await failure(c.target());
  assert.equal(err.kind, 'invalid');
  assert.ok(pulled < 10, `read ${pulled} chunks of 50`);
});

test('an answer that declares more than the cap is refused before it is read', async () => {
  let pulled = 0;
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  const body = new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new TextEncoder().encode('{}'));
    },
  });
  const c = createWrenClient(settings, {
    fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-length': '5000000' } }),
  });
  const err = await failure(c.target());
  assert.equal(err.kind, 'invalid');
  assert.ok(pulled <= 1, `pulled ${pulled} chunks`);
});

test('the version key names which containers have the update, never the digests', () => {
  assert.deepEqual(parseVersionKey('sylo=sha256:4f90abcd', 'sylo'), { sylo: true, database: [], other: [] });
  assert.deepEqual(parseVersionKey('sylo-postgres=sha256:64c8abcd', 'sylo'), {
    sylo: false,
    database: ['sylo-postgres'],
    other: [],
  });
  assert.deepEqual(
    parseVersionKey('version=5.3.0,sylo=sha256:1,sylo-postgres=sha256:2,cache=sha256:3', 'sylo'),
    { sylo: true, database: ['sylo-postgres'], other: ['cache'] }
  );
  // A target with its own name: that container is the app.
  assert.equal(parseVersionKey('web=sha256:1', 'web').sylo, true);
  assert.equal(parseVersionKey('', 'sylo'), null);
  assert.equal(parseVersionKey(null, 'sylo'), null);
  assert.equal(parseVersionKey(',=,', 'sylo'), null);
  assert.doesNotMatch(JSON.stringify(parseVersionKey('a=sha256:deadbeef')), /deadbeef/);
});

test('a target shows its parts and whether Wren requires a snapshot', () => {
  const t = shapeTarget({
    name: 'sylo',
    status: 'update',
    version_key: 'sylo-postgres=sha256:64c8abcd',
    require_snapshot: false,
  });
  assert.deepEqual(t.updates, { sylo: false, database: ['sylo-postgres'], other: [] });
  assert.equal(t.requireSnapshot, false);
  assert.equal(shapeTarget({ name: 'sylo', status: 'current' }).requireSnapshot, null);
  assert.equal(shapeTarget({ name: 'sylo', status: 'current' }).updates, null);
});
