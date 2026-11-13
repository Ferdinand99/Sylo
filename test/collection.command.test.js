// /collection: your own collection is private, and showing one to others is a server setting that is off by
// default; ten items to a page with image thumbnails; the page buttons carry whose collection it is and are
// checked again on every press; an empty collection, bots, the Economy module off, and the Fluxer form.
import './helpers/dashboardUrl.js';
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createItem, deleteItem, getItem, setItemImage } from '../src/db/economyShop.js';
import { setGuildModule } from '../src/db/modules.js';
import { runtime } from '../src/runtime.js';
import { loadCommands } from '../src/bot/loadCommands.js';
import { routeComponent } from '../src/bot/lib/components.js';
import { GROUPS, otherCommands } from '../src/bot/commands/help.js';
import { parseArgs } from '../src/bot/framework/parser.js';
import * as collection from '../src/bot/commands/collection.js';
import * as inventory from '../src/bot/commands/inventory.js';
import { credit } from '../src/modules/lib/economy.js';
import { normaliseEconomyConfig, normaliseItem } from '../src/modules/lib/economyConfig.js';
import { purchase } from '../src/modules/lib/shop.js';
import { saveImage } from '../src/lib/collectibleFiles.js';
import { dropFakeShop, fakeMember, fakeShopGuild } from './helpers/fakeShop.js';

let n = 0;
let G;
let ctx;
const config = normaliseEconomyConfig({});
const A = '8300000000000001';
const B = '8300000000000002';
const C = '8300000000000003';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

beforeEach(async () => {
  G = `5600000000000${String(++n).padStart(5, '0')}`;
  ctx = fakeShopGuild(G, {});
  await setGuildModule(G, 'economy', { enabled: true, config: {} });
});
afterEach(() => dropFakeShop());

const setPublic = (on) => setGuildModule(G, 'economy', { enabled: true, config: { collectionPublic: on } });
const member = (id) => {
  const m = fakeMember(id);
  ctx.guild.members.cache.set(id, m);
  return m;
};

/** A collectible with a picture. */
async function badge(name, over = {}) {
  const id = await createItem(G, normaliseItem({ name, price: 1, type: 'collectible', ...over }));
  await setItemImage(G, id, await saveImage(G, PNG));
  return id;
}
async function own(m, ...ids) {
  await credit(G, m.id, 1000, { kind: 'staff_add', config });
  for (const itemId of ids) {
    const item = await getItem(G, itemId);
    const out = await purchase({
      guild: ctx.guild,
      member: m,
      itemId,
      expectedPrice: item.price,
      expectedVersion: item.updatedAt,
      config,
    });
    assert.equal(out.ok, true);
  }
}

function interaction(m, { options = {}, inGuild = true } = {}) {
  const replies = [];
  return {
    replies,
    inGuild: () => inGuild,
    guildId: G,
    guild: ctx.guild,
    user: m.user,
    member: m,
    options: { getUser: (k) => options[k] ?? null },
    reply: async (p) => replies.push(p),
  };
}
const press = (m, customId) => {
  const out = [];
  return {
    out,
    guildId: G,
    guild: ctx.guild,
    member: m,
    user: m.user,
    customId,
    isRepliable: () => true,
    deferUpdate: async () => out.push({ deferred: true }),
    update: async (p) => out.push({ update: p }),
    reply: async (p) => out.push({ reply: p }),
  };
};
const buttons = (payload) => (payload.components ?? []).flatMap((row) => row.toJSON().components);

test('/collection is loaded, listed in help under Shop, and parses from chat', async () => {
  const commands = await loadCommands();
  assert.ok(commands.has('collection'));
  assert.ok(GROUPS.find((g) => g.name === 'Shop').commands.includes('collection'));
  assert.deepEqual(
    otherCommands(commands).map((c) => c.data.name),
    []
  );
  const schema = commands.get('collection').data.toJSON();
  assert.equal(parseArgs(schema, '<@123456789012345678>').values.user.value, '<@123456789012345678>');
});

test('off (the default): /collection shows your own collection, privately, one embed with a picture per item', async () => {
  const a = member(A);
  const one = await badge('Founder badge', { rarity: 'rare', emoji: '🎖️' });
  const two = await badge('Early bird');
  await own(a, one, one, two);
  const i = interaction(a);
  await collection.execute(i);
  const reply = i.replies[0];
  assert.equal(reply.flags, MessageFlags.Ephemeral, 'only the member sees it');
  assert.deepEqual(reply.allowedMentions, { parse: [] });
  assert.equal(reply.content, '🗂️ **Collection of <@8300000000000001>** · 3 collectibles · page 1 of 1');
  assert.equal(reply.embeds.length, 2);
  const [first, second] = reply.embeds.map((e) => e.data);
  assert.equal(first.title, '🎖️ Founder badge ×2');
  assert.match(first.description, /Rare · since <t:\d+:d>/);
  assert.equal(first.color, 0x3498db);
  assert.match(first.thumbnail.url, /^https:\/\/sylo\.example\.test\/c\/[0-9a-f]{32}\.png$/);
  assert.equal(second.title, 'Early bird');
  assert.equal(reply.components.length, 0, 'one page: no buttons');
});

test('off: asking for another member is refused, privately, and shows nothing of theirs', async () => {
  const a = member(A);
  const b = member(B);
  await own(b, await badge('Secret'));
  const i = interaction(a, { options: { user: b.user } });
  await collection.execute(i);
  assert.equal(i.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(i.replies[0].content, /Collections are private in this server/);
  assert.equal(i.replies[0].embeds, undefined);
  // naming yourself is the same as no name
  const self = interaction(a, { options: { user: a.user } });
  await collection.execute(self);
  assert.match(self.replies[0].content, /do not own any collectibles yet/);
});

test('on: /collection is public, and /collection <user> shows that member', async () => {
  await setPublic(true);
  const a = member(A);
  const b = member(B);
  await own(b, await badge('Founder badge'));
  const mine = interaction(a);
  await collection.execute(mine);
  assert.equal(mine.replies[0].flags, undefined, 'public');
  assert.match(mine.replies[0].content, /do not own any collectibles yet/);

  const theirs = interaction(a, { options: { user: b.user } });
  await collection.execute(theirs);
  assert.equal(theirs.replies[0].flags, undefined, 'public');
  assert.equal(
    theirs.replies[0].content,
    '🗂️ **Collection of <@8300000000000002>** · 1 collectible · page 1 of 1'
  );
  assert.equal(theirs.replies[0].embeds[0].data.title, 'Founder badge');
  assert.deepEqual(theirs.replies[0].allowedMentions, { parse: [] }, 'naming a member pings nobody');

  const none = interaction(b, { options: { user: a.user } });
  await collection.execute(none);
  assert.match(none.replies[0].content, /<@8300000000000001> does not own any collectibles/);
  const bot = interaction(a, { options: { user: { id: C, bot: true } } });
  await collection.execute(bot);
  assert.match(bot.replies[0].content, /Bots do not have an account/);
});

test('ten items to a page, and the buttons turn the page', async () => {
  const a = member(A);
  const ids = [];
  for (let k = 1; k <= 23; k++) ids.push(await badge(`Badge ${k}`));
  await own(a, ...ids);
  const i = interaction(a);
  await collection.execute(i);
  const first = i.replies[0];
  assert.equal(first.embeds.length, 10);
  assert.match(first.content, /23 collectibles · page 1 of 3/);
  const [prev, next] = buttons(first).filter((c) => c.style === 2);
  assert.deepEqual([prev.disabled, next.disabled, next.custom_id], [true, false, `coll:2:${A}`]);
  assert.deepEqual([prev.emoji.name, next.emoji.name], ['⬅️', '➡️']);

  const third = press(a, `coll:3:${A}`);
  await routeComponent(third);
  assert.equal(third.out[0].update.embeds.length, 3);
  assert.equal(third.out[0].update.embeds[0].data.title, 'Badge 21');
  assert.match(third.out[0].update.content, /page 3 of 3/);
  const past = press(a, `coll:99:${A}`);
  await routeComponent(past);
  assert.match(past.out[0].update.content, /page 3 of 3/);
});

test('a page button is checked on every press: with the setting off, only the owner may turn the pages', async () => {
  const a = member(A);
  const b = member(B);
  const ids = [];
  for (let k = 1; k <= 12; k++) ids.push(await badge(`Badge ${k}`));
  await own(a, ...ids);

  // shown publicly while the setting was on ...
  await setPublic(true);
  const viewer = press(b, `coll:2:${A}`);
  await routeComponent(viewer);
  assert.equal(viewer.out[0].update.embeds.length, 2, 'on: anyone may turn the pages of a shown collection');
  // ... and no longer once it is off
  await setPublic(false);
  const blocked = press(b, `coll:2:${A}`);
  await routeComponent(blocked);
  assert.equal(blocked.out[0].update, undefined, 'nothing of the collection is sent');
  assert.equal(blocked.out[0].reply.flags, MessageFlags.Ephemeral);
  assert.match(blocked.out[0].reply.content, /private/);
  const owner = press(a, `coll:2:${A}`);
  await routeComponent(owner);
  assert.equal(owner.out[0].update.embeds.length, 2, 'the owner can still turn the pages');
  // a button with a made-up member id does nothing
  const bad = press(a, 'coll:2:abc');
  await routeComponent(bad);
  assert.deepEqual(bad.out, [{ deferred: true }]);
});

test('with the Economy module off every press and command says so or does nothing', async () => {
  const a = member(A);
  await own(a, await badge('x'));
  await setGuildModule(G, 'economy', { enabled: false, config: {} });
  const i = interaction(a);
  await collection.execute(i);
  assert.match(i.replies[0].content, /module is off/);
  const dm = interaction(a, { inGuild: false });
  await collection.execute(dm);
  assert.match(dm.replies[0].content, /in a server/);
  const p = press(a, `coll:1:${A}`);
  await routeComponent(p);
  assert.deepEqual(p.out, [{ deferred: true }]);
});

test('a deleted item stays in the collection as "item removed", and /inventory lists collectibles too', async () => {
  const a = member(A);
  const id = await badge('Gone soon', { rarity: 'epic' });
  await own(a, id);
  await deleteItem(G, id);
  const i = interaction(a);
  await collection.execute(i);
  const embed = i.replies[0].embeds[0].data;
  assert.equal(embed.title, 'Gone soon');
  assert.match(embed.description, /Epic · item removed · since/);
  assert.match(embed.thumbnail.url, /\/c\/[0-9a-f]{32}\.png$/, 'the picture is kept');

  const inv = interaction(a);
  await inventory.execute(inv);
  assert.match(inv.replies[0].embeds[0].data.description, /\*\*Gone soon\*\* · collectible · <t:\d+:d>/);
});

test('on Fluxer the pages turn with reactions: the same two buttons, and the pictures are plain embed images', async () => {
  const fluxer = { isReady: () => true, guilds: { cache: new Map() }, users: { fetch: async () => null } };
  runtime.clients.fluxer = fluxer;
  try {
    ctx.guild.client = fluxer;
    G = `fluxer:${G}`; // on Fluxer the server key is the id with the platform in front, everywhere
    await setGuildModule(G, 'economy', { enabled: true, config: {} });
    const a = member(A);
    const ids = [];
    for (let k = 1; k <= 11; k++) ids.push(await badge(`Badge ${k}`));
    await own(a, ...ids);
    const i = interaction(a);
    await collection.execute(i);
    const comps = buttons(i.replies[0]);
    assert.deepEqual(
      comps.filter((c) => c.style === 2).map((c) => c.emoji.name),
      ['⬅️', '➡️']
    );
    assert.equal(i.replies[0].embeds.length, 10);
    assert.ok(i.replies[0].embeds.every((e) => e.data.thumbnail.url.includes('/c/')));
  } finally {
    runtime.clients.fluxer = null;
  }
});
