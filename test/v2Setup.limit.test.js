// The setup wizard's apply route: a body that names nothing usable is a 400, and one server and person
// may run it six times in ten minutes (it can create channels and roles on the platform).
import { startWebApp } from './helpers/webApp.js';
import { v2Open } from './helpers/v2Open.js';
import { GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { listAudit } from '../src/db/audit.js';

let app;
let api;
test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
});
test.after(() => app.close());

test('a body that names an unknown item, a repeated item or nothing is a 400, and nothing is made', async () => {
  for (const body of [
    {},
    { items: [] },
    { items: [{ id: 'not-a-module' }] },
    { items: [{ id: 'welcome' }, { id: 'welcome' }] },
    { items: 'welcome' },
  ]) {
    assert.equal((await api.post('/setup/apply', body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(app.sink.created, []);
  assert.deepEqual(await listAudit(GID, 10), []);
});

test('the seventh run in ten minutes is refused with a 429', async () => {
  // Five runs are spent above; one more is allowed, the next is not.
  const res = await api.post('/setup/apply', { items: [] });
  assert.equal(res.status, 400);
  const limited = await api.post('/setup/apply', { items: [] });
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /ran several times/);
});
