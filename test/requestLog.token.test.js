// The GitHub webhook's URL token is a credential: even the debug request log must not print it.
process.env.LOG_LEVEL = 'debug';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
const { requestLog } = await import('../src/web/middleware/requestLog.js');

test('the debug request log masks the GitHub webhook token', () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const res = Object.assign(new EventEmitter(), { statusCode: 401 });
    requestLog({ originalUrl: '/webhooks/github/s3cr3ttoken?x=1', method: 'POST' }, res, () => {});
    res.emit('finish');
  } finally {
    console.log = orig;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /POST \/webhooks\/github\/:token 401/);
  assert.ok(!lines[0].includes('s3cr3ttoken'));
});
