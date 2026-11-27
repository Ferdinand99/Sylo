// A fake Wise Wren (its REST API v1, only the routes Sylo uses) on a free local port, for the update
// notice's tests. It answers like the real one:
//   - every error is vole-kit's `{"error": {"code", "message"}}`;
//   - an approval Wren refuses is a 400 (the version key changed, a run is already queued or running, the
//     target only notifies, there is no update), and a 409 only when the agent would refuse the target
//     (`blocked_reason`);
//   - a second approval while a run is queued or running is refused;
//   - with `targetToken: true` it behaves for a single-target token: only GET /targets/{id}, POST
//     /targets/{id}/approve and GET /runs/{id} of its own target, and everything else (the run list, other
//     targets and runs) is a 403.
// It checks the bearer token and records every request, so a test can assert what Sylo sent (and that the
// token went nowhere else).
import { createServer } from 'node:http';

export const FAKE_TOKEN = 'ww_test_secret_token_0123456789';

const ACTIVE = new Set(['queued', 'running']);

/**
 * @param {{ targetId?: number, token?: string, targetToken?: boolean }} [opts]
 */
export async function startFakeWren({ targetId = 7, token = FAKE_TOKEN, targetToken = false } = {}) {
  /** What the next answers are; a test changes these. */
  const state = {
    target: {
      id: targetId,
      server: { id: 1, name: 'LANBox' },
      kind: 'compose',
      name: 'sylo',
      status: 'update',
      version_key: 'sylo=sha256:4f90abcd',
      installed_version: '5.2.0',
      latest_version: '5.3.0',
      effective_mode: 'approve',
      blocked_reason: null,
      skipped: false,
      snoozed_until: null,
      last_checked_at: '2026-11-16 10:00:00',
    },
    /** Run id → run (with steps) */
    runs: new Map(),
    nextRunId: 12,
    /** Force an answer for a route key ("GET target", "POST approve", "GET run", "GET runs"): [status, body, headers]. */
    force: {},
    /** Delay every answer by this long (ms). */
    delayMs: 0,
    /** Mode for a token limited to one target (a test may flip it). */
    targetToken,
  };
  /** @type {{ method: string, url: string, headers: Record<string, string>, body: string }[]} */
  const requests = [];

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const fail = (res, status, code, message) => json(res, status, { error: { code, message } });

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (req.headers.authorization !== `Bearer ${token}`) {
        return fail(res, 401, 'unauthorized', 'Not signed in.');
      }
      const url = new URL(req.url, 'http://x');
      const target = /^\/api\/v1\/targets\/(\d+)(\/approve)?$/.exec(url.pathname);
      const runPath = /^\/api\/v1\/runs\/(\d+)$/.exec(url.pathname);
      const key =
        req.method === 'GET' && target && !target[2]
          ? 'GET target'
          : req.method === 'POST' && target && target[2]
            ? 'POST approve'
            : req.method === 'GET' && runPath
              ? 'GET run'
              : req.method === 'GET' && url.pathname === '/api/v1/runs'
                ? 'GET runs'
                : null;
      if (!key) return fail(res, 404, 'not_found', 'Not found.');
      const forced = state.force[key];
      if (forced) return json(res, forced[0], forced[1], forced[2]);

      // A token limited to one target: the list and every other target are refused.
      if (state.targetToken) {
        if (key === 'GET runs') return fail(res, 403, 'forbidden', 'This token is not allowed here.');
        if (target && Number(target[1]) !== targetId) {
          return fail(res, 403, 'forbidden', 'This token is not allowed for that target.');
        }
      } else if (target && Number(target[1]) !== targetId) {
        return fail(res, 404, 'not_found', 'Not found.');
      }

      if (key === 'GET target') return json(res, 200, state.target);
      if (key === 'POST approve') {
        const sent = body ? JSON.parse(body) : {};
        const t = state.target;
        if (t.blocked_reason) {
          return fail(res, 409, 'conflict', `The agent would refuse this update: ${t.blocked_reason}.`);
        }
        if (t.effective_mode === 'notify') {
          return fail(
            res,
            400,
            'bad_request',
            'This target is notify-only: Wren only tells you about new versions.'
          );
        }
        if (t.status !== 'update') return fail(res, 400, 'bad_request', 'There is no update to approve.');
        if ([...state.runs.values()].some((r) => r.target.id === targetId && ACTIVE.has(r.status))) {
          return fail(res, 400, 'bad_request', 'An update of this target is already queued or running.');
        }
        if (sent.version_key && sent.version_key !== t.version_key) {
          return fail(
            res,
            400,
            'bad_request',
            'The version changed since you looked; reload and approve the new one.'
          );
        }
        const id = state.nextRunId++;
        state.runs.set(id, {
          id,
          server: { id: 1, name: 'LANBox' },
          target: { id: targetId, kind: 'compose', name: 'sylo' },
          kind: 'update',
          status: 'queued',
          detail: '',
          version: '5.3.0',
          created_at: '2026-11-16 10:01:00',
          started_at: null,
          finished_at: null,
          steps: [],
        });
        return json(res, 200, { run_id: id, status: 'queued' });
      }
      if (key === 'GET run') {
        const run = state.runs.get(Number(runPath[1]));
        if (!run) return fail(res, 404, 'not_found', 'Not found.');
        if (state.targetToken && run.target.id !== targetId) {
          return fail(res, 403, 'forbidden', 'This token is not allowed for that run.');
        }
        return json(res, 200, run);
      }
      // GET runs (a plain write token only)
      const list = [...state.runs.values()]
        .filter((r) => String(r.target.id) === url.searchParams.get('target_id'))
        .sort((a, b) => b.id - a.id)
        .slice(0, Number(url.searchParams.get('limit') ?? 50))
        .map(({ steps: _steps, ...r }) => r);
      return json(res, 200, { runs: list });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    targetId,
    state,
    requests,
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}
