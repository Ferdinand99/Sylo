// The role check against a real Postgres connection. Skipped without DATABASE_URL.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres, prepare } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'dbRole reads the privileges of the connected role and warns once',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { checkDatabaseRole, readRolePrivileges, lastRolePrivileges, roleRisks } =
      await import('../src/db/dbRole.js');
    t.after(async () => {
      await closePostgres();
    });

    const direct = await prepare(
      'SELECT current_user AS name, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user'
    ).get();
    const read = await readRolePrivileges();
    assert.equal(read.name, direct.name);
    assert.equal(read.superuser, direct.rolsuper === true);
    assert.equal(read.createRole, direct.rolcreaterole === true);
    assert.equal(read.createDb, direct.rolcreatedb === true);
    for (const key of ['execProgram', 'readFiles', 'writeFiles']) assert.equal(typeof read[key], 'boolean');
    if (read.superuser) {
      // A superuser is a member of every predefined role.
      assert.deepEqual([read.execProgram, read.readFiles, read.writeFiles], [true, true, true]);
    }

    const warned = [];
    await checkDatabaseRole({ warn: (scope, msg) => warned.push([scope, msg]) });
    assert.equal(lastRolePrivileges().name, read.name);
    assert.equal(warned.length, roleRisks(read).length > 0 ? 1 : 0);
    if (warned.length) assert.match(warned[0][1], /docs\/postgres\.md#least-privilege-database-role/);
  }
);
