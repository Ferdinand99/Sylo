// Collectibles in the Economy shop: the item (normaliser, rarity tiers), buying one (price and version the
// member saw, stock as a limited edition, the limit per member, no picture yet), refund, revoke and free
// grants, the announcement of a purchase (on, off, one pass, only the buyer pinged), a member's collection
// (grouping, paging, an item that was deleted) and the pictures' files when rows end or a member is erased.
import './helpers/dashboardUrl.js';
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { getAccount } from '../src/db/economy.js';
import {
  collectionPage,
  createItem,
  deleteItem,
  eraseInventory,
  getInventoryRow,
  getItem,
  guildOfImage,
  listInventory,
  setItemImage,
  updateItem,
} from '../src/db/economyShop.js';
import { credit } from '../src/modules/lib/economy.js';
import { normaliseEconomyConfig, normaliseItem, RARITIES } from '../src/modules/lib/economyConfig.js';
import {
  announcePurchase,
  announcementLine,
  imageUrl,
  rarityLabel,
} from '../src/modules/lib/collectibles.js';
import { endRow, grantItem, purchase, shopRefusalText } from '../src/modules/lib/shop.js';
import { purchaseText } from '../src/bot/lib/shopText.js';
import { pathOf, saveImage } from '../src/lib/collectibleFiles.js';
import { processImage } from '../src/lib/collectibleImage.js';
import { dropFakeShop, fakeMember, fakeRole, fakeShopGuild, ROLE_A, SHOP_CH } from './helpers/fakeShop.js';
import { makePicture } from './helpers/collectibleFixtures.js';

let n = 0;
let G;
let ctx;
const cfg = (over = {}) => normaliseEconomyConfig({ shopChannelId: SHOP_CH, ...over });
const U = (i) => `8800000000000${String(i).padStart(5, '0')}`;

beforeEach(() => {
  G = `5800000000000${String(++n).padStart(5, '0')}`;
  ctx = fakeShopGuild(G, { roles: [fakeRole(ROLE_A, 'Millionaire')] });
});
afterEach(() => dropFakeShop());

async function buyer(i, cash = 1000) {
  const m = fakeMember(U(i));
  ctx.guild.members.cache.set(m.id, m);
  if (cash > 0) await credit(G, m.id, cash, { kind: 'staff_add', config: cfg() });
  return m;
}
const cashOf = async (m) => Number((await getAccount(G, m.id))?.cash ?? 0);

let picture;
/** A collectible with a picture (unless `image: false`). */
async function collectible(over = {}) {
  const { image = true, ...rest } = over;
  const id = await createItem(
    G,
    normaliseItem({ name: 'Founder badge', price: 100, type: 'collectible', ...rest })
  );
  if (image) {
    picture ??= (await processImage(await makePicture(32, 32))).png;
    await setItemImage(G, id, await saveImage(G, picture));
  }
  return id;
}
const buy = async (m, itemId, config = cfg()) => {
  const item = await getItem(G, itemId);
  return purchase({
    guild: ctx.guild,
    member: m,
    itemId,
    expectedPrice: item.price,
    expectedVersion: item.updatedAt,
    config,
  });
};

test('the rarity tiers are fixed, and a rarity or an announce switch only counts for a collectible', () => {
  assert.deepEqual(
    RARITIES.map((r) => [r.key, r.label, r.color]),
    [
      ['common', 'Common', 0x95a5a6],
      ['uncommon', 'Uncommon', 0x2ecc71],
      ['rare', 'Rare', 0x3498db],
      ['epic', 'Epic', 0x9b59b6],
      ['legendary', 'Legendary', 0xf1c40f],
    ]
  );
  const base = { name: 'x', price: 5 };
  assert.deepEqual(
    [
      normaliseItem({ ...base, type: 'collectible', rarity: 'legendary', announce: true }),
      normaliseItem({ ...base, type: 'collectible', rarity: 'Legendary' }),
      normaliseItem({ ...base, type: 'collectible', rarity: 'shiny', announce: 1 }),
      normaliseItem({ ...base, type: 'custom', rarity: 'rare', announce: true }),
      normaliseItem({ ...base, type: 'role', roleId: ROLE_A, rarity: 'rare', announce: true }),
    ].map((i) => [i.type, i.rarity, i.announce, i.roleId]),
    [
      ['collectible', 'legendary', true, null],
      ['collectible', null, false, null],
      ['collectible', null, false, null],
      ['custom', null, false, null],
      ['role', null, false, ROLE_A],
    ]
  );
  assert.equal(rarityLabel('epic'), 'Epic');
  assert.equal(rarityLabel(null), null);
  // a collectible gives no role: it needs none, and a stray role id is dropped
  assert.equal(normaliseItem({ ...base, type: 'collectible', roleId: ROLE_A }).roleId, null);
});

test('the settings have an announcement channel (an id or none) and a collection switch that is off by default', () => {
  assert.deepEqual(
    [normaliseEconomyConfig({}).collectibleChannelId, normaliseEconomyConfig({}).collectionPublic],
    ['', false]
  );
  const set = normaliseEconomyConfig({ collectibleChannelId: SHOP_CH, collectionPublic: true });
  assert.deepEqual([set.collectibleChannelId, set.collectionPublic], [SHOP_CH, true]);
  const bad = normaliseEconomyConfig({ collectibleChannelId: 'not-an-id', collectionPublic: 'true' });
  assert.deepEqual([bad.collectibleChannelId, bad.collectionPublic], ['', false]);
});

test('buying a collectible charges the price, uses one of the stock and gives the member an active row', async () => {
  const m = await buyer(1);
  const id = await collectible({ stock: 5, price: 150 });
  const out = await buy(m, id);
  assert.equal(out.ok, true);
  assert.equal(await cashOf(m), 850);
  const item = await getItem(G, id);
  assert.equal(item.sold, 1);
  const row = await getInventoryRow(G, out.row.id);
  assert.deepEqual(
    [row.itemType, row.status, row.source, row.pricePaid, row.roleId],
    ['collectible', 'active', 'purchase', 150, null]
  );
  assert.deepEqual(m.adds, [], 'no role is touched');
  assert.equal(ctx.sent.length, 0, 'staff are not asked to fulfil it, and nothing is announced by default');
  assert.match(
    purchaseText(out, cfg()),
    /You bought \*\*Founder badge\*\* for 🪙 150 coins\. It is in your collection \(\/collection\)\./
  );
});

test('a purchase is the price and version the member saw: a changed price, rarity or picture charges nothing', async () => {
  const m = await buyer(2);
  const id = await collectible({ rarity: 'rare' });
  const seen = await getItem(G, id);
  const before = await cashOf(m);

  // the price changed
  await updateItem(
    G,
    id,
    normaliseItem({ name: 'Founder badge', price: 250, type: 'collectible', rarity: 'rare' })
  );
  const priced = await purchase({
    guild: ctx.guild,
    member: m,
    itemId: id,
    expectedPrice: seen.price,
    expectedVersion: seen.updatedAt,
    config: cfg(),
  });
  assert.deepEqual([priced.ok, priced.reason, priced.price], [false, 'price_changed', 250]);

  // the rarity changed (same price)
  const now = await getItem(G, id);
  await updateItem(
    G,
    id,
    normaliseItem({ name: 'Founder badge', price: 250, type: 'collectible', rarity: 'legendary' })
  );
  const rarer = await purchase({
    guild: ctx.guild,
    member: m,
    itemId: id,
    expectedPrice: 250,
    expectedVersion: now.updatedAt,
    config: cfg(),
  });
  assert.deepEqual([rarer.ok, rarer.reason], [false, 'item_changed']);

  // the picture was replaced
  const current = await getItem(G, id);
  await setItemImage(G, id, await saveImage(G, picture));
  const repicked = await purchase({
    guild: ctx.guild,
    member: m,
    itemId: id,
    expectedPrice: 250,
    expectedVersion: current.updatedAt,
    config: cfg(),
  });
  assert.deepEqual([repicked.ok, repicked.reason], [false, 'item_changed']);

  assert.equal(await cashOf(m), before, 'nothing was charged');
  assert.equal((await getItem(G, id)).sold, 0);
  assert.equal((await listInventory(G, m.id)).length, 0);
  assert.equal((await buy(m, id)).ok, true, 'with the current price and version it works');
});

test('a collectible without a picture cannot be bought, and nothing is charged', async () => {
  const m = await buyer(3);
  const id = await collectible({ image: false });
  const out = await buy(m, id);
  assert.deepEqual([out.ok, out.reason], [false, 'no_image']);
  assert.match(shopRefusalText(out, cfg()), /not ready yet/);
  assert.equal(await cashOf(m), 1000);
  // staff can still give it for free
  assert.equal((await grantItem({ guild: ctx.guild, member: m, itemId: id, config: cfg() })).ok, true);
});

test('the stock is a limited edition: 12 buyers of the last 5 get exactly 5, and the rest are told it is sold out', async () => {
  const id = await collectible({ stock: 5, price: 10 });
  const members = [];
  for (let i = 10; i < 22; i++) members.push(await buyer(i, 100));
  const results = await Promise.all(members.map((m) => buy(m, id)));
  assert.equal(results.filter((r) => r.ok).length, 5);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.reason === 'sold_out'));
  assert.equal((await getItem(G, id)).sold, 5);
  for (let i = 0; i < members.length; i++) {
    assert.equal(await cashOf(members[i]), results[i].ok ? 90 : 100, 'only the winners paid');
  }
});

test('the limit per member counts the copies a member owns, and ends with a refund', async () => {
  const m = await buyer(4);
  const id = await collectible({ perMemberLimit: 2, price: 10 });
  const first = await buy(m, id);
  assert.equal(first.ok, true);
  assert.equal((await buy(m, id)).ok, true);
  const third = await buy(m, id);
  assert.deepEqual([third.ok, third.reason], [false, 'limit']);
  assert.equal(await cashOf(m), 980, 'the refused buy was not charged');
  assert.equal(
    (await endRow({ guild: ctx.guild, rowId: first.row.id, mode: 'refund', config: cfg() })).ok,
    true
  );
  assert.equal((await buy(m, id)).ok, true, 'a refunded copy no longer counts');
});

test('a refund gives the money and the stock back; a revoke takes it away without money; both leave the collection', async () => {
  const m = await buyer(5);
  const id = await collectible({ stock: 3, price: 40 });
  const a = await buy(m, id);
  const b = await buy(m, id);
  assert.equal(await cashOf(m), 920);
  const refunded = await endRow({
    guild: ctx.guild,
    rowId: a.row.id,
    mode: 'refund',
    by: 'staff1',
    reason: 'mistake',
    config: cfg(),
  });
  assert.deepEqual([refunded.ok, refunded.refunded], [true, true]);
  assert.equal(await cashOf(m), 960);
  assert.equal((await getItem(G, id)).sold, 1);
  assert.equal((await getInventoryRow(G, a.row.id)).status, 'refunded');
  const revoked = await endRow({ guild: ctx.guild, rowId: b.row.id, mode: 'revoke', config: cfg() });
  assert.deepEqual([revoked.ok, revoked.refunded], [true, false]);
  assert.equal(await cashOf(m), 960, 'a revoke moves no money');
  assert.equal((await getInventoryRow(G, b.row.id)).status, 'revoked');
  assert.equal((await collectionPage(G, m.id)).kinds, 0);
  assert.equal(
    (await endRow({ guild: ctx.guild, rowId: a.row.id, mode: 'refund', config: cfg() })).reason,
    'not_active',
    'not twice'
  );
  assert.deepEqual(m.removes, [], 'no role was taken off');
});

test('staff can give a collectible for free; it counts in the collection but not against the stock', async () => {
  const m = await buyer(6, 0);
  const id = await collectible({ stock: 1 });
  const out = await grantItem({ guild: ctx.guild, member: m, itemId: id, by: 'staff1', config: cfg() });
  assert.equal(out.ok, true);
  assert.deepEqual([out.row.source, out.row.pricePaid, out.row.status], ['grant', 0, 'active']);
  assert.equal((await getItem(G, id)).sold, 0);
  assert.equal(ctx.sent.length, 0, 'a gift is not announced');
  assert.equal((await collectionPage(G, m.id)).copies, 1);
});

// --- the announcement --------------------------------------------------------------------------------------

test('a purchase is announced only when the item and the settings ask for it, with the picture, pinging only the buyer', async () => {
  const m = await buyer(7);
  const on = await collectible({ announce: true, rarity: 'epic', emoji: '🎖️', name: 'Founder badge' });
  const off = await collectible({ announce: false, name: 'Quiet one' });
  const config = cfg({ collectibleChannelId: SHOP_CH });

  assert.equal((await buy(m, off, config)).ok, true);
  assert.equal(ctx.sent.length, 0, 'the item does not announce');

  assert.equal((await buy(m, on, cfg())).ok, true);
  assert.equal(ctx.sent.length, 0, 'no announcement channel is set');

  assert.equal((await buy(m, on, config)).ok, true);
  assert.equal(ctx.sent.length, 1);
  const msg = ctx.sent[0];
  assert.equal(msg.content, `🎉 <@${m.id}> bought 🎖️ **Founder badge** (Epic)!`);
  assert.deepEqual(msg.allowedMentions, { parse: [], users: [m.id] });
  const embed = msg.embeds[0].data;
  assert.match(embed.image.url, /^https:\/\/sylo\.example\.test\/c\/[0-9a-f]{32}\.png$/);
  assert.equal(embed.color, 0x9b59b6);
});

test('the announcement is filled in one pass: a name that looks like a placeholder or a mention pings and formats nothing', () => {
  const item = { name: '{user} **@everyone** <@&123> `x`', emoji: '', rarity: null };
  const line = announcementLine({ userId: '42', item });
  assert.equal(line.startsWith('🎉 <@42> bought **'), true);
  assert.ok(line.includes('{user}'), 'the placeholder in the name is shown as typed');
  assert.equal(line.split('<@42>').length, 2, 'the buyer is mentioned once');
  assert.doesNotMatch(line, /@everyone/, 'a ping is broken up');
  assert.ok(line.endsWith('**!'), 'no rarity, so no brackets');
  assert.equal(
    announcementLine({ userId: '42', item: { name: 'A', emoji: '', rarity: 'rare' } }),
    '🎉 <@42> bought **A** (Rare)!'
  );
});

test('an announcement without a picture goes out as text; an address is only made for a real id', async () => {
  // no picture (and so no address to put in an embed): the line alone
  const item = {
    type: 'collectible',
    announce: true,
    name: 'Plain',
    emoji: '',
    rarity: 'common',
    imageId: null,
  };
  const channel = cfg({ collectibleChannelId: SHOP_CH });
  assert.equal(await announcePurchase({ guildId: G, config: channel, item, userId: U(8) }), true);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].embeds, undefined);
  assert.equal(ctx.sent[0].content, `🎉 <@${U(8)}> bought **Plain** (Common)!`);
  // only a collectible that announces, in a server with a channel
  assert.equal(await announcePurchase({ guildId: G, config: cfg(), item, userId: U(8) }), false);
  assert.equal(
    await announcePurchase({ guildId: G, config: channel, item: { ...item, announce: false }, userId: U(8) }),
    false
  );
  assert.equal(imageUrl('not-an-id'), null);
  assert.equal(imageUrl('A'.repeat(32)), null, 'lower-case hex only');
  assert.equal(imageUrl('a'.repeat(32)), `https://sylo.example.test/c/${'a'.repeat(32)}.png`);
});

test('a custom item still asks staff to fulfil it and is never announced', async () => {
  const m = await buyer(9);
  const id = await createItem(
    G,
    normaliseItem({ name: 'Shout-out', price: 10, type: 'custom', announce: true })
  );
  assert.equal((await buy(m, id, cfg({ collectibleChannelId: SHOP_CH }))).ok, true);
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.sent[0].embeds[0].data.title, /an item to fulfil/);
});

// --- the collection and the files ------------------------------------------------------------------------------

test('a collection groups copies by item, pages ten items at a time, and counts only what is owned', async () => {
  const m = await buyer(11, 100000);
  const ids = [];
  for (let i = 1; i <= 23; i++)
    ids.push(await collectible({ name: `Badge ${i}`, price: 1, rarity: i % 2 ? 'rare' : null }));
  for (const id of ids) assert.equal((await buy(m, id)).ok, true);
  const twice = await buy(m, ids[0]);
  assert.equal(twice.ok, true);
  await endRow({ guild: ctx.guild, rowId: (await buy(m, ids[1])).row.id, mode: 'refund', config: cfg() });

  const first = await collectionPage(G, m.id, 1, 10);
  assert.deepEqual(
    [first.kinds, first.copies, first.pages, first.page, first.entries.length],
    [23, 24, 3, 1, 10]
  );
  assert.deepEqual(first.entries[0], {
    itemId: ids[0],
    removed: false,
    name: 'Badge 1',
    emoji: '',
    imageId: (await getItem(G, ids[0])).imageId,
    rarity: 'rare',
    count: 2,
    firstAt: first.entries[0].firstAt,
  });
  const last = await collectionPage(G, m.id, 3, 10);
  assert.equal(last.entries.length, 3);
  assert.equal((await collectionPage(G, m.id, 99, 10)).page, 3, 'a page past the end shows the last');
  assert.equal((await collectionPage(G, m.id, -4, 10)).page, 1);
  assert.deepEqual((await collectionPage(G, U(99))).entries, [], 'another member owns nothing');
});

test('an item that was deleted while members own it is still in their collection, with its picture', async () => {
  const m = await buyer(12);
  const id = await collectible({ name: 'Gone soon', rarity: 'epic' });
  const imageId = (await getItem(G, id)).imageId;
  await buy(m, id);
  assert.equal(await deleteItem(G, id), true);
  assert.equal(await getItem(G, id), null);
  assert.ok(existsSync(pathOf(G, imageId)), 'the file is kept');
  const page = await collectionPage(G, m.id);
  assert.deepEqual(
    [page.entries[0].removed, page.entries[0].name, page.entries[0].imageId, page.entries[0].rarity],
    [true, 'Gone soon', imageId, 'epic']
  );
  assert.equal(await guildOfImage(imageId), G, 'and it is still served');
});

test('the picture of an item nobody owns goes when the item is deleted; erasing the last owner removes it too', async () => {
  const lonely = await collectible({ name: 'Nobody' });
  const lonelyImage = (await getItem(G, lonely)).imageId;
  assert.equal(await deleteItem(G, lonely), true);
  assert.equal(existsSync(pathOf(G, lonelyImage)), false);
  assert.equal(await guildOfImage(lonelyImage), null);

  const m = await buyer(13);
  const id = await collectible({ name: 'Owned' });
  const imageId = (await getItem(G, id)).imageId;
  await buy(m, id);
  await deleteItem(G, id);
  assert.ok(existsSync(pathOf(G, imageId)));
  const erased = await eraseInventory(G, m.id);
  assert.equal(erased.rows, 1);
  assert.equal(existsSync(pathOf(G, imageId)), false, '/forget removes the last copy and its file');
});

test('a picture shared by an item that still exists is never deleted by a member leaving', async () => {
  const m = await buyer(14);
  const id = await collectible({ name: 'Kept' });
  const imageId = (await getItem(G, id)).imageId;
  await buy(m, id);
  await eraseInventory(G, m.id);
  assert.ok(existsSync(pathOf(G, imageId)), 'the item still has it');
  assert.equal(await guildOfImage(imageId), G);
});
