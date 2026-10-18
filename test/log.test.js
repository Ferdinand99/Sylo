import test from 'node:test';
import assert from 'node:assert/strict';
import { log } from '../src/lib/log.js';
import { runtime } from '../src/runtime.js';

/** Capture console.log / console.error for the duration of `fn`. */
function capture(fn) {
  const lines = { out: [], err: [] };
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => lines.out.push(a.join(' '));
  console.error = (...a) => lines.err.push(a.join(' '));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return lines;
}

test('log.info writes one timestamped, levelled, scoped line to stdout', () => {
  const { out, err } = capture(() => log.info('db', 'hello world'));
  assert.equal(out.length, 1);
  assert.equal(err.length, 0);
  assert.match(out[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+INFO\s+db\s+hello world$/);
});

test('log.debug is suppressed at the default (info) level', () => {
  const { out, err } = capture(() => log.debug('x', 'noisy'));
  assert.equal(out.length + err.length, 0);
});

test('log.warn / log.error go to stderr and unwrap a trailing Error', () => {
  const { out, err } = capture(() => log.error('bot', 'command failed:', new Error('boom')));
  assert.equal(out.length, 0);
  assert.equal(err.length, 1);
  assert.match(err[0], /ERROR\s+bot\s+command failed: boom/);
});

test('log.error records the event in the /health error history', () => {
  const before = runtime.errors.length;
  log.error('twitch-alerts', 'poll failed', new Error('429'));
  assert.equal(runtime.errors.length, before + 1);
  assert.equal(runtime.errors[0].scope, 'twitch-alerts');
  assert.match(runtime.errors[0].message, /429/);
  assert.equal(runtime.lastError.message, runtime.errors[0].message);
});

test('extra string args are appended to the message', () => {
  const { out } = capture(() => log.info('web', 'listening on', 3000));
  assert.match(out[0], /web\s+listening on 3000$/);
});

// A connection URL with a password (a failed pg_dump, a feed URL with credentials) must not
// reach the console, the /health error list or the dev-log channel in clear text.
test('passwords in URLs are redacted everywhere a log line goes', () => {
  const lines = capture(() =>
    log.error(
      'backup',
      'failed',
      new Error('Command failed: pg_dump postgres://sylo:hunter2@db:5432/sylo -Fc')
    )
  );
  assert.doesNotMatch(lines.err.join('\n'), /hunter2/);
  assert.match(lines.err.join('\n'), /postgres:\/\/sylo:\*\*\*@db/);
  assert.doesNotMatch(runtime.errors[0].message, /hunter2/);
});

// Warnings go to the dev log too (stored, and pushed to operators who chose warnings); only
// errors go to the /health error list and the dev-log channel.
test('log.warn and log.error reach the dev log', async () => {
  const { addDevLogSink, _clearDevLogSinks, _resetDevLogThrottle } = await import('../src/lib/devLog.js');
  _clearDevLogSinks();
  _resetDevLogThrottle();
  const seen = [];
  addDevLogSink((e) => seen.push([e.level, e.scope]));
  capture(() => {
    log.warn('relay', 'slow answer');
    log.error('db', 'gone');
    log.info('web', 'listening');
  });
  assert.deepEqual(seen, [
    ['warn', 'relay'],
    ['error', 'db'],
  ]);
  _clearDevLogSinks();
});
