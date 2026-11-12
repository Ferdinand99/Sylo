// The Economy commands, run with stand-in interactions: the module gate, what each command says,
// the page buttons of the leaderboard, and that the chat form (Fluxer) reads each command's schema.
import './helpers/tmpDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { db } from '../src/db/index.js';
import { getAccount } from '../src/db/economy.js';
import { setGuildModule } from '../src/db/modules.js';
import { parseArgs } from '../src/bot/framework/parser.js';
import { loadCommands } from '../src/bot/loadCommands.js';
import { routeComponent } from '../src/bot/lib/components.js';
import { GROUPS, otherCommands } from '../src/bot/commands/help.js';
import { credit } from '../src/modules/lib/economy.js';
import { normaliseEconomyConfig } from '../src/modules/lib/economyConfig.js';
import * as balance from '../src/bot/commands/balance.js';
import * as daily from '../src/bot/commands/daily.js';
import * as work from '../src/bot/commands/work.js';
import * as deposit from '../src/bot/commands/deposit.js';
import * as withdraw from '../src/bot/commands/withdraw.js';
import * as pay from '../src/bot/commands/pay.js';
import * as rob from '../src/bot/commands/rob.js';
import * as eco from '../src/bot/commands/eco.js';
import * as board from '../src/bot/commands/economy-leaderboard.js';

let n = 0;
let G;
const U = '800000000000000001';
const V = '800000000000000002';
const STAFF = '800000000000000100';
const config = normaliseEconomyConfig({});

beforeEach(() => {
  G = `5500000000000${String(++n).padStart(5, '0')}`;
});
const enable = (cfg = {}) => setGuildModule(G, 'economy', { enabled: true, config: cfg });
const cash = async (u) => Number((await getAccount(G, u))?.cash ?? 0);

/** An interaction for one command run. `options` maps option names to values. */
function interaction({
  userId = U,
  options = {},
  sub = null,
  manageGuild = false,
  inGuild = true,
  target,
  member = undefined,
} = {}) {
  const replies = [];
  const dms = [];
  const victim = target ?? {
    id: options.user ?? V,
    username: 'victim',
    bot: false,
    send: async (p) => dms.push(p),
  };
  const users = { user: options.user === undefined ? null : victim };
  return {
    replies,
    dms,
    inGuild: () => inGuild,
    guildId: G,
    guild: {
      id: G,
      name: 'Test Server',
      members: { fetch: async () => ({ joinedTimestamp: Date.now() - 7 * 86_400_000 }) },
    },
    user: { id: userId, username: 'caller', bot: false },
    member: { displayName: 'Caller' },
    memberPermissions: { has: () => manageGuild },
    options: {
      getUser: (name) => users[name] ?? null,
      getMember: () =>
        member === undefined
          ? { displayName: 'Victim', joinedTimestamp: Date.now() - 7 * 86_400_000 }
          : member,
      getInteger: (name) => options[name] ?? null,
      getString: (name) => options[name] ?? null,
      getSubcommand: () => sub,
    },
    reply: async (payload) => {
      replies.push(payload);
    },
  };
}
const said = (i) => i.replies.map((r) => r.content ?? '').join('\n');

test('every economy command says so when it is not in a server or the module is off', async () => {
  for (const mod of [balance, daily, work, deposit, withdraw, pay, rob, eco, board]) {
    const dm = interaction({ inGuild: false, options: { amount: '5' } });
    await mod.execute(dm);
    assert.match(said(dm), /in a server/, mod.data.name);
    const off = interaction({ options: { amount: '5', user: V }, manageGuild: true, sub: 'add' });
    await mod.execute(off);
    assert.match(said(off), /module is off/, mod.data.name);
    assert.equal(off.replies[0].flags, MessageFlags.Ephemeral);
  }
});

test('/balance of someone else shows only the total and the rank, publicly', async () => {
  await enable();
  await credit(G, V, 777, { kind: 'daily', config });
  const i = interaction({ options: { user: V } });
  await balance.execute(i);
  assert.deepEqual(
    i.replies[0].embeds[0].data.fields.map((f) => [f.name, f.value]),
    [
      ['Total', '🪙 777 coins'],
      ['Rank', '#1'],
    ]
  );
  assert.equal(i.replies[0].flags, undefined, 'the reply is public, with nothing robbable in it');
});

test('/balance shows cash, bank, total and rank, and only you see it', async () => {
  await enable();
  await credit(G, U, 1234, { kind: 'daily', config });
  const i = interaction();
  await balance.execute(i);
  assert.equal(i.replies[0].flags, MessageFlags.Ephemeral);
  const fields = i.replies[0].embeds[0].data.fields;
  assert.deepEqual(
    fields.map((f) => [f.name, f.value]),
    [
      ['Cash', '🪙 1,234 coins'],
      ['Bank', '🪙 0 coins'],
      ['Total', '🪙 1,234 coins'],
      ['Rank', '#1'],
    ]
  );
  assert.deepEqual(i.replies[0].allowedMentions, { parse: [] });
});

test('/balance of a bot is refused; of a member with no account shows zeros and no rank', async () => {
  await enable();
  const bot = interaction({ options: { user: V }, target: { id: V, username: 'robo', bot: true } });
  await balance.execute(bot);
  assert.match(said(bot), /Bots do not have an account/);
  const fresh = interaction({ options: { user: V } });
  await balance.execute(fresh);
  assert.equal(fresh.replies[0].embeds[0].data.fields.at(-1).value, 'Not ranked yet');
});

test('/balance hides the bank line when the bank is off', async () => {
  await enable({ bankEnabled: false });
  const i = interaction();
  await balance.execute(i);
  assert.deepEqual(
    i.replies[0].embeds[0].data.fields.map((f) => f.name),
    ['Cash', 'Total', 'Rank']
  );
});

test('/daily pays, then tells when to come back; /work does the same', async () => {
  await enable({ dailyBase: 100 });
  const first = interaction();
  await daily.execute(first);
  assert.match(said(first), /You claimed 🪙 100 coins/);
  assert.match(said(first), /start a streak/);
  const again = interaction();
  await daily.execute(again);
  assert.match(said(again), /try again <t:\d+:R>/);
  assert.equal(await cash(U), 100);

  const w = interaction();
  await work.execute(w);
  assert.match(said(w), /coins/);
  assert.ok((await cash(U)) > 100);
  const w2 = interaction();
  await work.execute(w2);
  assert.match(said(w2), /have to wait/);
});

test('/deposit and /withdraw read a number or "all", with thousands separators', async () => {
  await enable();
  await credit(G, U, 5000, { kind: 'daily', config });
  const d = interaction({ options: { amount: '1,000' } });
  await deposit.execute(d);
  assert.match(said(d), /deposited 🪙 1,000 coins\. Cash 🪙 4,000 coins · bank 🪙 1,000 coins/);
  const all = interaction({ options: { amount: 'ALL' } });
  await deposit.execute(all);
  assert.match(said(all), /deposited 🪙 4,000 coins/);
  const w = interaction({ options: { amount: '2500' } });
  await withdraw.execute(w);
  assert.match(said(w), /withdrew 🪙 2,500 coins/);
  for (const bad of ['0', '-5', 'ten', '1.5', '']) {
    const i = interaction({ options: { amount: bad } });
    await deposit.execute(i);
    assert.match(said(i), /whole number/, bad);
  }
  const more = interaction({ options: { amount: '999999' } });
  await withdraw.execute(more);
  assert.match(said(more), /not have enough/);
});

test('the bank commands say when the bank is off', async () => {
  await enable({ bankEnabled: false });
  const i = interaction({ options: { amount: '5' } });
  await deposit.execute(i);
  assert.match(said(i), /bank is turned off/);
});

test('/pay announces in the channel, pings only the recipient, and shows the tax', async () => {
  await enable({ payTaxPercent: 10 });
  await credit(G, U, 500, { kind: 'daily', config });
  const i = interaction({ options: { user: V, amount: 100 } });
  await pay.execute(i);
  const reply = i.replies[0];
  assert.equal(reply.flags, undefined, 'a public reply');
  assert.equal(reply.content, `<@${U}> paid <@${V}> 🪙 100 coins (and 🪙 10 coins tax).`);
  assert.deepEqual(reply.allowedMentions, { parse: [], users: [V] });
  assert.equal(await cash(U), 390);
  assert.equal(await cash(V), 100);
});

test('/pay refuses yourself, bots and too little money, privately', async () => {
  await enable();
  const self = interaction({
    options: { user: U, amount: 5 },
    target: { id: U, username: 'caller', bot: false },
  });
  await pay.execute(self);
  assert.match(said(self), /cannot do that to yourself/);
  const bot = interaction({
    options: { user: V, amount: 5 },
    target: { id: V, username: 'robo', bot: true },
  });
  await pay.execute(bot);
  assert.match(said(bot), /Bots do not have an account/);
  const poor = interaction({ options: { user: V, amount: 5 } });
  await pay.execute(poor);
  assert.match(said(poor), /not have enough/);
  assert.equal(poor.replies[0].flags, MessageFlags.Ephemeral);
});

test('/pay refuses someone who is not a member of the server, and moves nothing', async () => {
  await enable();
  await credit(G, U, 100, { kind: 'daily', config });
  const gone = interaction({ options: { user: V, amount: 10 }, member: null });
  gone.guild.members.fetch = async () => {
    throw new Error('Unknown Member');
  };
  await pay.execute(gone);
  assert.match(said(gone), /not in this server/);
  assert.equal(await cash(U), 100);
  assert.equal(await getAccount(G, V), null, 'no account was made for them');
});

test('/rob is refused while robbing is off (the default)', async () => {
  await enable();
  const i = interaction({ options: { user: V } });
  await rob.execute(i);
  assert.match(said(i), /Robbing is turned off/);
});

test('/rob posts the result in the channel and DMs the victim of a success', async () => {
  await enable({ robEnabled: true, robChancePercent: 99, robMinPercent: 10, robMaxPercent: 10 });
  await credit(G, V, 1000, { kind: 'daily', config });
  await credit(G, U, 50, { kind: 'daily', config });
  const realRandom = Math.random;
  Math.random = () => 0; // success, and the lowest share
  try {
    const i = interaction({ options: { user: V } });
    await rob.execute(i);
    assert.equal(i.replies[0].content, `<@${U}> robbed <@${V}> and got away with 🪙 100 coins!`);
    assert.equal(i.replies[0].flags, undefined, 'public');
    assert.equal(i.dms.length, 1);
    assert.match(i.dms[0].content, /You were robbed in \*\*Test Server\*\*.*🪙 100 coins/);
    assert.equal(await cash(V), 900);
    assert.equal(await cash(U), 150);
  } finally {
    Math.random = realRandom;
  }
});

test('/rob failure is announced with the fine and sends no DM', async () => {
  await enable({ robEnabled: true });
  await credit(G, V, 1000, { kind: 'daily', config });
  await credit(G, U, 400, { kind: 'daily', config });
  const realRandom = Math.random;
  Math.random = () => 0.99;
  try {
    const i = interaction({ options: { user: V } });
    await rob.execute(i);
    assert.equal(
      i.replies[0].content,
      `<@${U}> was caught trying to rob <@${V}> and paid a fine of 🪙 40 coins.`
    );
    assert.equal(i.dms.length, 0);
  } finally {
    Math.random = realRandom;
  }
});

test('/rob guards speak plainly: a new member, a poor victim, a bot, a member who left', async () => {
  await enable({ robEnabled: true });
  const broke = interaction({ options: { user: V } });
  await rob.execute(broke);
  assert.match(said(broke), /You need at least 🪙 25 coins cash to attempt a rob/);
  await credit(G, U, 100, { kind: 'daily', config });
  const poor = interaction({ options: { user: V } });
  await rob.execute(poor);
  assert.match(said(poor), /Not worth it/);
  const bot = interaction({ options: { user: V }, target: { id: V, username: 'robo', bot: true } });
  await rob.execute(bot);
  assert.match(said(bot), /Bots do not have an account/);
  const gone = interaction({ options: { user: V } });
  gone.options.getMember = () => null;
  gone.guild.members.fetch = async () => {
    throw new Error('Unknown Member');
  };
  await rob.execute(gone);
  assert.match(said(gone), /not in this server/);
});

test('/rob reads the join time of a Fluxer member (joinedAt, a Date) and keeps new members safe', async () => {
  await enable({ robEnabled: true });
  await credit(G, V, 1000, { kind: 'daily', config });
  await credit(G, U, 100, { kind: 'daily', config });
  const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000);
  // a Fluxer-shaped member: no joinedTimestamp, only joinedAt
  const fresh = interaction({ options: { user: V }, member: { joinedAt: hoursAgo(2) } });
  await rob.execute(fresh);
  assert.match(said(fresh), /joined too recently/);
  assert.equal(await cash(V), 1000);

  const old = interaction({ options: { user: V }, member: { joinedAt: hoursAgo(72) } });
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    await rob.execute(old);
  } finally {
    Math.random = realRandom;
  }
  assert.match(said(old), /got away with/);
});

test('/rob refuses when the join time cannot be read at all', async () => {
  await enable({ robEnabled: true });
  await credit(G, V, 1000, { kind: 'daily', config });
  await credit(G, U, 100, { kind: 'daily', config });
  const unknown = interaction({ options: { user: V }, member: { displayName: 'No dates' } });
  await rob.execute(unknown);
  assert.match(said(unknown), /can't verify how long they've been here/);
  assert.equal(await cash(V), 1000);
});

test('/eco needs Manage Server, and changes money with a reason', async () => {
  await enable();
  const denied = interaction({ sub: 'add', options: { user: V, amount: 5 } });
  await eco.execute(denied);
  assert.match(said(denied), /Manage Server/);
  assert.equal(await cash(V), 0);

  const add = interaction({
    userId: STAFF,
    sub: 'add',
    manageGuild: true,
    options: { user: V, amount: 250, reason: 'prize' },
  });
  await eco.execute(add);
  assert.match(
    said(add),
    /Added 🪙 250 coins to <@800000000000000002>\. Cash 🪙 250 coins · bank 🪙 0 coins\./
  );
  assert.equal(add.replies[0].flags, MessageFlags.Ephemeral);
  const row = db.prepare('SELECT kind, actor_id, reason FROM economy_transactions WHERE guild_id = ?').get(G);
  assert.deepEqual({ ...row }, { kind: 'staff_add', actor_id: STAFF, reason: 'prize' });

  const remove = interaction({
    userId: STAFF,
    sub: 'remove',
    manageGuild: true,
    options: { user: V, amount: 50 },
  });
  await eco.execute(remove);
  assert.match(said(remove), /Removed 🪙 50 coins from/);
  const set = interaction({ userId: STAFF, sub: 'set', manageGuild: true, options: { user: V, amount: 7 } });
  await eco.execute(set);
  assert.match(said(set), /Set the cash of .* to 🪙 7 coins/);
  const reset = interaction({ userId: STAFF, sub: 'reset-user', manageGuild: true, options: { user: V } });
  await eco.execute(reset);
  assert.match(said(reset), /Reset the account of/);
  assert.equal(await cash(V), 0);
  const tooMuch = interaction({
    userId: STAFF,
    sub: 'remove',
    manageGuild: true,
    options: { user: V, amount: 5 },
  });
  await eco.execute(tooMuch);
  assert.match(said(tooMuch), /does not have that much/);
});

test('/eco does not make accounts for bots', async () => {
  await enable();
  const i = interaction({
    sub: 'add',
    manageGuild: true,
    options: { user: V, amount: 5 },
    target: { id: V, username: 'robo', bot: true },
  });
  await eco.execute(i);
  assert.match(said(i), /Bots do not have an account/);
  assert.equal(await getAccount(G, V), null);
});

// --- the leaderboard ----------------------------------------------------------------------------------

const buttons = (payload) => (payload.components ?? []).flatMap((row) => row.toJSON().components);

test('the leaderboard lists ten per page with the caller own rank and page buttons', async () => {
  await enable();
  for (let i = 1; i <= 23; i++)
    await credit(G, `8200000000000${String(i).padStart(5, '0')}`, i * 100, { kind: 'daily', config });
  await credit(G, U, 50, { kind: 'daily', config });
  const i = interaction();
  await board.execute(i);
  const embed = i.replies[0].embeds[0].data;
  const lines = embed.description.split('\n');
  assert.equal(lines.length, 10);
  assert.match(lines[0], /^🥇 <@820000000000000023> — 🪙 2,300 coins$/);
  assert.match(lines[3], /^\*\*4\.\*\* /);
  assert.equal(embed.fields[0].value, `<@${U}>: #24 with 🪙 50 coins`);
  assert.match(embed.footer.text, /Page 1 of 3 · 24 member/);
  const [prev, next] = buttons(i.replies[0]);
  assert.deepEqual([prev.disabled, next.disabled], [true, false]);
  assert.equal(next.custom_id, `ecolb:2:${U}`);
  assert.deepEqual([prev.emoji.name, next.emoji.name], ['⬅️', '➡️']);
});

test('a page button turns the page for the member who asked, and works as a reaction too', async () => {
  await enable();
  for (let i = 1; i <= 23; i++)
    await credit(G, `8200000000000${String(i).padStart(5, '0')}`, i * 100, { kind: 'daily', config });
  const updates = [];
  const click = {
    customId: `ecolb:3:${U}`,
    guildId: G,
    guild: { id: G, name: 'Test Server' },
    user: { id: V },
    deferUpdate: async () => {},
    update: async (payload) => updates.push(payload),
  };
  assert.equal(await routeComponent(click), true);
  assert.equal(updates.length, 1);
  const embed = updates[0].embeds[0].data;
  assert.equal(embed.description.split('\n').length, 3);
  assert.match(embed.footer.text, /Page 3 of 3/);
  assert.match(embed.fields[0].value, new RegExp(`^<@${U}>`), 'the rank line stays the asker');
  const [prev, next] = buttons(updates[0]);
  assert.deepEqual([prev.disabled, next.disabled], [false, true]);
  assert.equal(prev.custom_id, `ecolb:2:${U}`);

  // a page number past the end shows the last page; garbage in the id does nothing
  const stale = { ...click, customId: `ecolb:99:${U}` };
  await routeComponent(stale);
  assert.match(updates[1].embeds[0].data.footer.text, /Page 3 of 3/);
  let deferred = false;
  await routeComponent({
    ...click,
    customId: 'ecolb:2:not-an-id',
    deferUpdate: async () => (deferred = true),
  });
  assert.equal(deferred, true);
  assert.equal(updates.length, 2);
});

test('a page button does nothing once the module is off', async () => {
  let deferred = false;
  const click = {
    customId: `ecolb:1:${U}`,
    guildId: G,
    deferUpdate: async () => (deferred = true),
    update: async () => assert.fail('no update'),
  };
  await routeComponent(click);
  assert.equal(deferred, true);
});

test('the leaderboard with no accounts says so and has no buttons', async () => {
  await enable();
  const i = interaction();
  await board.execute(i);
  assert.equal(i.replies[0].embeds[0].data.description, 'Nobody has any money yet.');
  assert.deepEqual(buttons(i.replies[0]), []);
});

// --- chat form, help, registration ---------------------------------------------------------------------

test('the commands are all loaded, have unique names and fit Discord limits', async () => {
  const commands = await loadCommands();
  const names = [
    'balance',
    'daily',
    'work',
    'deposit',
    'withdraw',
    'pay',
    'rob',
    'economy-leaderboard',
    'eco',
  ];
  for (const name of names) assert.ok(commands.has(name), name);
  assert.ok(commands.size <= 100, 'Discord allows 100 global slash commands');
  for (const name of names) {
    const json = commands.get(name).data.toJSON();
    assert.ok(json.description.length <= 100, `${name} description`);
    for (const o of json.options ?? []) assert.ok(o.description.length <= 100, `${name}.${o.name}`);
  }
  // /leaderboard stays the Leveling module's
  assert.ok(commands.has('leaderboard'));
  assert.match(commands.get('leaderboard').data.description, /XP/);
});

test('help lists the economy commands in their own group, with nothing left under Other', async () => {
  const commands = await loadCommands();
  const group = GROUPS.find((g) => g.name === 'Economy');
  assert.ok(group);
  for (const name of group.commands) assert.ok(commands.has(name), name);
  assert.deepEqual(
    otherCommands(commands).map((c) => c.data.name),
    []
  );
});

test('the chat form reads the schemas: pay, deposit all, eco with a free-text reason', async () => {
  const commands = await loadCommands();
  const schema = (name) => commands.get(name).data.toJSON();
  const pay1 = parseArgs(schema('pay'), `<@${V}> 1500`);
  assert.deepEqual([pay1.values.user.value, pay1.values.amount.value], [`<@${V}>`, 1500]);
  assert.deepEqual(parseArgs(schema('deposit'), 'all').values.amount.value, 'all');
  const eco1 = parseArgs(schema('eco'), `add <@${V}> 500 Prize for the quiz night`);
  assert.equal(eco1.subcommand, 'add');
  assert.deepEqual([eco1.values.amount.value, eco1.values.reason.value], [500, 'Prize for the quiz night']);
  const eco2 = parseArgs(schema('eco'), `set <@${V}> 0 reason:"back to zero"`);
  assert.deepEqual([eco2.values.amount.value, eco2.values.reason.value], [0, 'back to zero']);
  assert.equal(parseArgs(schema('eco'), `reset-user <@${V}>`).subcommand, 'reset-user');
  assert.equal(parseArgs(schema('balance'), '').subcommand, null);
  assert.throws(() => parseArgs(schema('pay'), `<@${V}> 0`), /at least 1/);
});

test('/eco is for staff with Manage Server by default', () => {
  const json = eco.data.toJSON();
  assert.equal(json.default_member_permissions, String(1 << 5), 'Manage Guild is bit 5');
});
