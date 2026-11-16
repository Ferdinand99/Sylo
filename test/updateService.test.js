// What the update notice offers (src/web/lib/updateService.js): when "Update now" is possible and why not,
// a token that can approve but not read, approvals for exactly the version Wren shows, and the short cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FAKE_TOKEN, startFakeWren } from './helpers/fakeWren.js';
import { createUpdateChecker } from '../src/lib/updateCheck.js';
import { WrenError, createWrenClient } from '../src/lib/wiseWren.js';
import {
  UpdateError,
  WREN_CACHE_MS,
  createUpdateService,
  toUpdateError,
} from '../src/web/lib/updateService.js';

const wren = await startFakeWren();
test.after(() => wren.close());

const RELEASE = {
  tag_name: 'v5.3.0',
  html_url: 'https://github.com/Ferdinand99/Sylo/releases/tag/v5.3.0',
  published_at: '2026-11-20T10:00:00Z',
  body: '',
};

function make({ version = '5.2.0', withWren = true, now } = {}) {
  const checker = createUpdateChecker({
    version,
    fetchImpl: async () => new Response(JSON.stringify(RELEASE), { status: 200 }),
  });
  const client = withWren
    ? createWrenClient({ url: wren.url, token: FAKE_TOKEN, targetId: wren.targetId })
    : null;
  return createUpdateService({ checker, wren: client, now });
}

const reset = () => {
  wren.requests.length = 0;
  wren.state.force = {};
  wren.state.runs.clear();
  Object.assign(wren.state.target, {
    status: 'update',
    effective_mode: 'approve',
    blocked_reason: null,
    version_key: 'sylo=sha256:4f90abcd',
  });
};

test('without Wise Wren: the check only, wren is null, approving is refused', async () => {
  reset();
  const service = make({ withWren: false });
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

test('with Wise Wren: what it sees, and that Update now is possible', async () => {
  reset();
  const s = await make().status();
  assert.equal(s.wren.configured, true);
  assert.equal(s.wren.readable, true);
  assert.equal(s.wren.updateSeen, true);
  assert.equal(s.wren.canApprove, true);
  assert.equal(s.wren.whyNot, null);
  assert.equal(s.wren.target.name, 'sylo');
  assert.equal(s.wren.latestRun, null);
  assert.equal(s.wren.error, null);
  // The answer never carries what is needed to reach Wren, nor its address, nor the version key.
  const text = JSON.stringify(s);
  assert.doesNotMatch(text, new RegExp(FAKE_TOKEN));
  assert.doesNotMatch(text, /127\.0\.0\.1/);
  assert.doesNotMatch(text, /sha256/);
});

test('Update now is not offered when Wren sees none, only notifies, would refuse, or a run is active', async () => {
  reset();
  wren.state.target.status = 'current';
  let s = await make().status();
  assert.equal(s.wren.canApprove, false);
  assert.match(s.wren.whyNot, /does not see an update/);

  reset();
  wren.state.target.effective_mode = 'notify';
  s = await make().status();
  assert.equal(s.wren.canApprove, false);
  assert.match(s.wren.whyNot, /only notifies/);

  reset();
  wren.state.target.blocked_reason = "not allowed by the agent's [updates] list";
  s = await make().status();
  assert.equal(s.wren.canApprove, false);
  assert.match(s.wren.whyNot, /would refuse it: not allowed/);

  reset();
  const approving = make();
  await approving.approve();
  s = await make().status();
  assert.equal(s.wren.latestRun.finished, false);
  assert.equal(s.wren.canApprove, false);
  assert.match(s.wren.whyNot, /already running/);
});

test('approve sends exactly the version Wren shows and answers with the run and the version it started from', async () => {
  reset();
  const out = await make().approve();
  assert.equal(out.from, '5.2.0');
  assert.equal(out.status, 'queued');
  assert.ok(Number.isSafeInteger(out.runId));
  const post = wren.requests.find((r) => r.method === 'POST');
  assert.deepEqual(JSON.parse(post.body), { version_key: 'sylo=sha256:4f90abcd' });
});

test('approve is refused when Wren shows nothing to approve: no request to approve is made', async () => {
  for (const change of [{ status: 'current' }, { effective_mode: 'notify' }, { blocked_reason: 'nope' }]) {
    reset();
    Object.assign(wren.state.target, change);
    await assert.rejects(
      make().approve(),
      (e) => e instanceof UpdateError && e.status === 409 && e.code === 'not_approvable'
    );
    assert.equal(wren.requests.filter((r) => r.method === 'POST').length, 0);
  }
});

test('a token that may approve but not read: the GitHub check decides and the approval carries no version key', async () => {
  reset();
  wren.state.force['GET target'] = [403, { error: 'This token cannot read targets.' }];
  wren.state.force['GET runs'] = [403, { error: 'no' }];
  const service = make();
  const s = await service.status();
  assert.equal(s.wren.readable, false);
  assert.equal(s.wren.target, null);
  assert.equal(s.wren.error, null);
  assert.equal(s.wren.canApprove, true, 'a newer release is out, so it is offered');
  const out = await service.approve();
  assert.ok(out.runId);
  assert.deepEqual(JSON.parse(wren.requests.find((r) => r.method === 'POST').body), {});

  // No newer release: nothing to approve blindly.
  const same = make({ version: '5.3.0' });
  assert.equal((await same.status()).wren.canApprove, false);
  await assert.rejects(same.approve(), (e) => e.status === 409);

  // The run is not readable either: the answer says so instead of failing.
  wren.state.force['GET run'] = [403, { error: 'no' }];
  assert.deepEqual(await service.run(out.runId), { readable: false, run: null });
});

test('Wren being down, or refusing the token, is an error in the answer, not a thrown one; approving then fails clearly', async () => {
  reset();
  wren.state.force['GET target'] = [401, {}];
  const service = make();
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

test('Wise Wren errors map to answers that are never 401 or 403, which would look like a lost session', () => {
  const expected = {
    unreachable: 502,
    unauthorized: 502,
    forbidden: 502,
    not_found: 404,
    conflict: 409,
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
  // Anything else is a real error for the error handler.
  assert.equal(toUpdateError(new Error('boom')), null);
});

test('the Wren read is kept for a few seconds and dropped on a re-check or an approval', async () => {
  reset();
  let clock = 1_000;
  const service = make({ now: () => clock });
  await service.status();
  await service.status();
  assert.equal(wren.requests.filter((r) => r.url.startsWith('/api/v1/targets/')).length, 1);
  clock += WREN_CACHE_MS + 1;
  await service.status();
  assert.equal(wren.requests.filter((r) => r.url.startsWith('/api/v1/targets/')).length, 2);
  await service.status({ force: true });
  assert.equal(wren.requests.filter((r) => r.url.startsWith('/api/v1/targets/')).length, 3);
});

test('a run of another target is not readable through Sylo', async () => {
  reset();
  wren.state.runs.set(77, {
    id: 77,
    target: { id: 99, kind: 'container', name: 'other' },
    status: 'running',
    steps: [],
  });
  await assert.rejects(make().run(77), (e) => toUpdateError(e)?.status === 404);
});
