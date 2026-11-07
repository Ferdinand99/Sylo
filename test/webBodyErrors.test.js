// A request the client got wrong (a body over the cap, broken JSON) is the client's doing, not a
// server fault. Anyone can send those for free, so they must never become log.error events: each
// one would reach the dev-log channel, operators' phones, /health and the error report sink.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startWebApp } from './helpers/webApp.js';
import { addDevLogSink, _clearDevLogSinks } from '../src/lib/devLog.js';
import { runtime } from '../src/runtime.js';
import { routeLabel } from '../src/web/server.js';

const json = { 'content-type': 'application/json' };

/** Collect every dev-log event and every console line while `fn` runs. */
async function observe(fn) {
  const events = [];
  const lines = [];
  addDevLogSink((e) => events.push(e));
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a) => lines.push(a.join(' '));
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.error = origErr;
    console.log = origLog;
    _clearDevLogSinks();
  }
  return { events, lines };
}

test('malformed and oversized bodies answer 4xx and raise no error-level event', async () => {
  const app = await startWebApp();
  try {
    const errorsBefore = runtime.errors.length;
    const big = JSON.stringify({ pad: 'x'.repeat(300 * 1024) });
    const secretToken = 'tok-' + 'a1b2c3d4'.repeat(6);
    const statuses = [];
    const { events, lines } = await observe(async () => {
      for (let i = 0; i < 20; i++) {
        const broken = await fetch(`${app.base}/api/v2/csrf-${i}`, {
          method: 'POST',
          headers: json,
          body: '{',
        });
        statuses.push(['broken', broken.status]);
        const large = await fetch(`${app.base}/api/v2/csrf-${i}`, {
          method: 'POST',
          headers: json,
          body: big,
        });
        statuses.push(['large', large.status]);
        const form = await fetch(`${app.base}/x${i}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'a=' + 'y'.repeat(300 * 1024),
        });
        statuses.push(['form', form.status]);
      }
      // The GitHub webhook has its own raw parser: over its 1 MB cap is a 413 as well.
      const gh = await fetch(`${app.base}/webhooks/github/${secretToken}`, {
        method: 'POST',
        headers: json,
        body: 'z'.repeat(1_200_000),
      });
      statuses.push(['github', gh.status]);
    });

    for (const [kind, status] of statuses) {
      assert.equal(status, kind === 'broken' ? 400 : 413, kind);
    }
    assert.equal(
      events.filter((e) => e.level === 'error').length,
      0,
      'no error-level dev-log event for client mistakes'
    );
    assert.equal(runtime.errors.length, errorsBefore, 'nothing added to the /health error history');
    assert.ok(
      !lines.some((l) => l.includes(secretToken)),
      'the webhook URL token never appears in any log line'
    );
  } finally {
    app.close();
  }
});

test('a real server fault is still logged, by route pattern and not by raw path', async () => {
  const label = routeLabel({ baseUrl: '/api/v2/guilds/123456789012345678', route: { path: '/modules/:id' } });
  assert.equal(label, '/api/v2/guilds/:id/modules/:id');
  assert.equal(
    routeLabel({ baseUrl: '/webhooks/github', route: { path: '/:token' } }),
    '/webhooks/github/:token'
  );
  assert.equal(routeLabel({ baseUrl: '', route: undefined }), '(unmatched)');
  // A token-shaped mount segment is masked.
  assert.ok(!routeLabel({ baseUrl: '/x/9f8e7d6c5b4a', route: { path: '/y' } }).includes('9f8e7d6c'));
});

test('a flood of junk requests is rate limited before the body parsers run', async () => {
  const app = await startWebApp();
  try {
    let limited = 0;
    for (let i = 0; i < 330; i++) {
      const res = await fetch(`${app.base}/api/v2/junk-${i}`, { method: 'POST', headers: json, body: '{' });
      if (res.status === 429) limited++;
      else assert.equal(res.status, 400);
    }
    assert.ok(limited >= 20, `expected 429s after the ceiling, got ${limited}`);
  } finally {
    app.close();
  }
});
