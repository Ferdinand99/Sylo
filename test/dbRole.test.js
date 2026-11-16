// The Postgres role in DATABASE_URL: what counts as more than Sylo needs, and the one warning.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_DOCS_URL,
  checkDatabaseRole,
  readRolePrivileges,
  rolePrivilegeWarning,
  roleRisks,
} from '../src/db/dbRole.js';

const plain = {
  name: 'sylo',
  superuser: false,
  createRole: false,
  createDb: false,
  execProgram: false,
  readFiles: false,
  writeFiles: false,
  superMember: false,
};

test('a role with no extra rights gets no warning', () => {
  assert.deepEqual(roleRisks(plain), []);
  assert.equal(rolePrivilegeWarning(plain), null);
  assert.equal(rolePrivilegeWarning(null), null);
});

test('superuser, CREATEROLE and CREATEDB each warn, naming the right and linking the docs', () => {
  for (const [key, label] of [
    ['superuser', 'SUPERUSER'],
    ['createRole', 'CREATEROLE'],
    ['createDb', 'CREATEDB'],
    ['execProgram', 'pg_execute_server_program'],
    ['readFiles', 'pg_read_server_files'],
    ['writeFiles', 'pg_write_server_files'],
    ['superMember', 'membership of a superuser role'],
  ]) {
    const warning = rolePrivilegeWarning({ ...plain, [key]: true });
    assert.match(warning, new RegExp(label), key);
    assert.match(warning, /"sylo"/);
    assert.ok(warning.includes(ROLE_DOCS_URL));
    assert.match(warning, /imported from the Health page/);
  }
  assert.deepEqual(roleRisks({ ...plain, superuser: true, createDb: true }), ['SUPERUSER', 'CREATEDB']);
});

test('the docs link points at the least-privilege section of the docs of this version', () => {
  assert.match(
    ROLE_DOCS_URL,
    /\/blob\/v\d+\.\d+\.\d+[^/]*\/docs\/postgres\.md#least-privilege-database-role$/
  );
});

test('on SQLite there is nothing to read and nothing to warn about', async () => {
  const warned = [];
  assert.equal(await readRolePrivileges(), null);
  assert.equal(await checkDatabaseRole({ warn: (...a) => warned.push(a) }), null);
  assert.deepEqual(warned, []);
});
