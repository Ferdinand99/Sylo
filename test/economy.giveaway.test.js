// Giveaways with the Economy module: the entry fee (charged on entry, given back on leave and on
// cancel, never twice), the currency prize at the draw and on a reroll, and the /giveaway options.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { db } from '../src/db/index.js';
import { getAccount } from '../src/db/economy.js';
import {
  createGiveaway,
  getGiveaway,
  giveawayEntrantIds,
  giveawayEntryCount,
  hasGiveawayEntry,
  addGiveawayEntry,
} from '../src/db/giveaways.js';
import { setGuildModule } from '../src/db/modules.js';
import { routeComponent } from '../src/bot/lib/components.js';
import * as giveawayCommand from '../src/bot/commands/giveaway.js';
import {
  cancelGiveaway,
  endGiveaway,
  buildGiveawayPayload,
  clampEntryFee,
  clampPrizeAmount,
} from '../src/modules/giveaways.js';
import { credit } from '../src/modules/lib/economy.js';
import { normaliseEconomyConfig } from '../src/modules/lib/economyConfig.js';
import { dropFakeShop, fakeMember, fakeShopGuild } from './helpers/fakeShop.js';

let n = 0;
let G;
let ctx;
const config = normaliseEconomyConfig({});
const U = (i) => `8900000000000${String(i).padStart(5, '0')}`;
const CH = '700000000000000201'; // the fake guild's channel (SHOP_CH)

beforeEach(async () => {
  G = `5800000000000${String(++n).padStart(5, '0')}`;
  ctx = fakeShopGuild(G);
  await setGuildModule(G, 'giveaways', { enabled: true, config: {} });
  await setGuildModule(G, 'economy', { enabled: true, config: {} });
});
afterEach(() => dropFakeShop());

const cash = async (id) => Number((await getAccount(G, id))?.cash ?? 0);
const ledger = (id) =>
  db
    .prepare(
      'SELECT kind, amount, reason FROM economy_transactions WHERE guild_id = ? AND user_id = ? ORDER BY id'
    )
    .all(G, id);
async function member(i, money = 500) {
  const m = fakeMember(U(i));
  ctx.guild.members.cache.set(m.id, m);
  if (money > 0) await credit(G, m.id, money, { kind: 'staff_add', config });
  return m;
}
const start = async (over = {}) =>
  (
    await createGiveaway({
      guildId: G,
      channelId: CH,
      prize: 'A thing',
      winners: 1,
      hostId: 'host',
      endsAt: Date.now() + 3_600_000,
      ...over,
    })
  ).id;

/** Press the Enter button as `m`; resolves to what the member is told. */
async function press(id, m) {
  const replies = [];
  await routeComponent({
    customId: `gaw:enter:${id}`,
    guildId: G,
    member: m,
    user: m.user,
    message: { edit: async () => {} },
    reply: async (p) => replies.push(p),
    isRepliable: () => true,
  });
  return replies[0];
}

test('an entry fee is charged when a member enters, and the entry is added with it', async () => {
  const m = await member(1);
  const id = await start({ entryFee: 50 });
  const reply = await press(id, m);
  assert.match(reply.content, /You're in/);
  assert.match(reply.content, /50 coins was taken/);
  assert.equal(reply.flags, MessageFlags.Ephemeral);
  assert.equal(await cash(m.id), 450);
  assert.equal(await hasGiveawayEntry(id, m.id), true);
  assert.deepEqual(ledger(m.id).at(-1), { kind: 'giveaway_entry', amount: -50, reason: `Giveaway #${id}` });
});

test('leaving before the draw gives the fee back and removes the entry; entering again charges again', async () => {
  const m = await member(2);
  const id = await start({ entryFee: 50 });
  await press(id, m);
  const left = await press(id, m);
  assert.match(left.content, /You've left/);
  assert.match(left.content, /was given back/);
  assert.equal(await cash(m.id), 500);
  assert.equal(await hasGiveawayEntry(id, m.id), false);
  assert.deepEqual(
    ledger(m.id)
      .slice(-2)
      .map((r) => [r.kind, r.amount]),
    [
      ['giveaway_entry', -50],
      ['refund', 50],
    ]
  );
  await press(id, m);
  assert.equal(await cash(m.id), 450);
});

test('not enough cash: no entry, no charge, no ledger row', async () => {
  const m = await member(3, 40);
  const id = await start({ entryFee: 50 });
  const reply = await press(id, m);
  assert.match(reply.content, /You need 50 in cash to enter/);
  assert.equal(await hasGiveawayEntry(id, m.id), false);
  assert.equal(await cash(m.id), 40);
  assert.equal(ledger(m.id).length, 1);
});

test('two clicks at once charge once: the second one finds the entry and gives the fee back', async () => {
  const m = await member(4);
  const id = await start({ entryFee: 50 });
  await Promise.all([press(id, m), press(id, m)]);
  const entered = await hasGiveawayEntry(id, m.id);
  // either order of the two transactions leaves a consistent member: in with 450, or out with 500
  assert.deepEqual([entered, await cash(m.id)].join(), entered ? 'true,450' : 'false,500');
  const net = ledger(m.id)
    .filter((r) => r.kind !== 'staff_add')
    .reduce((sum, r) => sum + r.amount, 0);
  assert.equal(net, entered ? -50 : 0, 'what was taken matches whether there is an entry');
});

test('a giveaway without a fee keeps working as before, and needs no money', async () => {
  const m = await member(5, 0);
  const id = await start();
  assert.match((await press(id, m)).content, /You're in/);
  assert.equal(await hasGiveawayEntry(id, m.id), true);
  assert.match((await press(id, m)).content, /You've left/);
  assert.equal(ledger(m.id).length, 0);
});

test('with the Economy module off an entry fee cannot be paid, and nobody enters', async () => {
  const m = await member(6);
  const id = await start({ entryFee: 50 });
  await setGuildModule(G, 'economy', { enabled: false, config: {} });
  assert.match((await press(id, m)).content, /Economy module is off/);
  assert.equal(await giveawayEntryCount(id), 0);
});

test('cancelling refunds every entrant, ends the giveaway without a draw and closes it', async () => {
  const a = await member(7);
  const b = await member(8);
  const id = await start({ entryFee: 50, prizeAmount: 300 });
  await press(id, a);
  await press(id, b);
  const out = await cancelGiveaway(id);
  assert.deepEqual([out.ok, out.refunded, out.failed], [true, 2, 0]);
  assert.equal(await cash(a.id), 500);
  assert.equal(await cash(b.id), 500);
  const g = await getGiveaway(id);
  assert.deepEqual([g.ended, g.cancelled, g.wonIds], [true, true, []]);
  assert.equal(await giveawayEntryCount(id), 0, 'every entry was removed with its refund');
  assert.equal(ledger(a.id).at(-1).kind, 'refund');
  assert.match(ledger(a.id).at(-1).reason, /cancelled/);
  const again = await cancelGiveaway(id);
  assert.deepEqual([again.ok, again.reason], [false, 'already-ended']);
  assert.equal(await cash(a.id), 500, 'no second refund');
  assert.match(buildGiveawayPayload(g, { entryCount: 0 }).embeds[0].data.description, /cancelled/);
});

test('nobody can enter after a giveaway ended or was cancelled', async () => {
  const m = await member(9);
  const id = await start({ entryFee: 50 });
  await cancelGiveaway(id);
  assert.match((await press(id, m)).content, /has ended/);
  assert.equal(await cash(m.id), 500);
});

test('the draw pays the currency prize to every winner, and the announcement says so', async () => {
  const a = await member(10);
  const b = await member(11);
  const c = await member(12);
  const id = await start({ winners: 2, prizeAmount: 250 });
  for (const m of [a, b, c]) await addGiveawayEntry(id, m.id);
  const out = await endGiveaway(id);
  assert.equal(out.winners.length, 2);
  for (const w of out.winners) {
    assert.equal(await cash(w), 750);
    assert.deepEqual(ledger(w).at(-1), { kind: 'giveaway_prize', amount: 250, reason: `Giveaway #${id}` });
  }
  const loser = [a, b, c].find((m) => !out.winners.includes(m.id));
  assert.equal(await cash(loser.id), 500);
  assert.match(ctx.sent.at(-1).content, /250 coins each/);
});

test('a reroll pays only the new winners', async () => {
  const members = [];
  for (let i = 0; i < 4; i++) members.push(await member(20 + i));
  const id = await start({ winners: 1, prizeAmount: 100 });
  for (const m of members) await addGiveawayEntry(id, m.id);
  const first = await endGiveaway(id);
  const again = await endGiveaway(id, { rerollCount: 1 });
  assert.equal(again.winners.length, 1);
  assert.notEqual(again.winners[0], first.winners[0]);
  assert.equal(await cash(first.winners[0]), 600, 'paid once');
  assert.equal(await cash(again.winners[0]), 600, 'the new winner is paid too');
});

test('a giveaway with a text prize only draws as before and pays nothing', async () => {
  const a = await member(30);
  const id = await start();
  await addGiveawayEntry(id, a.id);
  const out = await endGiveaway(id);
  assert.deepEqual(out.winners, [a.id]);
  assert.equal(await cash(a.id), 500);
  assert.doesNotMatch(ctx.sent.at(-1).content, /each/);
});

test('the entry fee and the prize are clamped, and shown on the giveaway message', async () => {
  assert.equal(clampEntryFee(0), 0);
  assert.equal(clampEntryFee(-3), 0);
  assert.equal(clampEntryFee('x'), 0);
  assert.equal(clampEntryFee(99_999_999), 1_000_000);
  assert.equal(clampPrizeAmount(5), 5);
  assert.equal(clampPrizeAmount(9_999_999_999), 1_000_000_000);
  const id = await start({ entryFee: 25, prizeAmount: 400 });
  const text = buildGiveawayPayload(await getGiveaway(id), { entryCount: 0 }).embeds[0].data.description;
  assert.match(text, /Entry fee: \*\*25\*\*/);
  assert.match(text, /Each winner also gets \*\*400\*\*/);
});

// --- the command ----------------------------------------------------------------------------------------------

function startInteraction(opts) {
  const replies = [];
  return {
    replies,
    guildId: G,
    channelId: CH,
    user: { id: 'host' },
    options: {
      getSubcommand: () => 'start',
      getString: (k) => ({ prize: 'Cool prize', duration: '1h' })[k] ?? null,
      getInteger: (k) => opts[k] ?? null,
      getRole: () => null,
    },
    reply: async (p) => replies.push(p),
    fetchReply: async () => ({ id: 'msg1' }),
    followUp: async (p) => replies.push(p),
  };
}

test('/giveaway start takes an entry fee and a prize only while the Economy module is on', async () => {
  await setGuildModule(G, 'economy', { enabled: false, config: {} });
  const off = startInteraction({ entry_fee: 50, prize_amount: 100 });
  await giveawayCommand.execute(off);
  assert.match(off.replies[0].content, /needs the Economy module/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM giveaways WHERE guild_id = ?').get(G).c, 0);

  await setGuildModule(G, 'economy', { enabled: true, config: {} });
  const on = startInteraction({ entry_fee: 50, prize_amount: 100 });
  await giveawayCommand.execute(on);
  const row = db.prepare('SELECT entry_fee, prize_amount FROM giveaways WHERE guild_id = ?').get(G);
  assert.deepEqual({ ...row }, { entry_fee: 50, prize_amount: 100 });
  assert.match(on.replies[0].embeds[0].data.description, /Entry fee: \*\*50\*\*/);

  const plain = startInteraction({});
  await giveawayCommand.execute(plain);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM giveaways WHERE guild_id = ?').get(G).c, 2);
});

test('/giveaway cancel gives the fees back and refuses an ended giveaway', async () => {
  const m = await member(40);
  const id = await start({ entryFee: 50 });
  await press(id, m);
  const replies = [];
  const interaction = (gid) => ({
    guildId: G,
    options: { getSubcommand: () => 'cancel', getInteger: () => gid },
    reply: async (p) => replies.push(p),
  });
  await giveawayCommand.execute(interaction(id));
  assert.match(replies[0].content, /Cancelled .*1 entry fee\(s\) were given back/);
  assert.equal(await cash(m.id), 500);
  await giveawayCommand.execute(interaction(id));
  assert.match(replies[1].content, /already ended/);
  await giveawayCommand.execute(interaction(999999));
  assert.match(replies[2].content, /No giveaway/);
  assert.deepEqual(await giveawayEntrantIds(id), []);
});
