// A small fake server for the Economy shop tests: a few roles, members whose roles can be added and
// removed (and made to fail), and a log channel that keeps what is posted to it. It is registered as
// the Discord client of the runtime, so guildByKey() and sendToChannel() find it.
import { runtime } from '../../src/runtime.js';

export const ROLE_A = '700000000000000101';
export const ROLE_B = '700000000000000102';
export const ROLE_REQ = '700000000000000103';
export const SHOP_CH = '700000000000000201';

export function fakeRole(id, name, over = {}) {
  return { id, name, position: 1, managed: false, editable: true, ...over };
}

/** A member with a role cache and role calls that can be told to fail. */
export function fakeMember(id, { roles = [], bot = false } = {}) {
  const cache = new Map(roles.map((r) => [r.id, r]));
  const member = {
    id,
    displayName: `User ${id.slice(-3)}`,
    user: { id, bot, username: `user${id.slice(-3)}` },
    failAdd: false,
    adds: [],
    removes: [],
    roles: {
      cache,
      add: async (role) => {
        if (member.failAdd)
          throw Object.assign(new Error('Missing Permissions'), { status: 403, code: 50013 });
        member.adds.push(role.id);
        cache.set(role.id, role);
      },
      remove: async (role) => {
        member.removes.push(role.id);
        cache.delete(role.id);
      },
    },
  };
  return member;
}

/**
 * A guild with the given roles and members. `canManageRoles: false` makes Sylo unable to hand out roles.
 * Returns { guild, sent } where `sent` collects what is posted to SHOP_CH.
 */
export function fakeShopGuild(id, { roles = [], members = [], canManageRoles = true } = {}) {
  const sent = [];
  const roleMap = new Map(roles.map((r) => [r.id, r]));
  const memberMap = new Map(members.map((m) => [m.id, m]));
  const channel = {
    id: SHOP_CH,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      sent.push(payload);
      return { id: `msg${sent.length}` };
    },
  };
  const me = {
    id: 'bot',
    permissions: { has: () => canManageRoles },
    roles: { highest: { comparePositionTo: () => 10 } },
  };
  const guild = {
    id,
    name: 'Shop Test',
    iconURL: () => null,
    roles: { cache: roleMap },
    members: {
      me,
      cache: memberMap,
      fetch: async (userId) => {
        const m = memberMap.get(userId);
        if (!m) throw Object.assign(new Error('Unknown Member'), { status: 404, code: 10007 });
        return m;
      },
    },
    channels: {
      cache: new Map([[SHOP_CH, channel]]),
      fetch: async (cid) => (cid === SHOP_CH ? channel : null),
    },
  };
  runtime.client = {
    isReady: () => true,
    guilds: { cache: new Map([[id, guild]]) },
    users: { fetch: async () => null },
  };
  return { guild, sent };
}

export const dropFakeShop = () => {
  runtime.client = null;
};

/**
 * purchase() for a test that is not about the price the buyer saw: it expects the item's price as it
 * is right now. (The imports are dynamic so a test can load its database helper first.)
 */
export async function buyNow(args) {
  const { purchase } = await import('../../src/modules/lib/shop.js');
  const { getItem } = await import('../../src/db/economyShop.js');
  const { guildKey } = await import('../../src/platform/platformOf.js');
  const item = await getItem(guildKey(args.guild), args.itemId);
  return purchase({ expectedPrice: item?.price, ...args });
}
