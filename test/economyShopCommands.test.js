// /shop, /buy and /inventory: the list and its pages, the menu and the confirmation, buying by name or
// number, the suggestions while typing, what an inventory shows to its owner and to others, and the
// Fluxer form (a numbered list with paging reactions, no menu).
import './helpers/dashboardUrl.js';
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { getAccount } from '../src/db/economy.js';
import { createItem, getItem, listInventory, updateItem } from '../src/db/economyShop.js';
import { setGuildModule } from '../src/db/modules.js';
import { runtime } from '../src/runtime.js';
import { parseArgs } from '../src/bot/framework/parser.js';
import { loadCommands } from '../src/bot/loadCommands.js';
import { routeComponent } from '../src/bot/lib/components.js';
import { GROUPS, otherCommands } from '../src/bot/commands/help.js';
import * as shop from '../src/bot/commands/shop.js';
import * as buy from '../src/bot/commands/buy.js';
import * as inventory from '../src/bot/commands/inventory.js';
import { credit } from '../src/modules/lib/economy.js';
import { normaliseEconomyConfig, normaliseItem } from '../src/modules/lib/economyConfig.js';
import { dropFakeShop, fakeMember, fakeRole, fakeShopGuild, ROLE_A, ROLE_REQ } from './helpers/fakeShop.js';

let n = 0;
let G;
let ctx;
const config = normaliseEconomyConfig({});
const U = '8100000000000001';
const V = '8100000000000002';

beforeEach(async () => {
  G = `5900000000000${String(++n).padStart(5, '0')}`;
  ctx = fakeShopGuild(G, { roles: [fakeRole(ROLE_A, 'Millionaire'), fakeRole(ROLE_REQ, 'Member')] });
  await setGuildModule(G, 'economy', { enabled: true, config: { webShop: true } });
});
afterEach(() => dropFakeShop());

const mk = (over = {}) =>
  createItem(G, normaliseItem({ name: 'Shout-out', price: 100, type: 'custom', ...over }));
const member = async (id, cash = 500, roles = []) => {
  const m = fakeMember(id, { roles });
  ctx.guild.members.cache.set(id, m);
  if (cash > 0) await credit(G, id, cash, { kind: 'staff_add', config });
  return m;
};
const cash = async (id) => Number((await getAccount(G, id))?.cash ?? 0);

function interaction(m, { options = {}, inGuild = true } = {}) {
  const replies = [];
  return {
    replies,
    inGuild: () => inGuild,
    guildId: G,
    guild: ctx.guild,
    user: m.user,
    member: m,
    options: {
      getUser: (k) => options[k] ?? null,
      getString: (k) => options[k] ?? null,
      getFocused: () => options.focused ?? '',
    },
    reply: async (p) => replies.push(p),
    respond: async (c) => replies.push({ choices: c }),
  };
}
const said = (i) => i.replies.map((r) => r.content ?? '').join('\n');
const buttons = (payload) => (payload.components ?? []).flatMap((row) => row.toJSON().components);

test('every shop command says so when the module is off or it is not a server', async () => {
  const m = await member(U);
  await setGuildModule(G, 'economy', { enabled: false, config: {} });
  for (const mod of [shop, buy, inventory]) {
    const off = interaction(m, { options: { item: 'x' } });
    await mod.execute(off);
    assert.match(said(off), /module is off/, mod.data.name);
    const dm = interaction(m, { inGuild: false });
    await mod.execute(dm);
    assert.match(said(dm), /in a server/);
  }
  const typing = interaction(m, { options: { focused: 'a' } });
  await buy.autocomplete(typing);
  assert.deepEqual(typing.replies[0].choices, []);
});

test('/shop lists the items for sale, numbered, with price, kind, stock and a lock for a missing role', async () => {
  const m = await member(U);
  await mk({ name: 'Shout-out', price: 100, description: 'On stream', stock: 5 });
  await mk({
    name: 'Millionaire',
    type: 'temp_role',
    roleId: ROLE_A,
    durationHours: 168,
    price: 5000,
    emoji: '💰',
  });
  await mk({ name: 'VIP', requiredRoles: [ROLE_REQ], price: 50 });
  await mk({ name: 'Hidden', enabled: false });
  await mk({ name: 'Gone', stock: 0 });
  const i = interaction(m);
  await shop.execute(i);
  const embed = i.replies[0].embeds[0].data;
  assert.match(embed.title, /Shop of Shop Test/);
  const text = embed.description;
  assert.match(text, /\*\*1\.\*\* Shout-out — 🪙 100 coins · 5 left\nOn stream/);
  assert.match(text, /\*\*2\.\*\* 💰 Millionaire \(role for 168h\) — 🪙 5,000 coins/);
  assert.match(text, /\*\*3\.\*\* 🔒 VIP — 🪙 50 coins/);
  assert.doesNotMatch(text, /Hidden/);
  assert.match(text, /\*\*4\.\*\* Gone — 🪙 100 coins · sold out/);
  assert.deepEqual([embed.fields[0].name, embed.fields[0].value], ['Your cash', '🪙 500 coins']);
  assert.deepEqual(i.replies[0].allowedMentions, { parse: [] });
});

test('/shop offers a menu to pick an item and a link to the web shop when it is switched on', async () => {
  const m = await member(U);
  await mk({ name: 'A' });
  await mk({ name: 'B' });
  const i = interaction(m);
  await shop.execute(i);
  const rows = i.replies[0].components.map((r) => r.toJSON().components);
  const menu = rows[0][0];
  assert.equal(menu.custom_id, 'shop:pick');
  assert.deepEqual(
    menu.options.map((o) => o.label),
    ['1. A', '2. B']
  );
  assert.deepEqual(
    menu.options.map((o) => o.description),
    ['100 coins', '100 coins']
  );
  const link = rows.flat().find((c) => c.style === 5);
  assert.equal(link.label, 'Open the shop on the web');
  assert.equal(link.url, `https://sylo.example.test/shop/${G}`);

  await setGuildModule(G, 'economy', { enabled: true, config: { webShop: false } });
  const off = interaction(m);
  await shop.execute(off);
  assert.equal(
    buttons(off.replies[0]).find((c) => c.style === 5),
    undefined,
    'no link while the web shop is off'
  );
});

test('/shop pages ten items at a time and the buttons turn the page', async () => {
  const m = await member(U);
  for (let i = 1; i <= 23; i++) await mk({ name: `Item ${i}`, price: i });
  const i = interaction(m);
  await shop.execute(i);
  const first = i.replies[0];
  assert.equal(first.embeds[0].data.description.split('\n\n').length, 10);
  assert.match(first.embeds[0].data.footer.text, /Page 1 of 3/);
  const [prev, next] = buttons(first).filter((c) => c.style === 2);
  assert.deepEqual([prev.disabled, next.disabled, next.custom_id], [true, false, `shop:page:2:${U}`]);
  assert.deepEqual([prev.emoji.name, next.emoji.name], ['⬅️', '➡️']);

  const updates = [];
  await routeComponent({
    customId: `shop:page:3:${U}`,
    guildId: G,
    guild: ctx.guild,
    member: m,
    user: m.user,
    deferUpdate: async () => {},
    update: async (p) => updates.push(p),
  });
  assert.equal(updates[0].embeds[0].data.description.split('\n\n').length, 3);
  assert.match(updates[0].embeds[0].data.description, /\*\*21\.\*\* Item 21/);
  assert.match(updates[0].embeds[0].data.footer.text, /Page 3 of 3/);
  // a page past the end shows the last
  await routeComponent({
    customId: `shop:page:99:${U}`,
    guildId: G,
    guild: ctx.guild,
    member: m,
    user: m.user,
    deferUpdate: async () => {},
    update: async (p) => updates.push(p),
  });
  assert.match(updates[1].embeds[0].data.footer.text, /Page 3 of 3/);
});

/** What the component router needs for a press of a confirm button (the interaction is deferred, then edited). */
function press(m, customId) {
  const edits = [];
  return {
    edits,
    guildId: G,
    guild: ctx.guild,
    member: m,
    user: m.user,
    customId,
    isRepliable: () => true,
    deferred: false,
    deferUpdate: async function () {
      this.deferred = true;
    },
    editReply: async function (p) {
      assert.equal(this.deferred, true, 'the answer is deferred before the purchase runs');
      edits.push(p);
    },
    reply: async (p) => edits.push({ replied: p }),
    update: async (p) => edits.push(p),
  };
}

test('picking an item in the menu asks first; the confirm button buys; cancel does not', async () => {
  const m = await member(U);
  const id = await mk({ name: 'Shout-out', price: 100 });
  const replies = [];
  const base = { guildId: G, guild: ctx.guild, member: m, user: m.user, isRepliable: () => true };
  await routeComponent({
    ...base,
    customId: 'shop:pick',
    values: [String(id)],
    reply: async (p) => replies.push(p),
  });
  assert.match(replies[0].content, /Buy \*\*Shout-out\*\* for 🪙 100 coins\?/);
  assert.equal(replies[0].flags, MessageFlags.Ephemeral);
  const confirm = replies[0].components[0].toJSON().components;
  // the button carries the price the member saw
  assert.deepEqual(
    confirm.map((c) => c.custom_id),
    [`shop:buy:${id}:100:${(await getItem(G, id)).updatedAt}`, 'shop:no']
  );
  assert.equal(await cash(U), 500, 'nothing is charged for picking');

  const updates = [];
  await routeComponent({ ...base, customId: 'shop:no', update: async (p) => updates.push(p) });
  assert.equal(updates[0].content, 'Cancelled.');
  assert.equal(await cash(U), 500);

  const bought = press(m, `shop:buy:${id}:100:${(await getItem(G, id)).updatedAt}`);
  await routeComponent(bought);
  assert.match(
    bought.edits[0].content,
    /You bought \*\*Shout-out\*\* for 🪙 100 coins\. Staff were told.*400 coins left/
  );
  assert.equal(await cash(U), 400);
  assert.deepEqual(bought.edits[0].components, []);

  // an item that is gone by the time the member presses
  const gone = [];
  await routeComponent({
    ...base,
    customId: 'shop:pick',
    values: ['999999'],
    reply: async (p) => gone.push(p),
  });
  assert.match(gone[0].content, /no longer for sale/);
});

test('the confirm button buys at the price that was shown: a price that changed meanwhile charges nothing', async () => {
  const m = await member(U);
  const id = await mk({ name: 'Shout-out', price: 100 });
  const asked = [];
  await routeComponent({
    guildId: G,
    guild: ctx.guild,
    member: m,
    user: m.user,
    customId: 'shop:pick',
    values: [String(id)],
    reply: async (p) => asked.push(p),
  });
  const button = asked[0].components[0].toJSON().components[0].custom_id;
  // staff raise the price while the question is on screen
  await updateItem(G, id, normaliseItem({ name: 'Shout-out', price: 5000, type: 'custom' }));
  const pressed = press(m, button);
  await routeComponent(pressed);
  assert.match(pressed.edits[0].content, /The price changed to 🪙 5,000 coins\. Check and try again\./);
  assert.equal(await cash(U), 500, 'nothing was charged');
  assert.equal((await getItem(G, id)).sold, 0);
  // an old button without a price never buys
  const old = press(m, `shop:buy:${id}`);
  await routeComponent(old);
  assert.match(old.edits[0].content, /price changed/);
  assert.equal(await cash(U), 500);
});

test('/buy finds an item by exact name, by number and by a part of the name, and asks with the price', async () => {
  const m = await member(U, 1000);
  await mk({ name: 'Shout-out', price: 100 });
  await mk({ name: 'Millionaire', price: 200 });
  await mk({ name: 'Mini shout', price: 10 });

  const asks = async (text) => {
    const i = interaction(m, { options: { item: text } });
    await buy.execute(i);
    return i;
  };
  const byName = await asks('millionaire');
  assert.match(said(byName), /Buy \*\*Millionaire\*\* for 🪙 200 coins\?/);
  assert.equal(byName.replies[0].flags, MessageFlags.Ephemeral);
  const confirmId = buttons(byName.replies[0])[0].custom_id;
  assert.match(confirmId, /^shop:buy:\d+:200:\d+$/, 'the question carries the price and version');
  assert.match(said(await asks('1')), /Buy \*\*Shout-out\*\* for 🪙 100/);
  assert.match(said(await asks('mini')), /Buy \*\*Mini shout\*\* for 🪙 10/);
  assert.equal(await cash(U), 1000, '/buy itself charges nothing: the button does');

  // the button buys it, deferring first
  const pressed = press(m, confirmId);
  await routeComponent(pressed);
  assert.match(pressed.edits[0].content, /You bought \*\*Millionaire\*\* for 🪙 200 coins/);
  assert.equal(await cash(U), 800);

  assert.match(
    said(await asks('shout')),
    /More than one item matches: \*\*Shout-out\*\*, \*\*Mini shout\*\*/
  );
  assert.match(said(await asks('nothing')), /There is no such item/);
  const poor = await member(V, 5);
  const ask = interaction(poor, { options: { item: 'millionaire' } });
  await buy.execute(ask);
  const broke = press(poor, buttons(ask.replies[0])[0].custom_id);
  await routeComponent(broke);
  assert.match(broke.edits[0].content, /do not have enough cash: it costs .*200/);
});

test('/buy of a role item the bot cannot hand out says why, before asking', async () => {
  ctx = fakeShopGuild(G, { roles: [fakeRole(ROLE_A, 'Millionaire')], canManageRoles: false });
  const m = await member(U);
  await mk({ name: 'Role', type: 'role', roleId: ROLE_A });
  const i = interaction(m, { options: { item: 'role' } });
  await buy.execute(i);
  assert.match(said(i), /Manage Roles.*Nothing was charged/);
  assert.equal(await cash(U), 500);
});

test('while an economy reset runs, a shop command answers at once instead of waiting', async () => {
  const m = await member(U);
  await mk({ name: 'Shout-out', price: 100 });
  const { resetGuild } = await import('../src/modules/lib/economy.js');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  // a reset that is held open inside its first chunk
  const running = resetGuild(G, { config, beforeChunk: () => gate });
  await new Promise((r) => setTimeout(r, 20));
  for (const mod of [shop, buy, inventory]) {
    const i = interaction(m, { options: { item: 'shout' } });
    await mod.execute(i);
    assert.match(said(i), /Economy reset in progress, try again shortly\./, mod.data.name);
  }
  const pressed = press(m, 'shop:buy:1:100');
  await routeComponent(pressed);
  assert.match(JSON.stringify(pressed.edits), /Economy reset in progress/);
  release();
  await running;
  const after = interaction(m, { options: { item: 'shout' } });
  await buy.execute(after);
  assert.match(said(after), /Buy \*\*Shout-out\*\*/);
});

test('/buy suggests the names of items for sale while typing', async () => {
  const m = await member(U);
  await mk({ name: 'Shout-out' });
  await mk({ name: 'Millionaire' });
  await mk({ name: 'Hidden', enabled: false });
  const all = interaction(m, { options: { focused: '' } });
  await buy.autocomplete(all);
  assert.deepEqual(
    all.replies[0].choices.map((c) => c.value),
    ['Shout-out', 'Millionaire']
  );
  const some = interaction(m, { options: { focused: 'MILL' } });
  await buy.autocomplete(some);
  assert.deepEqual(some.replies[0].choices, [{ name: 'Millionaire', value: 'Millionaire' }]);
});

test('/inventory: your own is complete and private; another member shows only names, publicly', async () => {
  const a = await member(U, 1000);
  await member(V, 0);
  const custom = await mk({ name: 'Shout-out', price: 100 });
  void custom;
  const temp = await mk({
    name: 'Millionaire',
    type: 'temp_role',
    roleId: ROLE_A,
    durationHours: 24,
    price: 100,
  });
  void temp;
  const { buyNow } = await import('./helpers/fakeShop.js');
  for (const name of ['Shout-out', 'Millionaire']) {
    const id = (await (await import('../src/db/economyShop.js')).listItems(G)).find(
      (x) => x.name === name
    ).id;
    assert.equal((await buyNow({ guild: ctx.guild, member: a, itemId: id, config })).ok, true);
  }
  const own = interaction(a);
  await inventory.execute(own);
  assert.equal(own.replies[0].flags, MessageFlags.Ephemeral);
  const lines = own.replies[0].embeds[0].data.description.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\*\*Millionaire\*\* · until <t:\d+:f> · <t:\d+:d>/);
  assert.match(lines[1], /\*\*Shout-out\*\* · waiting for staff · <t:\d+:d>/);

  const other = interaction(await member('8100000000000003', 0), { options: { user: a.user } });
  await inventory.execute(other);
  assert.equal(other.replies[0].flags, undefined, 'public');
  assert.equal(other.replies[0].embeds[0].data.description, '• Millionaire\n• Shout-out', 'names only');

  const empty = interaction(await member('8100000000000004', 0));
  await inventory.execute(empty);
  assert.match(said(empty), /do not own anything yet/);
  const bot = interaction(a, { options: { user: { id: V, bot: true } } });
  await inventory.execute(bot);
  assert.match(said(bot), /Bots do not have an account/);
  assert.equal((await listInventory(G, U)).length, 2);
});

test('on Fluxer the shop is a numbered list without a menu, still with the paging buttons', async () => {
  const fluxer = { isReady: () => true, guilds: { cache: new Map() }, users: { fetch: async () => null } };
  runtime.clients.fluxer = fluxer;
  try {
    ctx.guild.client = fluxer;
    const m = await member(U);
    for (let i = 1; i <= 12; i++) await mk({ name: `Item ${i}` });
    const i = interaction(m);
    await shop.execute(i);
    const comps = buttons(i.replies[0]);
    assert.equal(
      comps.some((c) => c.options),
      false,
      'no select menu'
    );
    assert.deepEqual(
      comps.filter((c) => c.style === 2).map((c) => c.emoji.name),
      ['⬅️', '➡️']
    );
    assert.match(i.replies[0].embeds[0].data.description, /\*\*1\.\*\* Item 1/);
  } finally {
    runtime.clients.fluxer = null;
  }
});

test('the three commands are loaded, listed in help under Shop, and parse from chat', async () => {
  const commands = await loadCommands();
  for (const name of ['shop', 'buy', 'inventory']) assert.ok(commands.has(name), name);
  const group = GROUPS.find((g) => g.name === 'Shop');
  assert.deepEqual(group.commands, ['shop', 'buy', 'inventory']);
  assert.deepEqual(
    otherCommands(commands).map((c) => c.data.name),
    []
  );
  const schema = (name) => commands.get(name).data.toJSON();
  assert.equal(
    parseArgs(schema('buy'), 'Shout-out for free').values.item.value,
    'Shout-out for free',
    'a name with spaces'
  );
  assert.equal(parseArgs(schema('buy'), '3').values.item.value, '3');
  assert.equal(
    parseArgs(schema('inventory'), '<@123456789012345678>').values.user.value,
    '<@123456789012345678>'
  );
  assert.equal(schema('buy').options[0].autocomplete, true);
});
