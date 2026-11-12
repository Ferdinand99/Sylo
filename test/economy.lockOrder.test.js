// The order in which the money API opens accounts, checked statement by statement (no database): every
// account is made, locked and read in user id order, ONE AT A TIME, before anything else is touched. A
// deadlock between two money calls needs one of them to hold a higher account while it waits for a lower
// one; a call that first inserted every missing account and only then locked the rest did exactly that
// (and so did one that made a vanished account again while it held a later one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openAccounts } from '../src/modules/lib/economy.js';

/** Run the generator with a stand-in transaction; `existing` says which accounts have a row. */
function run(ids, existing, { vanish = null, create = true } = {}) {
  const log = [];
  const tx = {
    get: (sql, ...args) => ({ op: 'get', sql, args }),
    run: (sql, ...args) => ({ op: 'run', sql, args }),
    insertId: (sql, ...args) => ({ op: 'insertId', sql, args }),
  };
  const it = openAccounts(tx, 'g', ids, { startingBalance: 5 }, 1000, create);
  let step = it.next();
  while (!step.done) {
    const { op, sql, args } = step.value;
    let answer;
    if (op === 'run') {
      log.push(`${/INSERT INTO economy_accounts/.test(sql) ? 'insert' : 'lock'} ${args.at(1) ?? ''}`.trim());
      answer = { changes: /INSERT/.test(sql) && !existing.has(args[1]) ? 1 : 0 };
      if (/INSERT/.test(sql)) existing.add(args[1]);
    } else if (op === 'get' && /FROM economy_accounts/.test(sql)) {
      log.push(`read ${args[1]}`);
      answer = existing.has(args[1]) && args[1] !== vanish ? { user_id: args[1] } : undefined;
    } else if (op === 'get') {
      answer = undefined; // no cooldown record
    } else {
      log.push('ledger');
      answer = 1;
    }
    step = it.next(answer);
  }
  return { log, accounts: step.value };
}

test('accounts are made, locked and read one at a time in id order, whether they exist or not', () => {
  // A is there, B is missing: B is NOT made before A is locked
  const { log } = run(['1', '2'], new Set(['1']));
  assert.deepEqual(
    log.filter((l) => !l.startsWith('ledger')),
    ['insert 1', 'lock 1', 'read 1', 'insert 2', 'lock 2', 'read 2']
  );
});

test('a call that only reads existing accounts locks them in id order and creates nothing', () => {
  const { log, accounts } = run(['1', '2', '3'], new Set(['1', '2', '3']), { create: false });
  assert.deepEqual(log, ['lock 1', 'read 1', 'lock 2', 'read 2', 'lock 3', 'read 3']);
  assert.deepEqual([...accounts.keys()], ['1', '2', '3']);
});

test('an account that vanishes while it is opened restarts the call instead of being made out of order', () => {
  assert.throws(() => run(['1', '2'], new Set(['1', '2']), { vanish: '1' }), { name: 'AccountVanished' });
  // without `create` it is simply not part of the call
  const { accounts } = run(['1', '2'], new Set(['1', '2']), { vanish: '1', create: false });
  assert.deepEqual([...accounts.keys()], ['2']);
});
