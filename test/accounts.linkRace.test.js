// linkIdentity checks, then inserts. Two links at the same moment can both pass the checks, and the
// unique indexes then refuse one insert. That refusal has to come out as the same typed error as the
// checks give (so a route answers 409 or ends at the app, never a 500). The hook runs between the
// checks and the insert, so the losing insert is deterministic.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IdentityLinkedError,
  PlatformAlreadyLinkedError,
  createAccount,
  findIdentity,
  identitiesOf,
  linkIdentity,
  signInIdentity,
} from '../src/db/accounts.js';

let n = 0;
const login = (platform) => ({
  platform,
  platformUserId: `7000000000${String(++n).padStart(8, '0')}`,
  username: `u${n}`,
  avatar: null,
  guildIds: [],
});
/** An account that has a Discord login. */
async function account() {
  const me = login('discord');
  const { accountId } = await signInIdentity(me);
  return accountId;
}
const kinds = async (accountId) => (await identitiesOf(accountId)).map((i) => i.platform).sort();

test('the same login taken by another account in the gap is IdentityLinkedError', async () => {
  const mine = await account();
  const other = await account();
  const fluxer = login('fluxer');
  await assert.rejects(
    linkIdentity(mine, fluxer, { afterChecks: () => linkIdentity(other, fluxer) }),
    IdentityLinkedError
  );
  assert.equal((await findIdentity('fluxer', fluxer.platformUserId)).accountId, other);
  assert.deepEqual(await kinds(mine), ['discord']);
});

test('another login on the platform added to this account in the gap is PlatformAlreadyLinkedError', async () => {
  const mine = await account();
  const first = login('fluxer');
  const second = login('fluxer');
  await assert.rejects(
    linkIdentity(mine, second, { afterChecks: () => linkIdentity(mine, first) }),
    PlatformAlreadyLinkedError
  );
  assert.deepEqual(await kinds(mine), ['discord', 'fluxer'], 'one Fluxer login, the one that got in first');
  assert.equal((await findIdentity('fluxer', first.platformUserId)).accountId, mine);
  assert.equal(await findIdentity('fluxer', second.platformUserId), null);
});

test('the same login added to this same account in the gap is a quiet success', async () => {
  const mine = await account();
  const fluxer = login('fluxer');
  await linkIdentity(mine, fluxer, { afterChecks: () => linkIdentity(mine, fluxer) });
  assert.deepEqual(await kinds(mine), ['discord', 'fluxer']);
});

test('an error that is not a unique violation is not swallowed', async () => {
  const mine = await createAccount();
  await assert.rejects(
    linkIdentity(mine, { ...login('fluxer'), platformUserId: null }),
    (err) => !(err instanceof IdentityLinkedError) && !(err instanceof PlatformAlreadyLinkedError)
  );
});
