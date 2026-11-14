// The web shop: /api/v2/shop/<server> for the member-facing page (/v2/shop/<server>, also reachable as
// /shop/<server>). It shows the signed-in member their balance, the items and what they own, and buys
// with the very same purchase() as /buy and /shop (modules/lib/shop.js).
//
// Nothing here is public, and every visitor who may not use it gets the SAME answer, a 404:
//   - not signed in with the browser session (an app token does not count), or open mode with no login
//   - the server is unknown to Sylo, or has no Economy module, or the web shop is switched off
//   - the signed-in person is not a member of that server (checked on the platform the server is on,
//     with their identity on THAT platform, so a Discord id is never looked up in a Fluxer server)
// The only thing a signed-out visitor sees is the login page the dashboard sends everyone to.
// Writes need the CSRF token (the global csrf middleware) and have their own rate limit; the
// requirements of an item are checked on the server, never trusted from the page.
import { accessRouter } from '../middleware/access.js';
import { config as appConfig } from '../../config.js';
import { rateLimit, clientKey } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { guildByKey, guildKey } from '../../platform/platformOf.js';
import { isPlatformGuildId, splitPlatformGuildId } from '../../lib/platformId.js';
import { identityFor } from '../lib/accountAuth.js';
import { getGuildModule } from '../../db/modules.js';
import { collectionPage, listInventory, listItems } from '../../db/economyShop.js';
import { rarityLabel } from '../../modules/lib/collectibles.js';
import { getTempRole } from '../../db/tempRoles.js';
import { balanceOf, normaliseEconomyConfig } from '../../modules/economy.js';
import { buyProblem, purchase, requirementsMet, shopRefusalText } from '../../modules/lib/shop.js';

const router = accessRouter('/shop/:guildId', { mergeParams: true });

/** A purchase may call the platform (a role), so buying has its own limit: per person and server. */
const buyLimit = rateLimit({
  windowMs: 60_000,
  max: 15,
  message: 'Too many purchases: wait a minute and try again.',
  keyFn: (req) => `shop-buy|${req.params?.guildId ?? ''}|${req.account?.id ?? clientKey(req)}`,
});

const notFound = (res) => {
  res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
  return res.status(404).json({ error: 'Not found' });
};

/**
 * Who this request may be, or null for the one not-found answer: `{ guild, key, member, config }`.
 */
async function openShop(req) {
  if (!appConfig.authEnabled) return null;
  // Only the browser's own session counts, never an app (Bearer) token.
  if (!req.account || req.viaToken) return null;
  const key = req.params.guildId;
  if (!isPlatformGuildId(key)) return null;
  const guild = guildByKey(key);
  if (!guild) return null;
  const platform = splitPlatformGuildId(key)?.platform ?? 'discord';
  const identity = identityFor(req.account, platform);
  if (!identity) return null;

  const mod = await getGuildModule(key, 'economy');
  const config = normaliseEconomyConfig(mod.config);
  if (!mod.enabled || !config.webShop) return null;

  const member =
    guild.members.cache.get(identity.platformUserId) ??
    (await guild.members.fetch(identity.platformUserId).catch(() => null));
  if (!member || member.user?.bot) return null;
  return { guild, key: guildKey(guild), member, config };
}

const guard = (handler) =>
  asyncHandler(async (req, res) => {
    const open = await openShop(req);
    if (!open) return notFound(res);
    res.set({ 'Cache-Control': 'private, no-store' });
    return handler(req, res, open);
  });

/** Role mentions in a sentence as plain names, for a page that does not render platform markup. */
function plain(text, guild) {
  return String(text)
    .replace(/<@&(\d+)>/g, (_, id) => `@${guild.roles.cache.get(id)?.name ?? 'a role'}`)
    .replace(/<t:(\d+):[a-zA-Z]>/g, (_, s) => new Date(Number(s) * 1000).toUTCString());
}

/** The page's data: balance, the items for sale with what this member can do, and what they own. */
async function shopView({ guild, key, member, config }) {
  const roleIds = [...member.roles.cache.keys()];
  const bal = await balanceOf(key, member.id);
  // A collectible without a picture is not shown yet (it cannot be bought).
  const items = (await listItems(key)).filter((i) => i.enabled && (i.type !== 'collectible' || i.imageId));
  // A collectible is shown in the collection below, not in the list of what the member owns.
  const rows = (await listInventory(key, member.id, 100)).filter(
    (r) => (r.status === 'active' || r.status === 'pending') && r.itemType !== 'collectible'
  );
  // The member's own collection, every kind they hold (at most the shop's items plus deleted ones).
  const collection = (await collectionPage(key, member.id, 1, 200)).entries.map((e) => ({
    itemId: e.itemId,
    name: e.name,
    emoji: e.emoji,
    imagePath: e.imageId ? `/c/${e.imageId}.webp` : null,
    rarity: e.rarity,
    rarityLabel: rarityLabel(e.rarity),
    count: e.count,
    removed: e.removed,
    since: e.firstAt,
  }));
  const inventory = [];
  for (const r of rows) {
    const until =
      r.itemType === 'temp_role' && r.roleId
        ? ((await getTempRole(key, member.id, r.roleId))?.expires_at ?? null)
        : null;
    inventory.push({
      id: r.id,
      name: r.itemName,
      type: r.itemType,
      expiresAt: until,
      fulfilledAt: r.fulfilledAt,
      waiting: r.itemType === 'custom' && !r.fulfilledAt,
      createdAt: r.createdAt,
    });
  }
  return {
    guild: { name: guild.name, id: key },
    currency: { name: config.currencyName, emoji: config.currencyEmoji },
    balance: { cash: bal.cash, bank: bal.bank, total: bal.total },
    items: items.map((i) => {
      const problem = buyProblem(guild, member, i);
      return {
        id: i.id,
        name: i.name,
        description: i.description,
        emoji: i.emoji,
        type: i.type,
        price: i.price,
        version: i.updatedAt,
        durationHours: i.durationMs == null ? null : Math.round(i.durationMs / 3_600_000),
        left: i.stock === null ? null : Math.max(0, i.stock - i.sold),
        imagePath: i.type === 'collectible' && i.imageId ? `/c/${i.imageId}.webp` : null,
        rarity: i.type === 'collectible' ? i.rarity : null,
        rarityLabel: i.type === 'collectible' ? rarityLabel(i.rarity) : null,
        requiredRoles: i.requiredRoles.map((id) => ({
          id,
          name: guild.roles.cache.get(id)?.name ?? 'a role',
        })),
        meetsRequirements: requirementsMet(i, roleIds),
        canBuy: !problem && bal.cash >= i.price,
        problem: problem
          ? plain(shopRefusalText(problem, config), guild)
          : bal.cash < i.price
            ? 'Not enough cash.'
            : null,
      };
    }),
    inventory,
    collection,
  };
}

router.get(
  '/',
  guard(async (req, res, open) => {
    res.json(await shopView(open));
  })
);

router.post(
  '/buy',
  asyncHandler(async (req, res, next) => {
    // The limit counts only people who may use the shop: a stranger gets the plain 404 below.
    const open = await openShop(req);
    if (!open) return notFound(res);
    return buyLimit(req, res, async () => {
      try {
        res.set({ 'Cache-Control': 'private, no-store' });
        const itemId = /^\d{1,15}$/.test(String(req.body?.itemId ?? '')) ? Number(req.body.itemId) : 0;
        // The price the page showed and the member confirmed; a missing or odd one never matches.
        const expectedPrice = /^\d{1,15}$/.test(String(req.body?.price ?? '')) ? Number(req.body.price) : NaN;
        const expectedVersion = /^\d{1,16}$/.test(String(req.body?.version ?? ''))
          ? Number(req.body.version)
          : NaN;
        const out = await purchase({
          guild: open.guild,
          member: open.member,
          itemId,
          expectedPrice,
          expectedVersion,
          config: open.config,
        });
        if (!out.ok) {
          return res.status(400).json({
            error: plain(shopRefusalText(out, open.config), open.guild),
            reason: out.reason,
            view: await shopView(open),
          });
        }
        return res.json({
          ok: true,
          bought: {
            name: out.item.name,
            type: out.item.type,
            price: out.item.price,
            expiresAt: out.expiresAt ?? null,
            extended: Boolean(out.extended),
          },
          view: await shopView(open),
        });
      } catch (err) {
        return next(err);
      }
    });
  })
);

export default router;
