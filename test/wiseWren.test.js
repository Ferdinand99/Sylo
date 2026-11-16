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
  shapeRun,
} from '../src/lib/wiseWren.js';

const wren = await startFakeWren();
test.after(() => wren.close());

const settings = { url: wren.url, token: FAKE_TOKEN, targetId: wren.targetId };
const client = () => createWrenClient(settings);
const reset = () => {
  wren.requests.length = 0;
  wren.state.force = {};
  wren.state.delayMs = 0;
};

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
  assert.equal(t.server, 'LANBox');
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

test('approve: the exact version key, then the run id; without a key an empty body', async () => {
  reset();
  const started = await client().approve('sylo=sha256:4f90abcd');
  assert.deepEqual(started, { runId: started.runId, status: 'queued' });
  assert.ok(Number.isSafeInteger(started.runId));
  const [req] = wren.requests;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, `/api/v1/targets/${wren.targetId}/approve`);
  assert.equal(req.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(req.body), { version_key: 'sylo=sha256:4f90abcd' });

  reset();
  await client().approve(null);
  assert.deepEqual(JSON.parse(wren.requests[0].body), {});
});

test("approve: a version that is not the one Wren sees is refused as a conflict, with Wren's words", async () => {
  reset();
  const err = await failure(client().approve('sylo=sha256:old'));
  assert.equal(err.kind, 'conflict');
  assert.equal(err.status, 409);
  assert.match(err.message, /newer version/);
});

test('a run: steps without logs, only a run of this target', async () => {
  reset();
  const { runId } = await client().approve(null);
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
  assert.equal((await failure(client().run(99))).kind, 'not_found');
  assert.equal((await failure(client().run(0))).kind, 'not_found');
  assert.equal((await failure(client().run('7; drop'))).kind, 'not_found');
});

test('the newest run of the target, or null', async () => {
  reset();
  wren.state.runs.clear();
  assert.equal(await client().latestRun(), null);
  const { runId } = await client().approve(null);
  const latest = await client().latestRun();
  assert.equal(latest.id, runId);
  assert.equal(latest.status, 'queued');
  assert.match(wren.requests.at(-1).url, new RegExp(`^/api/v1/runs\\?target_id=${wren.targetId}&limit=1$`));
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
  // Wren's own short error text is kept; a long or missing one is replaced.
  reset();
  wren.state.force['POST approve'] = [409, { error: 'The agent would refuse this update: not allowed.' }];
  assert.match((await failure(client().approve(null))).message, /would refuse this update/);
  wren.state.force['POST approve'] = [409, { error: 'x'.repeat(500) }];
  assert.doesNotMatch((await failure(client().approve(null))).message, /xxxxx/);
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
  assert.equal((await failure(client().approve(null))).kind, 'invalid');
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
  const slow = await failure(createWrenClient(settings, { timeoutMs: 50 }).target());
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
    const err = await failure(createWrenClient({ ...settings, url }).approve(null));
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
  const { runId } = await c.approve(null);
  await c.run(runId);
  await c.latestRun();
  for (const r of wren.requests) {
    assert.match(
      `${r.method} ${r.url}`,
      new RegExp(
        `^(GET /api/v1/targets/${wren.targetId}|POST /api/v1/targets/${wren.targetId}/approve|GET /api/v1/runs/\\d+|GET /api/v1/runs\\?target_id=${wren.targetId}&limit=1)$`
      )
    );
    assert.equal(r.headers.authorization, `Bearer ${FAKE_TOKEN}`);
  }
});
