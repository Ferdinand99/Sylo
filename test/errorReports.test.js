import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEvent,
  flushErrorReports,
  parseStack,
  reportError,
  startErrorReports,
  stopErrorReports,
} from '../src/lib/errorReports.js';
import { log } from '../src/lib/log.js';

const DSN = 'https://f2fc9af6af5b9a27f83ada533611e407@kestrel.example.com/2';

/** A stand-in for fetch that records each request and answers `status`. */
function fakeSend(status = 200, headers = {}) {
  const requests = [];
  const send = async (url, init) => {
    requests.push({ url, init });
    return { status, headers: new Headers(headers) };
  };
  return { send, requests };
}

/** The event inside a recorded envelope. */
const eventOf = (req) => JSON.parse(req.init.body.trim().split('\n')[2]);

test('without a DSN nothing is sent', async (t) => {
  t.after(stopErrorReports);
  const { send, requests } = fakeSend();
  assert.equal(startErrorReports({ dsn: null, send }), false);
  reportError(new Error('x'), 'rss');
  await flushErrorReports(10);
  assert.equal(requests.length, 0);
});

test('a malformed DSN is refused', (t) => {
  t.after(stopErrorReports);
  assert.equal(startErrorReports({ dsn: 'https://kestrel.example.com/2' }), false);
});

test('log.error sends a Sentry envelope with the scope and the stack', async (t) => {
  t.after(stopErrorReports);
  const { send, requests } = fakeSend();
  assert.equal(startErrorReports({ dsn: DSN, environment: 'test', send }), true);

  log.error('rss', 'Feed failed', new Error('ECONNREFUSED', { cause: new TypeError('fetch failed') }));
  log.warn('rss', 'only a warning');
  await flushErrorReports(1000);

  assert.equal(requests.length, 1, 'warnings are not reported');
  const [req] = requests;
  assert.equal(req.url, 'https://kestrel.example.com/api/2/envelope/');
  assert.equal(req.init.headers['content-type'], 'application/x-sentry-envelope');
  assert.match(req.init.headers['x-sentry-auth'], /sentry_key=f2fc9af6af5b9a27f83ada533611e407/);

  const [header, item] = req.init.body.split('\n').map((l) => (l ? JSON.parse(l) : null));
  const event = eventOf(req);
  assert.equal(header.event_id, event.event_id);
  assert.deepEqual(item, { type: 'event' });
  assert.match(event.event_id, /^[0-9a-f]{32}$/);
  assert.equal(event.environment, 'test');
  assert.match(event.release, /^sylo@\d+\.\d+\.\d+/);
  assert.deepEqual(event.tags, { component: 'bot', scope: 'rss' });
  // The cause first, the logged error last.
  assert.deepEqual(
    event.exception.values.map((v) => [v.type, v.value]),
    [
      ['TypeError', 'fetch failed'],
      ['Error', 'ECONNREFUSED'],
    ]
  );
  const frames = event.exception.values[1].stacktrace.frames;
  const own = frames.at(-1);
  assert.equal(
    own.filename,
    'test/errorReports.test.js',
    'the newest frame is this test, relative to the repo'
  );
  assert.equal(own.in_app, true);
});

test('stack frames: oldest first, node_modules and Node internals not in app', () => {
  const frames = parseStack(
    [
      'Error: boom',
      `    at async handle (${process.cwd()}/src/bot/rss.js:10:5)`,
      `    at Client.emit (${process.cwd()}/node_modules/discord.js/src/client.js:3:9)`,
      '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
    ].join('\n')
  );
  assert.deepEqual(
    frames.map((f) => [f.function, f.filename, f.in_app]),
    [
      ['process.processTicksAndRejections', 'node:internal/process/task_queues', false],
      ['Client.emit', `${process.cwd()}/node_modules/discord.js/src/client.js`, false],
      ['handle', 'src/bot/rss.js', true],
    ]
  );
});

test('a 429 pauses reports for Retry-After seconds', async (t) => {
  t.after(stopErrorReports);
  const { send, requests } = fakeSend(429, { 'retry-after': '120' });
  startErrorReports({ dsn: DSN, send });
  reportError(new Error('one'), 'x');
  await flushErrorReports(1000);
  reportError(new Error('two'), 'x');
  await flushErrorReports(1000);
  assert.equal(requests.length, 1);
});

test('at most 30 reports a minute', async (t) => {
  t.after(stopErrorReports);
  const { send, requests } = fakeSend();
  startErrorReports({ dsn: DSN, send });
  for (let i = 0; i < 40; i += 1) reportError(new Error(`e${i}`), 'loop');
  await flushErrorReports(1000);
  assert.equal(requests.length, 30);
});

test('a failing server never throws into logging', async (t) => {
  t.after(stopErrorReports);
  startErrorReports({
    dsn: DSN,
    send: async () => {
      throw new Error('unreachable');
    },
  });
  reportError(new Error('x'), 'x');
  await flushErrorReports(1000);
  assert.equal(buildEvent(new Error('y'), 's', 'production').level, 'error');
});
