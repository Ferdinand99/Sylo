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

test(
  'dbRole queries tell a role without extra rights from one that has them',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { ROLE_QUERIES, privilegesFromRow, roleRisks } = await import('../src/db/dbRole.js');
    const postgres = (await import('postgres')).default;
    const admin = postgres(url);
    t.after(() => admin.end({ timeout: 1 }));
    const [me] =
      await admin`SELECT current_user AS name, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user`;
    if (!me.rolsuper && !me.rolcreaterole) return t.skip('the test role cannot create roles');

    const role = 'sylo_test_lowpriv';
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'lowpriv' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    const asRole = new URL(url);
    asRole.username = role;
    asRole.password = 'lowpriv';
    const ask = async () => {
      const low = postgres(asRole.toString());
      try {
        return privilegesFromRow((await low.unsafe(ROLE_QUERIES.full))[0]);
      } finally {
        await low.end({ timeout: 1 });
      }
    };
    try {
      assert.deepEqual(roleRisks(await ask()), [], 'a plain login role has no extra rights');

      await admin.unsafe(`GRANT pg_execute_server_program TO ${role}`);
      assert.deepEqual(roleRisks(await ask()), ['pg_execute_server_program']);

      if (me.rolsuper) {
        // It is not a superuser itself, but may become one.
        await admin.unsafe(`GRANT ${me.name} TO ${role}`);
        assert.ok(roleRisks(await ask()).includes('membership of a superuser role'));
      }
      await admin.unsafe(`ALTER ROLE ${role} CREATEDB`);
      assert.ok(roleRisks(await ask()).includes('CREATEDB'));
    } finally {
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
  }
);
