// The operators' update notice through the real app (src/web/routes/v2Update.js): only Sylo's operators may
// read it or use "Update now" (a server admin and a signed-out visitor are refused), writes need the CSRF
// token, the approve route has its own small budget, and the Wise Wren token is in no answer and no log line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, startOAuthApp } from './helpers/oauthApp.js';
import { anonymous, session, OPERATOR_ID } from './helpers/v2Guarded.js';
import { FAKE_TOKEN, startFakeWren } from './helpers/fakeWren.js';

await startOAuthApp();

const { setUpdateService } = await import('../src/web/routes/v2Update.js');
const { createUpdateService } = await import('../src/web/lib/updateService.js');
const { createUpdateChecker } = await import('../src/lib/updateCheck.js');
const { createWrenClient } = await import('../src/lib/wiseWren.js');
const { listBotAudit } = await import('../src/db/botAudit.js');

const wren = await startFakeWren();
test.after(() => wren.close());

const RELEASE = {
  tag_name: 'v99.0.0',
  html_url: 'https://github.com/Ferdinand99/Sylo/releases/tag/v99.0.0',
  published_at: '2026-11-20T10:00:00Z',
  body: '## [99.0.0](https://github.com/Ferdinand99/Sylo/compare/v5.2.0...v99.0.0) (2026-11-20)\n\n### Features\n\n* a thing ([#1](https://github.com/Ferdinand99/Sylo/issues/1))\n',
};

let githubCalls = 0;
function useService({ withWren = true } = {}) {
  githubCalls = 0;
  const checker = createUpdateChecker({
    version: '5.2.0',
    fetchImpl: async () => {
      githubCalls++;
      return new Response(JSON.stringify(RELEASE), { status: 200 });
    },
  });
  setUpdateService(
    createUpdateService({
      checker,
      wren: withWren ? createWrenClient({ url: wren.url, token: FAKE_TOKEN, targetId: wren.targetId }) : null,
    })
  );
}

// Everything the app logs or prints while the tests run, to prove the token stays out of it.
const output = [];
for (const name of ['log', 'error', 'warn', 'info']) {
  const original = console[name];
  console[name] = (...args) => {
    output.push(args.map(String).join(' '));
    original.apply(console, args);
  };
}

const operator = await session({ discordId: OPERATOR_ID });
const admin = await session({ discordId: '333333333333330077', guilds: [{ id: D_GUILD, owner: true }] });
const signedOut = anonymous();

const ROUTES = [
  ['get', '/update'],
  ['get', '/update/wren/runs/12'],
  ['post', '/update/wren/approve'],
];

test('a server admin and a signed-out visitor are refused every update route', async () => {
  useService();
  for (const [method, path] of ROUTES) {
    const res = await admin[method](path);
    assert.equal(res.status, 403, `admin ${method} ${path}`);
    assert.match((await res.json()).error, /operators/);
    const out = await signedOut[method](path);
    // A POST without a session fails the CSRF check before anything else; both are a refusal.
    assert.equal(out.status, method === 'post' ? 403 : 401, `anonymous ${method} ${path}`);
  }
  assert.equal(githubCalls, 0, 'nothing was asked on their behalf');
  assert.equal(wren.requests.length, 0);
});

test('an operator reads the notice: a newer release, its notes, the command, and what Wise Wren sees', async () => {
  useService();
  wren.requests.length = 0;
  const res = await operator.get('/update');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.enabled, true);
  assert.equal(body.available, true);
  assert.equal(body.latest, '99.0.0');
  assert.equal(body.command, 'docker compose pull && docker compose up -d');
  assert.equal(body.notes.sections[0].items[0].text, 'A thing');
  assert.equal(body.wren.updateSeen, true);
  assert.equal(body.wren.canApprove, true);
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, new RegExp(FAKE_TOKEN));
  assert.doesNotMatch(text, /127\.0\.0\.1/);
});

test('without Wise Wren the notice still works and approving is a 404', async () => {
  useService({ withWren: false });
  const body = await (await operator.get('/update')).json();
  assert.equal(body.wren, null);
  assert.equal(body.available, true);
  const res = await operator.post('/update/wren/approve');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'wren_off');
});

test('?refresh=1 asks GitHub again, with a budget of its own', async () => {
  useService({ withWren: false });
  await operator.get('/update');
  await operator.get('/update');
  assert.equal(githubCalls, 1, 'the cache answers the second read');
  assert.equal((await operator.get('/update?refresh=1')).status, 200);
  assert.equal(githubCalls, 2);
  let limited = 0;
  for (let i = 0; i < 8; i++) if ((await operator.get('/update?refresh=1')).status === 429) limited++;
  assert.ok(limited >= 1, 'too many re-checks are refused');
});

test('a write needs the CSRF token, like every other operator write', async () => {
  useService();
  const b = browser();
  const { signIn, setProfiles } = await import('./helpers/oauthApp.js');
  setProfiles({ discordId: OPERATOR_ID });
  await signIn(b, 'discord');
  const res = await b.get('/api/v2/update/wren/approve', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /CSRF/i);
  assert.equal(wren.requests.filter((r) => r.method === 'POST').length, 0);
});

test('Update now: approves the version Wren shows, records who asked, and the run can be followed', async () => {
  useService();
  wren.requests.length = 0;
  const res = await operator.post('/update/wren/approve');
  assert.equal(res.status, 200);
  const started = await res.json();
  assert.deepEqual(Object.keys(started).sort(), ['from', 'runId', 'status']);
  assert.equal(started.from, '5.2.0');
  assert.equal(started.status, 'queued');
  assert.deepEqual(JSON.parse(wren.requests.find((r) => r.method === 'POST').body), {
    version_key: 'sylo=sha256:4f90abcd',
  });

  const audit = (await listBotAudit(5)).find((a) => a.action === 'update:approve');
  assert.ok(audit, 'an audit entry');
  assert.match(audit.detail, new RegExp(`run ${started.runId}`));
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(FAKE_TOKEN));

  const run = wren.state.runs.get(started.runId);
  run.status = 'running';
  run.steps = [{ step: 'stop', status: 'running', duration_ms: null, log: 'secret path /mnt/user/appdata' }];
  const progress = await (await operator.get(`/update/wren/runs/${started.runId}`)).json();
  assert.equal(progress.readable, true);
  assert.equal(progress.run.status, 'running');
  assert.equal(progress.run.finished, false);
  assert.deepEqual(progress.run.steps, [{ step: 'stop', status: 'running', durationMs: null }]);
  assert.doesNotMatch(JSON.stringify(progress), /secret path/);

  // The page can still follow it when Sylo is back: the status names the active run too.
  const status = await (await operator.get('/update')).json();
  assert.equal(status.wren.latestRun.id, started.runId);
  assert.equal(status.wren.canApprove, false);
});

test("a run that is not this target's, an unknown run and a junk id are 404s", async () => {
  useService();
  wren.state.runs.set(500, {
    id: 500,
    target: { id: 99, kind: 'container', name: 'other' },
    status: 'running',
    steps: [],
  });
  assert.equal((await operator.get('/update/wren/runs/500')).status, 404);
  assert.equal((await operator.get('/update/wren/runs/424242')).status, 404);
  assert.equal((await operator.get('/update/wren/runs/abc')).status, 404);
  assert.equal((await operator.get('/update/wren/runs/1;rm')).status, 404);
  assert.equal((await operator.get('/update/wren/runs/0')).status, 404);
  // Only numeric ids ever reach Wren.
  assert.ok(
    wren.requests
      .filter((r) => r.url.startsWith('/api/v1/runs/'))
      .every((r) => /^\/api\/v1\/runs\/\d+$/.test(r.url))
  );
});

test('Wise Wren refusing is shown as its words with a 409; a wrong token is a 502, never a 401', async () => {
  useService();
  wren.state.runs.clear();
  wren.state.target.effective_mode = 'notify';
  let res = await operator.post('/update/wren/approve');
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /only notifies/);
  wren.state.target.effective_mode = 'approve';

  setUpdateService(
    createUpdateService({
      checker: createUpdateChecker({
        version: '5.2.0',
        fetchImpl: async () => new Response(JSON.stringify(RELEASE)),
      }),
      wren: createWrenClient({ url: wren.url, token: 'ww_not_the_right_token', targetId: wren.targetId }),
    })
  );
  res = await operator.post('/update/wren/approve');
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.code, 'wren_unauthorized');
  assert.doesNotMatch(JSON.stringify(body), /ww_not_the_right_token/);
  useService();
});

test('the approve route has a small budget: the sixth request in a minute is refused', async () => {
  useService();
  wren.state.runs.clear();
  // Earlier tests used some of the budget; keep going until it is used up, which must happen within five.
  let first429 = -1;
  for (let i = 0; i < 6; i++) {
    const res = await operator.post('/update/wren/approve');
    if (res.status === 429) {
      first429 = i;
      break;
    }
    // A run is waiting after the first approval, so the next ones are refused as conflicts (409): they
    // still count against the budget.
    assert.ok([200, 409].includes(res.status), `status ${res.status}`);
  }
  assert.ok(first429 >= 0 && first429 <= 5, 'rate limited');
});

test('the Wise Wren token is in no log line the app wrote', () => {
  for (const line of output) {
    assert.ok(!line.includes(FAKE_TOKEN), 'token found in a log line');
    assert.ok(!line.includes('ww_not_the_right_token'), 'wrong token found in a log line');
  }
});
