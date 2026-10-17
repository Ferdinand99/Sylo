// Request metrics are labelled by route. The label must come from a fixed set: a label per
// random path would add a new counter for every request an anonymous client makes, kept
// forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { requestLog } from '../src/web/middleware/requestLog.js';
import { byMetric, reset } from '../src/lib/metrics.js';

function request(path, status) {
  const res = Object.assign(new EventEmitter(), { statusCode: status });
  requestLog({ originalUrl: path, method: 'GET' }, res, () => {});
  res.emit('finish');
}

test('unknown paths share one label', () => {
  reset();
  for (let i = 0; i < 50; i++) request(`/random${i}`, 404);
  request('/guilds/123/overview', 200);
  const routes = new Set(byMetric('sylo_http_requests_total').map((c) => c.labels.route));
  assert.deepEqual([...routes].sort(), ['/guilds', 'other']);
});
