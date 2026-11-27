// The restore route on a Postgres deployment: an uploaded dump needs its name and the
// acknowledgement that its SQL runs with the database role's rights. Skipped without DATABASE_URL.
// config.js reads DATABASE_URL once at import, so this is the only place the Postgres rules can be
// tested through the route. Nothing is restored: with both fields the request gets past the
// confirmation and stops at the dump check (the file is not a dump), and a real restore would
// end the process.
import './helpers/isolateSqlite.js';
import './helpers/openMode.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.DATABASE_URL;

test(
  'restoring an uploaded dump through the route needs confirm and acknowledgeSql on Postgres',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { runtime } = await import('../src/runtime.js');
    const { createApp } = await import('../src/web/server.js');
    const { fakeGuild, makeSink } = await import('./helpers/fakeGuild.js');
    const { backupDir } = await import('../src/db/backup.js');
    const { closePostgres } = await import('../src/db/driver.js');

    runtime.client = fakeGuild({ sink: makeSink() }).client;
    const server = await new Promise((resolve) => {
      const s = createApp().listen(0, () => resolve(s));
    });
    const imported = 'sylo-imported-2026-11-16-10-00-00-000.dump';
    const own = 'sylo-manual-2026-11-16-10-00-00-001.dump';
    const files = [join(backupDir(), imported), join(backupDir(), own)];
    for (const f of files) writeFileSync(f, 'PGDMP not a real dump');
    t.after(async () => {
      for (const f of files) rmSync(f, { force: true });
      server.closeAllConnections?.();
      server.close();
      runtime.client = null;
      await closePostgres();
    });

    const base = `http://127.0.0.1:${server.address().port}/api/v2/health/backups`;
    const restore = (name, body) =>
      fetch(`${base}/${name}/restore`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const error = async (res) => (await res.json()).error;

    for (const body of [undefined, {}, { acknowledgeSql: true }]) {
      const res = await restore(imported, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(await error(res), /needs \{ "confirm"/);
    }
    for (const ack of [undefined, false, 'true', 1]) {
      const res = await restore(imported, { confirm: imported, acknowledgeSql: ack });
      assert.equal(res.status, 400, String(ack));
      assert.match(await error(res), /acknowledgeSql/);
    }
    const wrong = await restore(imported, { confirm: own, acknowledgeSql: true });
    assert.equal(wrong.status, 400);
    assert.match(await error(wrong), /name of the snapshot/);

    // Both fields: past the confirmation, stopped by the dump check (it is not a dump).
    const both = await restore(imported, { confirm: imported, acknowledgeSql: true });
    assert.equal(both.status, 400);
    const message = await error(both);
    assert.doesNotMatch(message, /acknowledgeSql|confirm/);
    assert.ok(existsSync(files[0]), 'nothing was restored or removed');

    // A snapshot Sylo made itself needs no body (the app sends none): also stopped by the dump check.
    const plain = await restore(own);
    assert.equal(plain.status, 400);
    assert.doesNotMatch(await error(plain), /acknowledgeSql|confirm/);
  }
);
