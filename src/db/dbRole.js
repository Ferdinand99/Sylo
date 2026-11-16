// What the Postgres role in DATABASE_URL may do. Sylo cannot change it from code, so at start-up it
// reads the role's privileges and warns once when the role is stronger than Sylo needs.
//
// Why it matters: a backup file that an operator imports is restored with pg_restore, which sends
// every statement in the file to the database as this role (src/db/backupPostgres.js). Inside
// Sylo's own database that is no more than an operator can already do by restoring a backup. A
// superuser, or a member of pg_execute_server_program / pg_read_server_files /
// pg_write_server_files, can also reach the database server's own system. The role Sylo uses
// should have none of that: docs/postgres.md (Least-privilege database role).
import { config } from '../config.js';
import { prepare } from './driver.js';
import { REPO_URL } from '../bot/lib/buildInfo.js';

// The docs on the default branch: a link to a release tag would point at docs without this
// section until the first release that has it (and 404 for a build that has no tag). The section
// only ever gets better, so the newest text is the right one for every version.
export const ROLE_DOCS_URL = `${REPO_URL}/blob/main/docs/postgres.md#least-privilege-database-role`;

/**
 * @typedef {object} RolePrivileges
 * @property {string} name
 * @property {boolean} superuser
 * @property {boolean} createRole
 * @property {boolean} createDb
 * @property {boolean} execProgram  member of pg_execute_server_program
 * @property {boolean} readFiles    member of pg_read_server_files
 * @property {boolean} writeFiles   member of pg_write_server_files
 * @property {boolean} superMember  member of a superuser role (it can SET ROLE to it)
 */

const yes = (v) => v === true || v === 1 || v === 't';

/** The privileges that are more than Sylo needs, in words. Empty when the role is fine. */
export function roleRisks(p) {
  if (!p) return [];
  const risks = [];
  if (p.superuser) risks.push('SUPERUSER');
  if (p.createRole) risks.push('CREATEROLE');
  if (p.createDb) risks.push('CREATEDB');
  if (p.execProgram) risks.push('pg_execute_server_program');
  if (p.readFiles) risks.push('pg_read_server_files');
  if (p.writeFiles) risks.push('pg_write_server_files');
  if (p.superMember) risks.push('membership of a superuser role');
  return risks;
}

/** The one start-up warning for these privileges, or null when there is nothing to warn about. */
export function rolePrivilegeWarning(p) {
  const risks = roleRisks(p);
  if (risks.length === 0) return null;
  return (
    `The database role "${p.name}" in DATABASE_URL has more rights than Sylo needs (${risks.join(', ')}). ` +
    'A backup file imported from the Health page is restored with the rights of this role: its SQL runs as it. ' +
    `Use a role without these rights: ${ROLE_DOCS_URL}`
  );
}

/** @type {RolePrivileges | null} */
let last = null;

/** The result of the last check, or null when none ran (SQLite, or the check failed). */
export const lastRolePrivileges = () => last;

const FULL = `
  SELECT current_user AS name, r.rolsuper, r.rolcreaterole, r.rolcreatedb,
    pg_has_role(current_user, 'pg_execute_server_program', 'MEMBER') AS exec_program,
    pg_has_role(current_user, 'pg_read_server_files', 'MEMBER') AS read_files,
    pg_has_role(current_user, 'pg_write_server_files', 'MEMBER') AS write_files,
    EXISTS (SELECT 1 FROM pg_roles s WHERE s.rolsuper AND pg_has_role(current_user, s.oid, 'MEMBER')) AS super_member
  FROM pg_roles r WHERE r.rolname = current_user`;
// Servers before Postgres 11 have no predefined roles to ask about. Only that case (an unknown
// role or function) uses this shorter question; any other error means "could not tell", never
// "no extra rights".
const BASIC = `
  SELECT current_user AS name, r.rolsuper, r.rolcreaterole, r.rolcreatedb,
    EXISTS (SELECT 1 FROM pg_roles s WHERE s.rolsuper AND pg_has_role(current_user, s.oid, 'MEMBER')) AS super_member
  FROM pg_roles r WHERE r.rolname = current_user`;
const UNDEFINED_OBJECT_OR_FUNCTION = new Set(['42704', '42883']);

/** The answer of FULL or BASIC as RolePrivileges (null for no row). */
export function privilegesFromRow(row) {
  if (!row) return null;
  return {
    name: String(row.name),
    superuser: yes(row.rolsuper),
    createRole: yes(row.rolcreaterole),
    createDb: yes(row.rolcreatedb),
    execProgram: yes(row.exec_program),
    readFiles: yes(row.read_files),
    writeFiles: yes(row.write_files),
    superMember: yes(row.super_member),
  };
}

/** The two questions, for tests that ask them over a connection of their own. */
export const ROLE_QUERIES = { full: FULL, basic: BASIC };

/**
 * Read the privileges of the connected role. Postgres only; resolves to null on SQLite or when the
 * server cannot be asked. Never throws.
 * @returns {Promise<RolePrivileges | null>}
 */
export async function readRolePrivileges() {
  if (!config.databaseUrl) return null;
  for (const sql of [FULL, BASIC]) {
    try {
      return privilegesFromRow(await prepare(sql).get());
    } catch (err) {
      if (!UNDEFINED_OBJECT_OR_FUNCTION.has(err?.code)) return null; // could not tell
      // an older server: try the simpler question
    }
  }
  return null;
}

/**
 * Start-up check: read the role's privileges, remember them for the Health page, and log one
 * warning when the role is stronger than needed.
 * @param {{ warn: (scope: string, msg: string) => void }} log
 */
export async function checkDatabaseRole(log) {
  last = await readRolePrivileges();
  const warning = rolePrivilegeWarning(last);
  if (warning) log.warn('db', warning);
  return last;
}
