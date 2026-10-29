// Open mode (no login) answers only on local hosts and on the DASHBOARD_URL host. The WebSub hub
// calls the DASHBOARD_URL host, so its requests pass that refusal without the route being mounted
// ahead of it. This file runs with the real config: a public https DASHBOARD_URL, no login.
import './helpers/tmpDb.js';
import './helpers/openMode.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DASHBOARD_URL = 'https://sylo.example.com';
const { startWebApp } = await import('./helpers/webApp.js');
const { config } = await import('../src/config.js');
const { subscribe, topicUrl, websubEnabled } = await import('../src/modules/youtubeWebsub.js');

const realFetch = globalThis.fetch;
const channelId = 'UC' + 'o'.repeat(22);

/** A request with a chosen Host header (fetch will not set one). */
function requestWithHost(base, path, host, { method = 'GET', body } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: { host, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('open mode: the hub (Host = the DASHBOARD_URL host) gets through the host refusal, other hosts do not', async () => {
  assert.equal(config.authEnabled, false, 'open mode');
  assert.equal(config.dashboardUrl, 'https://sylo.example.com');
  assert.equal(websubEnabled(), true);
  globalThis.fetch = async (url, init) =>
    String(url).includes('pubsubhubbub') ? { ok: true, status: 202 } : realFetch(url, init);
  const app = await startWebApp();
  try {
    assert.equal(await subscribe(channelId), true);
    const path = `/webhooks/youtube/${channelId}?hub.mode=subscribe&hub.topic=${encodeURIComponent(topicUrl(channelId))}&hub.challenge=hi`;

    const hub = await requestWithHost(app.base, path, 'sylo.example.com');
    assert.equal(hub.status, 200);
    assert.equal(hub.text, 'hi');
    const post = await requestWithHost(app.base, `/webhooks/youtube/${channelId}`, 'sylo.example.com', {
      method: 'POST',
      body: '<feed/>',
    });
    assert.equal(post.status, 204, 'reaches the route (unsigned, so acknowledged and ignored)');

    // Any other name is refused before the route, as for the rest of the dashboard.
    assert.equal((await requestWithHost(app.base, path, 'evil.example.net')).status, 403);
    assert.equal((await requestWithHost(app.base, path, 'sylo.example.com.evil.net')).status, 403);
  } finally {
    app.close();
    globalThis.fetch = realFetch;
  }
});
