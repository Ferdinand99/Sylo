// The shop never hands out a role with Administrator, Manage Server or Manage Roles. Items made
// before the dashboard refused such roles (and items whose role was given more power later) are
// stopped when they are bought or given: nothing is charged, the member is told the item is
// unavailable, and the operator log gets a warning. The rule reads role.permissions on both
// platforms, so it is also run against the real Fluxer SDK roles.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@fluxerjs/core';
import { Collection } from '@fluxerjs/collection';
import { installFluxerCompat } from '../src/platform/compat.js';
import { getAccount } from '../src/db/economy.js';
import { createItem, getItem, listInventory } from '../src/db/economyShop.js';
import { credit } from '../src/modules/lib/economy.js';
import { normaliseEconomyConfig, normaliseItem } from '../src/modules/lib/economyConfig.js';
import {
  buyProblem,
  grantItem,
  purchase,
  shopRefusalText,
  shopRoleRefusal,
} from '../src/modules/lib/shop.js';
import { log } from '../src/lib/log.js';
import { dropFakeShop, fakeMember, fakeRole, fakeShopGuild, SHOP_CH } from './helpers/fakeShop.js';

installFluxerCompat(sdk, { Collection });

const withPerms = (id, name, perms) => fakeRole(id, name, { permissions: { has: (p) => perms.includes(p) } });
const SAFE = withPerms('700000000000000601', 'Supporter', ['KickMembers', 'ManageMessages']);
const ADMIN = withPerms('700000000000000602', 'Boss', ['Administrator']);
const SERVER = withPerms('700000000000000603', 'Manager', ['ManageGuild']);
const ROLES = withPerms('700000000000000604', 'Role wrangler', ['ManageRoles']);
const NEVER = [ADMIN, SERVER, ROLES];

let n = 0;
let G;
let ctx;
let warn;
const cfg = () => normaliseEconomyConfig({ shopChannelId: SHOP_CH });

beforeEach(() => {
  G = `5800000000000${String(++n).padStart(5, '0')}`;
  ctx = fakeShopGuild(G, { roles: [SAFE, ADMIN, SERVER, ROLES] });
  warn = mock.method(log, 'warn', () => {});
});
afterEach(() => {
  mock.restoreAll();
  dropFakeShop();
});

async function buyer(i, cash = 1000) {
  const member = fakeMember(`8800000000001${String(i).padStart(4, '0')}`);
  ctx.guild.members.cache.set(member.id, member);
  await credit(G, member.id, cash, { kind: 'staff_add', config: cfg() });
  return member;
}
const itemFor = (role, over = {}) =>
  createItem(
    G,
    normaliseItem({ name: `For ${role.name}`, price: 100, type: 'role', roleId: role.id, ...over })
  );
const cashOf = async (m) => Number((await getAccount(G, m.id))?.cash ?? 0);
const buy = async (member, itemId) => {
  const it = await getItem(G, itemId);
  return purchase({
    guild: ctx.guild,
    member,
    itemId,
    expectedPrice: it.price,
    expectedVersion: it.updatedAt,
    config: cfg(),
  });
};

test('buying a role with Administrator, Manage Server or Manage Roles is refused, uncharged and logged', async () => {
  const m = await buyer(1);
  for (const role of NEVER) {
    for (const type of ['role', 'temp_role']) {
      const id = await itemFor(role, type === 'temp_role' ? { type, durationHours: 24 } : {});
      const out = await buy(m, id);
      assert.equal(out.ok, false, `${role.name} as ${type}`);
      assert.equal(out.reason, 'item_unavailable');
      assert.match(shopRefusalText(out, cfg()), /unavailable.*Nothing was charged/);
    }
  }
  assert.equal(await cashOf(m), 1000, 'nothing was charged');
  assert.deepEqual(await listInventory(G, m.id), [], 'no inventory row');
  assert.deepEqual(m.adds, [], 'no role was put on the member');
  assert.equal(ctx.sent.length, 0, 'no purchase post to staff');
  const lines = warn.mock.calls.map((c) => c.arguments.join(' '));
  assert.equal(lines.length, 6, 'one warning for every item');
  assert.match(lines[0], /Refused to hand out item #\d+ \(For Boss\).*Administrator/);
});

test('a role with other moderator permissions, and a role without any, can still be bought', async () => {
  const m = await buyer(2);
  const id = await itemFor(SAFE);
  const out = await buy(m, id);
  assert.equal(out.ok, true);
  assert.equal(await cashOf(m), 900);
  assert.deepEqual(m.adds, [SAFE.id]);
  assert.equal(warn.mock.callCount(), 0);
});

test('the shop page and the /buy check see the item as unavailable, and warn only once per item', async () => {
  const m = await buyer(3);
  const id = await itemFor(SERVER);
  const it = await getItem(G, id);
  for (let i = 0; i < 3; i++) assert.deepEqual(buyProblem(ctx.guild, m, it), { reason: 'item_unavailable' });
  assert.equal(warn.mock.callCount(), 1);
});

test('a staff give of such an item is refused too', async () => {
  const m = await buyer(4, 0);
  const id = await itemFor(ROLES);
  const out = await grantItem({ guild: ctx.guild, member: m, itemId: id, config: cfg() });
  assert.deepEqual([out.ok, out.reason], [false, 'item_unavailable']);
  assert.deepEqual(m.adds, []);
  assert.deepEqual(await listInventory(G, m.id), []);
});

test('the rule reads the permissions of a real Fluxer role', () => {
  const F = sdk.PermissionFlags;
  const GID = '900000000000000700';
  const guild = { id: GID, roles: new sdk.GuildRoleManager(GID, {}), members: new Collection() };
  const client = { guilds: new Collection([[GID, guild]]) };
  guild.client = client;
  const role = (id, name, permissions) =>
    new sdk.Role(client, { id, name, color: 0, position: 1, permissions: String(permissions) }, GID);
  assert.match(shopRoleRefusal(role('1', 'Admins', F.Administrator)), /Admins has .*Administrator/);
  assert.match(shopRoleRefusal(role('2', 'Managers', F.ManageGuild)), /Managers has Manage Server/);
  assert.match(shopRoleRefusal(role('3', 'Wranglers', F.ManageRoles)), /Wranglers has Manage Roles/);
  assert.equal(shopRoleRefusal(role('4', 'Chatty', F.SendMessages | F.KickMembers)), null);
  assert.equal(shopRoleRefusal(null), null, 'a role that is gone is the bot check, not this one');
});
