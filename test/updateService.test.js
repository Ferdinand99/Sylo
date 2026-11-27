// What the update notice offers (src/web/lib/updateService.js): when "Update now" is possible and why not,
// approvals for exactly the version Wren shows, Wren's refusals in its own words, the run Sylo approved being
// remembered across a restart (the single-target token cannot list runs), open mode, and the Wren read being
// shared and cached. Runs against a fake Wise Wren in single-target-token mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FAKE_TOKEN, startFakeWren } from './helpers/fakeWren.js';
import { createUpdateChecker } from '../src/lib/updateCheck.js';
import { WrenError, createWrenClient } from '../src/lib/wiseWren.js';
import {
  OPEN_MODE_TEXT,
  UpdateError,
  WREN_CACHE_MS,
  createUpdateService,
  toUpdateError,
} from '../src/web/lib/updateService.js';

const wren = await startFakeWren({ targetToken: true });
test.after(() => wren.close());

const RELEASE = {
  tag_name: 'v5.3.0',
  html_url: 'https://github.com/Ferdinand99/Sylo/releases/tag/v5.3.0',
  published_at: '2026-11-20T10:00:00Z',
  body: '',
};

/** A store like the database one: it outlives a service (a restart makes a new service). */
const memoryStore = () => {
  let value = null;
  return { get: async () => value, set: async (run) => void (value = run) };
};

function make({ version = '5.2.0', withWren = true, now, store = memoryStore(), openModeBlocked } = {}) {
  const checker = createUpdateChecker({
    version,
    fetchImpl: async () => new Response(JSON.stringify(RELEASE), { status: 200 }),
  });
  const client = withWren
    ? createWrenClient({ url: wren.url, token: FAKE_TOKEN, targetId: wren.targetId })
    : null;
  return { service: createUpdateService({ checker, wren: client, now, store, openModeBlocked }), store };
}

const posts = () => wren.requests.filter((r) => r.method === 'POST');
const targetReads = () =>
  wren.requests.filter((r) => r.url.startsWith('/api/v1/targets/') && r.method === 'GET');

const reset = () => {
  wren.requests.length = 0;
  wren.state.force = {};
  wren.state.delayMs = 0;
  wren.state.runs.clear();
  wren.state.targetToken = true;
  Object.assign(wren.state.target, {
    status: 'update',
    effective_mode: 'approve',
    blocked_reason: null,
    version_key: 'sylo=sha256:4f90abcd',
  });
};

test('without Wise Wren: the check only, wren is null, approving is refused', async () => {
  reset();
  const { service } = make({ withWren: false });
  const s = await service.status();
  assert.equal(s.available, true);
  assert.equal(s.wren, null);
  await assert.rejects(
    service.approve(),
    (e) => e instanceof UpdateError && e.status === 404 && e.code === 'wren_off'
  );
  await assert.rejects(service.run(1), (e) => e instanceof UpdateError && e.status === 404);
  assert.equal(wren.requests.length, 0);
});

test('with Wise Wren: what it sees, that Update now is possible, and no run list is asked for', async () => {
  reset();
  const { service } = make();
  const s = await service.status();
  assert.equal(s.wren.configured, true);
  assert.equal(s.wren.updateSeen, true);
  assert.equal(s.wren.canApprove, true);
  assert.equal(s.wren.whyNot, null);
  assert.equal(s.wren.openMode, false);
  assert.equal(s.wren.target.name, 'sylo');
  assert.equal(s.wren.latestRun, null);
  assert.equal(s.wren.error, null);
  assert.equal('readable' in s.wren, false);
  // The answer never carries what is needed to reach Wren, nor its address, nor the version key.
  const text = JSON.stringify(s);
  assert.doesNotMatch(text, new RegExp(FAKE_TOKEN));
  assert.doesNotMatch(text, /127\.0\.0\.1/);
  assert.doesNotMatch(text, /sha256/);
  // Only the target is read: the run list is refused to a single-target token.
  assert.ok(wren.requests.every((r) => !r.url.startsWith('/api/v1/runs?')));
});

test('Update now is not offered when Wren sees none, only notifies, or would refuse', async () => {
  reset();
  wren.state.target.status = 'current';
  let s = await make().service.status();
  assert.equal(s.wren.canApprove, false);
  assert.match(s.wren.whyNot, /does not see an update/);

  reset();
  wren.state.target.effective_mode = 'notify';
  s = await make().service.status();
  assert.equal(s.wren.canApprove, false);
  assert.match(s.wren.whyNot, /only notifies/);

  reset();
  wren.state.target.blocked_reason = "not allowed by the agent's [updates] list";
  s = await make().service.status();
  assert.equal(s.wren.canApprove, false);
  assert.match(s.wren.whyNot, /would refuse it: not allowed/);
});

test('approve sends exactly the version Wren shows and answers with the run and the version it started from', async () => {
  reset();
  const { service } = make();
  const out = await service.approve();
  assert.equal(out.from, '5.2.0');
  assert.equal(out.status, 'queued');
  assert.ok(Number.isSafeInteger(out.runId));
  assert.deepEqual(JSON.parse(posts()[0].body), { version_key: 'sylo=sha256:4f90abcd' });
});

test('approve is refused when Wren shows nothing to approve: no approval is sent', async () => {
  for (const change of [{ status: 'current' }, { effective_mode: 'notify' }, { blocked_reason: 'nope' }]) {
    reset();
    Object.assign(wren.state.target, change);
    await assert.rejects(
      make().service.approve(),
      (e) => e instanceof UpdateError && e.status === 409 && e.code === 'not_approvable'
    );
    assert.equal(posts().length, 0);
  }
});

test('an update that has a status but no version key is not approved blindly', async () => {
  reset();
  wren.state.target.version_key = '';
  const { service } = make();
  assert.equal((await service.status()).wren.canApprove, false);
  await assert.rejects(service.approve(), (e) => e.status === 409);
  assert.equal(posts().length, 0);
});

test("Wren's refusals at the moment of approving come back as a 409 with Wren's words", async () => {
  // The version changed between Sylo's read and the approval: Wren answers 400.
  reset();
  const { service } = make();
  wren.state.force['POST approve'] = [
    400,
    { error: { code: 'bad_request', message: 'The version changed since you looked; approve the new one.' } },
  ];
  await assert.rejects(service.approve(), (e) => {
    const mapped = toUpdateError(e);
    assert.equal(mapped.status, 409);
    assert.equal(mapped.code, 'wren_refused');
    assert.match(mapped.message, /version changed/);
    return true;
  });

  // Another person's approval is already running (Sylo does not know that run).
  reset();
  const first = make();
  await first.service.approve();
  const second = make(); // a service that has not heard of the run
  await assert.rejects(second.service.approve(), (e) => {
    const mapped = toUpdateError(e);
    assert.equal(mapped.status, 409);
    assert.match(mapped.message, /already queued or running/);
    return true;
  });

  // The agent would refuse the target: 409 too.
  reset();
  wren.state.force['POST approve'] = [
    409,
    { error: { code: 'conflict', message: 'The agent would refuse this update: x.' } },
  ];
  await assert.rejects(make().service.approve(), (e) => toUpdateError(e).status === 409);
});

test('the approved run is remembered, also across a restart: Update now stays off while it runs', async () => {
  reset();
  const store = memoryStore();
  const before = make({ store });
  const { runId } = await before.service.approve();
  assert.deepEqual(await store.get(), { id: runId });

  // "Restart": a new service with the same store (the database), and a fresh cache.
  const after = make({ store });
  let s = await after.service.status();
  assert.equal(s.wren.latestRun.id, runId);
  assert.equal(s.wren.latestRun.finished, false);
  assert.equal(s.wren.canApprove, false);
  assert.match(s.wren.whyNot, /already running/);
  assert.ok(
    wren.requests.every((r) => !r.url.startsWith('/api/v1/runs?')),
    'read by id only'
  );
  await assert.rejects(after.service.approve(), (e) => e.status === 409);
  assert.equal(posts().length, 1, 'no second approval');

  // Wren finishes it: Update now is possible again.
  wren.state.runs.get(runId).status = 'succeeded';
  after.service.drop();
  s = await after.service.status();
  assert.equal(s.wren.latestRun.finished, true);
  assert.equal(s.wren.canApprove, true);
});

test('a store that fails does not break approving; the run is kept in memory', async () => {
  reset();
  const broken = {
    get: async () => {
      throw new Error('db down');
    },
    set: async () => {
      throw new Error('db down');
    },
  };
  const { service } = make({ store: broken });
  const { runId } = await service.approve();
  service.drop();
  assert.equal((await service.status()).wren.latestRun.id, runId);
});

test('a 403 on the target (a token for another target) is an error, never an approval without a version', async () => {
  reset();
  wren.state.force['GET target'] = [
    403,
    { error: { code: 'forbidden', message: 'This token is not allowed for that target.' } },
  ];
  const { service } = make();
  const s = await service.status();
  assert.equal(s.wren.error.code, 'wren_forbidden');
  assert.match(s.wren.error.message, /not allowed for that target/);
  assert.equal(s.wren.canApprove, false);
  assert.equal(s.wren.target, null);
  await assert.rejects(
    service.approve(),
    (e) => e instanceof UpdateError && e.status === 502 && e.code === 'wren_forbidden'
  );
  assert.equal(posts().length, 0);
});

test('Wren being down, or refusing the token, is an error in the answer, not a thrown one', async () => {
  reset();
  wren.state.force['GET target'] = [401, { error: { code: 'unauthorized', message: 'Bad token.' } }];
  const { service } = make();
  const s = await service.status();
  assert.equal(s.wren.error.code, 'wren_unauthorized');
  assert.equal(s.wren.canApprove, false);
  assert.equal(s.available, true, 'the release check still works');
  await assert.rejects(
    service.approve(),
    (e) => e instanceof UpdateError && e.status === 502 && e.code === 'wren_unauthorized'
  );
  reset();
});

test('open mode: Update now is off before Wren is asked, with a reason; the notice still works', async () => {
  reset();
  const { service } = make({ openModeBlocked: () => true });
  const s = await service.status();
  assert.equal(s.available, true);
  assert.equal(s.wren.updateSeen, true, 'what Wren sees can still be shown');
  assert.equal(s.wren.openMode, true);
  assert.equal(s.wren.canApprove, false);
  assert.equal(s.wren.whyNot, OPEN_MODE_TEXT);
  assert.match(OPEN_MODE_TEXT, /WISE_WREN_ALLOW_OPEN_MODE=true/);
  wren.requests.length = 0;
  await assert.rejects(
    service.approve(),
    (e) => e instanceof UpdateError && e.status === 409 && e.code === 'open_mode'
  );
  assert.equal(wren.requests.length, 0, 'Wren is not asked at all');

  // Allowed (the opt-in) or not open mode: it works.
  reset();
  assert.ok((await make({ openModeBlocked: () => false }).service.approve()).runId);
});

test('Wise Wren errors map to answers that are never 401 or 403, which would look like a lost session', () => {
  const expected = {
    unreachable: 502,
    unauthorized: 502,
    forbidden: 502,
    not_found: 404,
    conflict: 409,
    refused: 409,
    rate_limited: 429,
    server: 502,
    invalid: 502,
    bad_request: 502,
  };
  for (const [kind, status] of Object.entries(expected)) {
    const mapped = toUpdateError(new WrenError(kind, 'm'));
    assert.equal(mapped.status, status, kind);
    assert.equal(mapped.code, `wren_${kind}`);
    assert.notEqual(mapped.status, 401);
    assert.notEqual(mapped.status, 403);
  }
  assert.equal(toUpdateError(new Error('boom')), null);
});

test('the Wren read is kept for a few seconds and dropped on a re-check or an approval', async () => {
  reset();
  let clock = 1_000;
  const { service } = make({ now: () => clock });
  await service.status();
  await service.status();
  assert.equal(targetReads().length, 1);
  clock += WREN_CACHE_MS + 1;
  await service.status();
  assert.equal(targetReads().length, 2);
  await service.status({ force: true });
  assert.equal(targetReads().length, 3);
});

test('concurrent reads share one request to Wren, and GitHub and Wren are asked at the same time', async () => {
  reset();
  wren.state.delayMs = 150;
  const { service } = make();
  const started = Date.now();
  const all = await Promise.all([service.status(), service.status(), service.status(), service.status()]);
  assert.equal(targetReads().length, 1, 'one read of the target for four callers');
  assert.ok(all.every((s) => s.wren.canApprove));
  assert.ok(Date.now() - started < 1500);
});

test('a run of another target is not readable through Sylo', async () => {
  reset();
  wren.state.runs.set(77, {
    id: 77,
    target: { id: 99, kind: 'container', name: 'other' },
    status: 'running',
    steps: [],
  });
  await assert.rejects(
    make().service.run(77),
    (e) => toUpdateError(e)?.status === 502 && toUpdateError(e).code === 'wren_forbidden'
  );
  wren.state.targetToken = false;
  await assert.rejects(make().service.run(77), (e) => toUpdateError(e)?.status === 404);
  wren.state.targetToken = true;
});
