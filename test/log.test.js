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
