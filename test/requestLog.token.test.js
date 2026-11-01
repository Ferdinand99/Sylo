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

test('the debug request log masks the address of a public event page', () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    for (const url of [
      '/events/0123456789abcdef0123456789abcdef',
      '/events/0123456789abcdef0123456789abcdef?utm=1',
      '/EVENTS/0123456789abcdef0123456789abcdef',
    ]) {
      const res = Object.assign(new EventEmitter(), { statusCode: 200 });
      requestLog({ originalUrl: url, method: 'GET' }, res, () => {});
      res.emit('finish');
    }
  } finally {
    console.log = orig;
  }
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.match(line, /GET \/events\/:token 200/i);
    assert.ok(!line.includes('0123456789abcdef'));
  }
});
