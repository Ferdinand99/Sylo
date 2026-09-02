import test from 'node:test';
import assert from 'node:assert/strict';
import { inc, peek, byMetric, renderCounters, reset } from '../src/lib/metrics.js';

test.beforeEach(() => reset());

test('inc accumulates per name+label set', () => {
  inc('sylo_commands_total', { command: 'ping' });
  inc('sylo_commands_total', { command: 'ping' });
  inc('sylo_commands_total', { command: 'ban' });
  assert.equal(peek('sylo_commands_total', { command: 'ping' }), 2);
  assert.equal(peek('sylo_commands_total', { command: 'ban' }), 1);
  assert.equal(peek('sylo_commands_total', { command: 'never' }), 0);
});

test('inc accepts an explicit step and a label-free series', () => {
  inc('sylo_widgets_total', {}, 5);
  inc('sylo_widgets_total');
  assert.equal(peek('sylo_widgets_total'), 6);
});

test('label order does not create a second series', () => {
  inc('x_total', { a: '1', b: '2' });
  inc('x_total', { b: '2', a: '1' });
  assert.equal(byMetric('x_total').length, 1);
  assert.equal(peek('x_total', { a: '1', b: '2' }), 2);
});

test('byMetric returns every series for one name', () => {
  inc('sylo_errors_total', { scope: 'bot' });
  inc('sylo_errors_total', { scope: 'web' }, 3);
  const rows = byMetric('sylo_errors_total').sort((a, b) => a.labels.scope.localeCompare(b.labels.scope));
  assert.deepEqual(
    rows.map((r) => [r.labels.scope, r.value]),
    [
      ['bot', 1],
      ['web', 3],
    ]
  );
});

test('renderCounters emits a TYPE header and sorted series, once per name', () => {
  inc('sylo_commands_total', { command: 'ping' }, 2);
  inc('sylo_commands_total', { command: 'ban' });
  inc('sylo_errors_total', { scope: 'bot' });

  const text = renderCounters();
  assert.match(text, /^# TYPE sylo_commands_total counter$/m);
  assert.match(text, /^# TYPE sylo_errors_total counter$/m);
  assert.equal(text.match(/# TYPE sylo_commands_total counter/g).length, 1);
  assert.match(text, /sylo_commands_total\{command="ban"\} 1/);
  assert.match(text, /sylo_commands_total\{command="ping"\} 2/);
  assert.ok(text.endsWith('\n'));

  // "ban" sorts before "ping" within the metric block
  assert.ok(text.indexOf('command="ban"') < text.indexOf('command="ping"'));
});

test('renderCounters is empty until something is counted', () => {
  assert.equal(renderCounters(), '');
});

test('label values with quotes or backslashes are escaped', () => {
  inc('sylo_commands_total', { command: 'we"ird\\one' });
  assert.match(renderCounters(), /command="we\\"ird\\\\one"/);
});
