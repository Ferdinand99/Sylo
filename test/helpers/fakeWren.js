// A fake Wise Wren (its REST API v1, only the routes Sylo uses) on a free local port, for the update
// notice's tests. It checks the bearer token like the real one and records every request, so a test can
// assert what Sylo sent (and that the token went nowhere else).
import { createServer } from 'node:http';

export const FAKE_TOKEN = 'ww_test_secret_token_0123456789';

/**
 * @param {{ targetId?: number, token?: string }} [opts]
 */
export async function startFakeWren({ targetId = 7, token = FAKE_TOKEN } = {}) {
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
  };
  /** @type {{ method: string, url: string, headers: Record<string, string>, body: string }[]} */
  const requests = [];

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'Unauthorized' });
      const url = new URL(req.url, 'http://x');
      const key =
        req.method === 'GET' && url.pathname === `/api/v1/targets/${targetId}`
          ? 'GET target'
          : req.method === 'POST' && url.pathname === `/api/v1/targets/${targetId}/approve`
            ? 'POST approve'
            : req.method === 'GET' && /^\/api\/v1\/runs\/\d+$/.test(url.pathname)
              ? 'GET run'
              : req.method === 'GET' && url.pathname === '/api/v1/runs'
                ? 'GET runs'
                : null;
      if (!key) return json(res, 404, { error: 'not found' });
      const forced = state.force[key];
      if (forced) return json(res, forced[0], forced[1], forced[2]);
      if (key === 'GET target') return json(res, 200, state.target);
      if (key === 'POST approve') {
        const sent = body ? JSON.parse(body) : {};
        if (sent.version_key && sent.version_key !== state.target.version_key) {
          return json(res, 409, { error: 'A newer version appeared; approve the one you see now.' });
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
        const run = state.runs.get(Number(url.pathname.split('/').pop()));
        return run ? json(res, 200, run) : json(res, 404, { error: 'no such run' });
      }
      // GET runs
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
