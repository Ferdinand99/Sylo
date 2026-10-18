// The bot keeps each signed-in person's list of servers they run up to date from its own
// events, so the dashboard needs no periodic trip through the platform's login: a member who
// gains (or loses) Manage Server or Administrator, or becomes the owner, is added (or removed).
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { signInIdentity, findIdentity } from '../src/db/accounts.js';
import { syncAdminSnapshot, syncNewOwner } from '../src/bot/lib/adminSnapshot.js';

const GUILD = '900000000000000701';
const FLUXER_GUILD = 'fluxer:900000000000000702';

const member = (id, perms = []) => ({ id, permissions: { has: (p) => perms.includes(p) } });
const guild = (ownerId = 'someone') => ({ ownerId });

test('gaining Manage Server adds the server, losing it removes it', async () => {
  const U = '900000000000000711';
  await signInIdentity({ platform: 'discord', platformUserId: U, username: 'u', avatar: null, guildIds: [] });
  await syncAdminSnapshot('discord', GUILD, guild(), member(U, ['ManageGuild']));
  assert.deepEqual((await findIdentity('discord', U)).guildIds, [GUILD]);
  await syncAdminSnapshot('discord', GUILD, guild(), member(U, []));
  assert.deepEqual((await findIdentity('discord', U)).guildIds, []);
});

test('a Fluxer member is matched to their Fluxer sign-in, with the guild key', async () => {
  const U = '900000000000000712';
  await signInIdentity({ platform: 'fluxer', platformUserId: U, username: 'u', avatar: null, guildIds: [] });
  await syncAdminSnapshot('fluxer', FLUXER_GUILD, guild(), member(U, ['Administrator']));
  assert.deepEqual((await findIdentity('fluxer', U)).guildIds, [FLUXER_GUILD]);
});

test('a new owner gets the server', async () => {
  const U = '900000000000000713';
  await signInIdentity({ platform: 'discord', platformUserId: U, username: 'u', avatar: null, guildIds: [] });
  await syncNewOwner('discord', GUILD, U);
  assert.deepEqual((await findIdentity('discord', U)).guildIds, [GUILD]);
});

test('someone who never signed in is not stored', async () => {
  await syncAdminSnapshot('discord', GUILD, guild(), member('900000000000000714', ['ManageGuild']));
  assert.equal(await findIdentity('discord', '900000000000000714'), null);
});

test('the time of the last full refresh is left alone', async () => {
  const U = '900000000000000715';
  await signInIdentity({ platform: 'discord', platformUserId: U, username: 'u', avatar: null, guildIds: [] });
  const before = (await findIdentity('discord', U)).guildsFetchedAt;
  await syncAdminSnapshot('discord', GUILD, guild(), member(U, ['ManageGuild']));
  assert.equal((await findIdentity('discord', U)).guildsFetchedAt, before);
});
