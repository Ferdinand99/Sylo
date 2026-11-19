// /purge: messages of any age. Split by age (bulk under 14 days, one by one above), single-delete
// pacing with 429s, the Stop button's permissions, one purge at a time per channel, the Fluxer path
// (its bulk route has no age limit) and the 100-message cap.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Collection, PermissionFlagsBits } from 'discord.js';
import * as sdk from '@fluxerjs/core';
import { Collection as FluxerCollection } from '@fluxerjs/collection';
import { installFluxerCompat } from '../src/platform/compat.js';
import { runtime } from '../src/runtime.js';
import { setModlogChannel } from '../src/db/guildSettings.js';
import * as purge from '../src/bot/commands/purge.js';
import {
  BULK_MAX_AGE_MS,
  PURGE_CAP,
  SINGLE_DELETE_PACE_MS,
  _resetPurgeLocks,
  acquirePurgeLock,
  canStopPurge,
  classifyError,
  purgeMessages,
  purgeTuning,
  retryAfterMs,
  splitByAge,
} from '../src/bot/lib/purgeMessages.js';

const DAY = 86_400_000;
const EPOCH = 1420070400000n;
let seq = 0;

/** A message with a real snowflake id created `ageMs` ago. */
function msg(ageMs, over = {}) {
  const ts = BigInt(Date.now() - ageMs);
  const id = String(((ts - EPOCH) << 22n) + BigInt(++seq));
  return { id, createdTimestamp: Number(ts), author: { id: 'a1' }, delete: async () => {}, ...over };
}
const recent = (n, over) => Array.from({ length: n }, () => msg(DAY, over));
const old = (n, over) => Array.from({ length: n }, () => msg(20 * DAY, over));

function discordChannel(over = {}) {
  const calls = [];
  return {
    calls,
    guild: { client: {} },
    async bulkDelete(list, filterOld) {
      const arr = [...(list instanceof Map ? list.values() : list)];
      calls.push({ ids: arr.map((m) => m.id), filterOld });
      return new Collection(arr.map((m) => [m.id, m]));
    },
    ...over,
  };
}

const noSleep = { sleep: async () => {} };
const recordSleeps = () => {
  const waits = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
};

beforeEach(() => _resetPurgeLocks());

// --- splitting by age --------------------------------------------------------------------------

test('splitByAge: the 14-day cut is computed from the snowflake timestamp', () => {
  const now = Date.now();
  const young = msg(13 * DAY);
  const edge = msg(14 * DAY - 60_000); // inside the 5-minute safety margin: counts as old
  const past = msg(15 * DAY);
  // The SDK's own timestamp is ignored when the id is a snowflake.
  const liar = { ...msg(30 * DAY), createdTimestamp: now };
  const { recent: r, old: o } = splitByAge([young, edge, past, liar], now);
  assert.deepEqual(r, [young]);
  assert.deepEqual(o, [edge, past, liar]);
  assert.ok(BULK_MAX_AGE_MS < 14 * DAY);
});

test('splitByAge: a message whose age is unknown is treated as old (a single delete always works)', () => {
  const { recent: r, old: o } = splitByAge([{ id: 'x' }, { id: 'y', createdTimestamp: Date.now() }]);
  assert.equal(r.length, 1);
  assert.equal(o.length, 1);
  assert.equal(o[0].id, 'x');
});

// --- Discord: bulk + singles ---------------------------------------------------------------------

test('Discord: young messages are bulk-deleted, older ones one by one at the platform pace', async () => {
  const channel = discordChannel();
  const young = recent(3);
  const oldies = old(3);
  const deletedIds = [];
  for (const m of oldies) m.delete = async () => void deletedIds.push(m.id);
  const { waits, sleep } = recordSleeps();

  const result = await purgeMessages(channel, [...oldies, ...young], { platform: 'discord', sleep });

  assert.equal(channel.calls.length, 1);
  assert.deepEqual(channel.calls[0].ids.sort(), young.map((m) => m.id).sort());
  assert.equal(channel.calls[0].filterOld, true);
  assert.deepEqual(
    deletedIds,
    oldies.map((m) => m.id)
  );
  assert.deepEqual(waits, [SINGLE_DELETE_PACE_MS.discord, SINGLE_DELETE_PACE_MS.discord]); // between, not after the last
  assert.equal(result.deleted, 6);
  assert.equal(result.bulk, 3);
  assert.equal(result.single, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.stopped, false);
});

test('Discord: the bulk route needs 2-100 messages, so a lone young message is deleted singly', async () => {
  const channel = discordChannel();
  const lone = msg(DAY);
  let deleted = 0;
  lone.delete = async () => void deleted++;
  const result = await purgeMessages(channel, [lone, ...old(1)], { platform: 'discord', ...noSleep });
  assert.equal(channel.calls.length, 0);
  assert.equal(deleted, 1);
  assert.equal(result.deleted, 2);
});

test('the cap is 100 messages per run, and no bulk call carries more than 100', async () => {
  const channel = discordChannel();
  const result = await purgeMessages(channel, [...recent(120), ...old(10)], {
    platform: 'discord',
    ...noSleep,
  });
  assert.equal(result.total, PURGE_CAP);
  assert.equal(result.deleted, PURGE_CAP);
  assert.ok(channel.calls.every((c) => c.ids.length <= 100));

  const fluxerChannel = discordChannel();
  const fluxer = await purgeMessages(fluxerChannel, [...old(80), ...recent(80)], {
    platform: 'fluxer',
    ...noSleep,
  });
  assert.equal(fluxer.total, PURGE_CAP);
  assert.equal(fluxerChannel.calls[0].ids.length, 100);
});

test('Discord: a message the bulk route skipped (turned 14 days old during the run) is deleted singly', async () => {
  const young = recent(3);
  let skippedDeleted = 0;
  young[2].delete = async () => void skippedDeleted++;
  const channel = discordChannel({
    async bulkDelete(list) {
      const arr = [...list];
      return new Collection(arr.slice(0, 2).map((m) => [m.id, m]));
    },
  });
  const result = await purgeMessages(channel, young, { platform: 'discord', ...noSleep });
  assert.equal(skippedDeleted, 1);
  assert.equal(result.deleted, 3);
});

test('Discord: a "too old" bulk error (50034) falls back to single deletes', async () => {
  const young = recent(2);
  let singles = 0;
  for (const m of young) m.delete = async () => void singles++;
  const channel = discordChannel({
    async bulkDelete() {
      throw Object.assign(new Error('old'), { code: 50034 });
    },
  });
  const result = await purgeMessages(channel, young, { platform: 'discord', ...noSleep });
  assert.equal(singles, 2);
  assert.equal(result.deleted, 2);
});

test('Discord: missing permission on the bulk route fails the batch without trying every message', async () => {
  const young = recent(3);
  let singles = 0;
  for (const m of young) m.delete = async () => void singles++;
  const channel = discordChannel({
    async bulkDelete() {
      throw Object.assign(new Error('perm'), { code: 50013, status: 403 });
    },
  });
  const result = await purgeMessages(channel, young, { platform: 'discord', ...noSleep });
  assert.equal(singles, 0);
  assert.equal(result.deleted, 0);
  assert.equal(result.failed, 3);
  assert.deepEqual(result.failures, { gone: 0, permission: 3, other: 0 });
});

// --- single deletes and rate limits --------------------------------------------------------------

test('single deletes wait out a 429 (retry_after seconds) and retry the same message', async () => {
  let tries = 0;
  const m = msg(20 * DAY, {
    delete: async () => {
      if (++tries <= 2) throw Object.assign(new Error('rate limited'), { status: 429, retry_after: 2.5 });
    },
  });
  const { waits, sleep } = recordSleeps();
  const result = await purgeMessages(discordChannel(), [m], { platform: 'discord', sleep });
  assert.equal(tries, 3);
  assert.deepEqual(waits, [2500, 2500]);
  assert.equal(result.deleted, 1);
  assert.equal(result.failed, 0);
});

test('a 429 in the shape of either SDK is understood: discord.js timeToReset (ms), Fluxer RateLimitError (s)', async () => {
  assert.equal(retryAfterMs({ timeToReset: 1800 }), 1800);
  assert.equal(retryAfterMs({ name: 'RateLimitError', statusCode: 429, retryAfter: 1.5 }), 1500);
  assert.equal(retryAfterMs({ rawError: { retry_after: 0.1 } }), 250); // never a busy loop
  assert.equal(retryAfterMs({ retry_after: 9999 }), 60_000); // never an unbounded wait
  assert.equal(retryAfterMs({}), 2000);

  // Fluxer's SDK throws a RateLimitError (statusCode, retryAfter in seconds) once its own retries are spent.
  let tries = 0;
  const m = msg(20 * DAY, {
    delete: async () => {
      if (++tries === 1) {
        throw Object.assign(new Error('slow down'), {
          name: 'RateLimitError',
          statusCode: 429,
          retryAfter: 1,
        });
      }
    },
  });
  const { waits, sleep } = recordSleeps();
  const channel = discordChannel({
    async bulkDelete() {
      throw new Error('bulk unavailable'); // so the Fluxer purge falls back to single deletes
    },
  });
  const result = await purgeMessages(channel, [m], { platform: 'fluxer', sleep });
  assert.equal(result.deleted, 1);
  assert.deepEqual(waits, [1000]);
});

test('a message that stays rate limited is given up on after the retries and counted as failed', async () => {
  const m = msg(20 * DAY, {
    delete: async () => {
      throw Object.assign(new Error('rl'), { status: 429, retry_after: 1 });
    },
  });
  const next = msg(20 * DAY);
  const { waits, sleep } = recordSleeps();
  const result = await purgeMessages(discordChannel(), [m, next], { platform: 'discord', sleep });
  assert.equal(waits.filter((w) => w === 1000).length, 5);
  assert.equal(result.deleted, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.failures.other, 1);
});

test('failures are counted by kind: already gone, missing permission, other', async () => {
  const fail = (extra) =>
    msg(20 * DAY, {
      delete: async () => {
        throw Object.assign(new Error('x'), extra);
      },
    });
  const result = await purgeMessages(
    discordChannel(),
    [
      fail({ code: 10008 }),
      fail({ status: 404 }),
      fail({ code: 50013 }),
      fail({ statusCode: 403 }),
      fail({ status: 500 }),
      msg(20 * DAY),
    ],
    { platform: 'discord', ...noSleep }
  );
  assert.equal(result.deleted, 1);
  assert.equal(result.failed, 5);
  assert.deepEqual(result.failures, { gone: 2, permission: 2, other: 1 });
  assert.equal(classifyError({ code: 'UNKNOWN_MESSAGE' }), 'gone');
  assert.equal(classifyError({ code: 'MISSING_PERMISSIONS' }), 'permission');
});

test('a stop request ends the run between deletes and reports what is left', async () => {
  const messages = old(6);
  let stopped = false;
  let n = 0;
  for (const m of messages) {
    m.delete = async () => {
      if (++n === 2) stopped = true;
    };
  }
  const result = await purgeMessages(discordChannel(), messages, {
    platform: 'discord',
    isStopped: () => stopped,
    ...noSleep,
  });
  assert.equal(result.deleted, 2);
  assert.equal(result.stopped, true);
  assert.equal(result.remaining, 4);
});

test('progress is reported after the bulk call and after every single delete', async () => {
  const seen = [];
  await purgeMessages(discordChannel(), [...recent(2), ...old(2)], {
    platform: 'discord',
    onProgress: (p) => seen.push(p.deleted),
    ...noSleep,
  });
  assert.deepEqual(seen, [2, 3, 4]);
});

// --- Fluxer: no age limit -------------------------------------------------------------------------

test('Fluxer: everything, old included, goes through the bulk route (no age limit) without an age filter', async () => {
  const channel = discordChannel();
  const result = await purgeMessages(channel, [...old(30), ...recent(5)], { platform: 'fluxer', ...noSleep });
  assert.equal(channel.calls.length, 1);
  assert.equal(channel.calls[0].ids.length, 35);
  assert.equal(channel.calls[0].filterOld, false);
  assert.equal(result.deleted, 35);
  assert.equal(result.single, 0);
});

test('Fluxer: a single old message uses the bulk call too (Fluxer takes 1-100 ids)', async () => {
  const channel = discordChannel();
  const result = await purgeMessages(channel, old(1), { platform: 'fluxer', ...noSleep });
  assert.equal(channel.calls.length, 1);
  assert.equal(result.deleted, 1);
});

test("Fluxer: if the bulk call fails for another reason, messages are deleted singly at Fluxer's pace", async () => {
  const messages = old(2);
  let singles = 0;
  for (const m of messages) m.delete = async () => void singles++;
  const channel = discordChannel({
    async bulkDelete() {
      throw new Error('boom');
    },
  });
  const { waits, sleep } = recordSleeps();
  const result = await purgeMessages(channel, messages, { platform: 'fluxer', sleep });
  assert.equal(singles, 2);
  assert.deepEqual(waits, [SINGLE_DELETE_PACE_MS.fluxer]);
  assert.equal(result.deleted, 2);
});

test('Fluxer adapter: Channel.bulkDelete(messages, false) sends old messages too, even a single one', async () => {
  const sent = [];
  const Native = class {
    async bulkDelete(arg) {
      sent.push([...arg]);
      return [...arg];
    }
  };
  installFluxerCompat({ ...sdk, Channel: Native }, { Collection: FluxerCollection });
  const channel = new Native();
  const batch = [...old(3), ...recent(2)];
  const all = await channel.bulkDelete(batch, false);
  assert.equal(all.size, 5);
  assert.equal(sent.at(-1).length, 5);
  const one = await channel.bulkDelete([batch[0]], false);
  assert.equal(one.size, 1);
  // With the filter on (what Discord-minded callers pass) the old ones are dropped.
  assert.equal((await channel.bulkDelete(batch, true)).size, 2);
});

// --- the lock and the stop permission -------------------------------------------------------------

test('one purge at a time per channel: the lock is refused while held and free again after release', () => {
  const release = acquirePurgeLock('g:c1', 'u1');
  assert.equal(typeof release, 'function');
  assert.equal(acquirePurgeLock('g:c1', 'u2'), null);
  assert.equal(typeof acquirePurgeLock('g:c2', 'u2'), 'function'); // another channel is independent
  release();
  release(); // idempotent
  assert.equal(typeof acquirePurgeLock('g:c1', 'u2'), 'function');
});

test('canStopPurge: the person who ran it and administrators, nobody else', () => {
  const admin = { has: (f) => f === PermissionFlagsBits.Administrator };
  const mod = { has: () => false };
  const args = { starterId: 'u1', administrator: PermissionFlagsBits.Administrator };
  assert.equal(canStopPurge({ ...args, userId: 'u1', permissions: mod }), true);
  assert.equal(canStopPurge({ ...args, userId: 'u2', permissions: admin }), true);
  assert.equal(canStopPurge({ ...args, userId: 'u2', permissions: mod }), false);
  assert.equal(canStopPurge({ ...args, userId: 'u2', permissions: null }), false);
});

// --- the command ---------------------------------------------------------------------------------

test('the command description no longer says "younger than 14 days"; every option is kept', () => {
  assert.ok(!/14 days/i.test(purge.data.description));
  assert.deepEqual(
    purge.data.options.map((o) => o.name),
    ['amount', 'user']
  );
});

test('progress and summary texts', () => {
  assert.equal(purge.progressText({ deleted: 40, failed: 0, total: 100 }), '🧹 Deleted **40** of **100**…');
  assert.match(purge.progressText({ deleted: 40, failed: 2, total: 100 }), /2 could not be deleted/);
  assert.equal(
    purge.summaryText({ deleted: 1, failed: 0, failures: {}, stopped: false, total: 1, remaining: 0 }),
    '🧹 Deleted **1** message.'
  );
  const text = purge.summaryText({
    deleted: 7,
    failed: 3,
    failures: { gone: 2, permission: 1, other: 0 },
    stopped: false,
    total: 10,
    remaining: 0,
  });
  assert.match(text, /Deleted \*\*7\*\* messages/);
  assert.match(text, /\*\*3\*\* messages could not be deleted \(2 already gone, 1 missing permission\)/);
  assert.match(
    purge.summaryText({ deleted: 4, failed: 0, failures: {}, stopped: true, total: 10, remaining: 6 }),
    /Stopped\. Deleted \*\*4\*\* messages of \*\*10\*\*; \*\*6\*\* left untouched/
  );
});

let G = 0;
let guildId;
const fakeFluxerClient = { fluxer: true };

beforeEach(() => {
  guildId = `5700000000${String(++G).padStart(8, '0')}`;
  purgeTuning.sleep = async () => {};
});
afterEach(() => {
  purgeTuning.sleep = async () => {};
  runtime.clients.fluxer = null;
});

/** A fake slash-command interaction; `click` presses the Stop button while the purge runs. */
function setup({ platform = 'discord', messages, amount = 100, user = null, starter = 'u1' } = {}) {
  const client = platform === 'fluxer' ? fakeFluxerClient : {};
  if (platform === 'fluxer') runtime.clients.fluxer = client;
  const modlogSent = [];
  const modlogChannel = {
    id: 'modlog',
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (p) => void modlogSent.push(p),
  };
  const guild = {
    id: platform === 'fluxer' ? `fluxer:${guildId}` : guildId,
    client,
    members: { me: {} },
    channels: { cache: new Map([['modlog', modlogChannel]]) },
  };
  const channel = {
    id: 'chan1',
    guild,
    toString: () => '#chan',
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async ({ limit }) => new Collection(messages.slice(0, limit).map((m) => [m.id, m])),
    },
    bulkCalls: [],
    async bulkDelete(list, filterOld) {
      const arr = [...(list instanceof Map ? list.values() : list)];
      this.bulkCalls.push({ n: arr.length, filterOld });
      return new Collection(arr.map((m) => [m.id, m]));
    },
  };
  const replies = [];
  const collector = new EventEmitter();
  collector.stop = () => void (collector.stopped = true);
  const reply = { id: 'reply1', createMessageComponentCollector: () => collector };
  const interaction = {
    guild,
    channel,
    user: { id: starter, tag: 'starter#0' },
    options: { getInteger: () => amount, getUser: () => user },
    async reply(p) {
      replies.push({ kind: 'reply', ...p });
    },
    async deferReply(p) {
      replies.push({ kind: 'defer', ...p });
    },
    async editReply(p) {
      replies.push({ kind: 'edit', ...p });
    },
    async fetchReply() {
      return reply;
    },
  };
  /** Press Stop as `who`; resolves to what the click answered. */
  const click = async (who, { admin = false } = {}) => {
    const answers = [];
    const i = {
      user: { id: who },
      customId: purge.STOP_CUSTOM_ID,
      memberPermissions: { has: (f) => admin && f === PermissionFlagsBits.Administrator },
      reply: async (p) => void answers.push({ kind: 'reply', ...p }),
      update: async (p) => void answers.push({ kind: 'update', ...p }),
    };
    collector.emit('collect', i);
    await new Promise((r) => setImmediate(r));
    return answers;
  };
  return { interaction, channel, collector, replies, modlogSent, click };
}

const lastEdit = (replies) => replies.filter((r) => r.kind === 'edit').at(-1);

test('command, Discord: old messages get a Stop button, progress, a final summary and a mod-log entry', async () => {
  await setModlogChannel(guildId, 'modlog');
  const t = setup({ messages: [...recent(2), ...old(3)] });
  purgeTuning.sleep = async () => {};
  await purge.execute(t.interaction);

  const edits = t.replies.filter((r) => r.kind === 'edit');
  assert.match(edits[0].content, /Deleted \*\*0\*\* of \*\*5\*\*/);
  assert.equal(edits[0].components.length, 1);
  const button = edits[0].components[0].toJSON().components[0];
  assert.equal(button.custom_id, purge.STOP_CUSTOM_ID);
  assert.equal(button.label, 'Stop');
  assert.ok(edits.some((e) => /Deleted \*\*2\*\* of \*\*5\*\*/.test(e.content))); // progress after the bulk call
  assert.match(lastEdit(t.replies).content, /Deleted \*\*5\*\* messages\./);
  assert.deepEqual(lastEdit(t.replies).components, []); // the button is removed at the end
  assert.equal(t.channel.bulkCalls.length, 1);
  assert.deepEqual(t.channel.bulkCalls[0], { n: 2, filterOld: true });
  assert.equal(t.collector.stopped, true);
  // The mod log still gets its entry.
  assert.equal(t.modlogSent.length, 1);
  assert.equal(t.modlogSent[0].embeds[0].data.title, 'Messages purged');
  assert.ok(t.modlogSent[0].embeds[0].data.fields.some((f) => f.name === 'Count' && f.value === '5'));
});

test('command, Discord: only young messages keep the quick single reply, with no Stop button', async () => {
  const t = setup({ messages: recent(4) });
  await purge.execute(t.interaction);
  const edits = t.replies.filter((r) => r.kind === 'edit');
  assert.equal(edits.length, 1);
  assert.match(edits[0].content, /Deleted \*\*4\*\* messages\./);
  assert.equal(edits[0].components, undefined);
});

test('command: the user filter and the amount are kept', async () => {
  const messages = [
    ...recent(2, { author: { id: 'target' } }),
    ...recent(3),
    ...old(2, { author: { id: 'target' } }),
  ];
  const t = setup({ messages, user: { id: 'target', tag: 'target#0' } });
  await purge.execute(t.interaction);
  assert.match(lastEdit(t.replies).content, /Deleted \*\*4\*\* messages from target#0\./);

  const t2 = setup({ messages: recent(10), amount: 3 });
  await purge.execute(t2.interaction);
  assert.match(lastEdit(t2.replies).content, /Deleted \*\*3\*\* messages\./);
});

test('command: the manage-messages check and the no-guild check are kept', async () => {
  const t = setup({ messages: recent(2) });
  t.channel.permissionsFor = () => ({ has: () => false });
  await purge.execute(t.interaction);
  assert.match(t.replies[0].content, /Manage Messages/);
  assert.equal(t.channel.bulkCalls.length, 0);

  const t2 = setup({ messages: recent(2) });
  t2.interaction.guild = null;
  await purge.execute(t2.interaction);
  assert.equal(t2.replies[0].kind, 'reply');
  assert.equal(t2.channel.bulkCalls.length, 0);
});

test('command, Stop button: the starter and an admin may stop, another moderator may not', async () => {
  for (const [who, opts, mayStop] of [
    ['u2', {}, false],
    ['u1', {}, true],
    ['u3', { admin: true }, true],
  ]) {
    const messages = old(6);
    let n = 0;
    let answers;
    for (const m of messages) m.delete = async () => void n++;
    const t = setup({ messages });
    // Press the button in the middle of the run (during the wait after the 2nd delete).
    let sleepCalls = 0;
    purgeTuning.sleep = async () => {
      if (++sleepCalls === 2) answers = await t.click(who, opts);
    };
    await purge.execute(t.interaction);

    if (mayStop) {
      assert.equal(answers[0].kind, 'update', who);
      assert.match(answers[0].content, /Stopping/);
      assert.ok(n < 6, `${who}: stopped early`);
      assert.match(lastEdit(t.replies).content, /Stopped\./);
      assert.match(lastEdit(t.replies).content, /left untouched/);
    } else {
      assert.equal(answers[0].kind, 'reply', who);
      assert.match(answers[0].content, /Only the person who ran this purge, or a server admin/);
      assert.equal(n, 6, 'a refused click does not stop the purge');
      assert.match(lastEdit(t.replies).content, /Deleted \*\*6\*\* messages\./);
    }
  }
});

test('command: a second purge in the same channel is refused while one runs, and allowed after', async () => {
  const t = setup({ messages: old(3) });
  let second;
  purgeTuning.sleep = async () => {
    if (second) return;
    second = setup({ messages: recent(2) });
    await purge.execute(second.interaction);
  };
  await purge.execute(t.interaction);
  assert.equal(second.replies.length, 1);
  assert.equal(second.replies[0].kind, 'reply');
  assert.match(second.replies[0].content, /already running in this channel/);
  assert.equal(second.channel.bulkCalls.length, 0);

  // The first finished: the channel is free again.
  const third = setup({ messages: recent(2) });
  await purge.execute(third.interaction);
  assert.match(lastEdit(third.replies).content, /Deleted \*\*2\*\* messages\./);
});

test('command: the lock is released when the purge throws', async () => {
  const t = setup({ messages: recent(2) });
  t.channel.messages.fetch = async () => {
    throw new Error('no history');
  };
  await assert.rejects(purge.execute(t.interaction), /no history/);
  const next = setup({ messages: recent(2) });
  await purge.execute(next.interaction);
  assert.match(lastEdit(next.replies).content, /Deleted \*\*2\*\*/);
});

test('command: the final reply says how many failed and why', async () => {
  const messages = old(4);
  messages[0].delete = async () => {
    throw Object.assign(new Error('gone'), { code: 10008 });
  };
  messages[1].delete = async () => {
    throw Object.assign(new Error('perm'), { code: 50013 });
  };
  const t = setup({ messages });
  await purge.execute(t.interaction);
  const text = lastEdit(t.replies).content;
  assert.match(text, /Deleted \*\*2\*\* messages\./);
  assert.match(text, /\*\*2\*\* messages could not be deleted \(1 already gone, 1 missing permission\)/);
});

test('command, Fluxer: old messages go through the bulk route unfiltered, with no Stop button and no single deletes', async () => {
  const messages = [...old(5), ...recent(3)];
  let singles = 0;
  for (const m of messages) m.delete = async () => void singles++;
  const t = setup({ platform: 'fluxer', messages });
  await purge.execute(t.interaction);
  assert.equal(t.channel.bulkCalls.length, 1);
  assert.deepEqual(t.channel.bulkCalls[0], { n: 8, filterOld: false });
  assert.equal(singles, 0);
  const edits = t.replies.filter((r) => r.kind === 'edit');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].components, undefined);
  assert.match(edits[0].content, /Deleted \*\*8\*\* messages\./);
});

test('command: the lock is keyed by the guild key, so Fluxer and Discord channels never share one', async () => {
  const f = setup({ platform: 'fluxer', messages: recent(2) });
  const release = acquirePurgeLock(`${f.interaction.guild.id}:chan1`, 'u9');
  await purge.execute(f.interaction);
  assert.match(f.replies[0].content, /already running/);
  release();
  const d = setup({ messages: recent(2) });
  const releaseFluxerKey = acquirePurgeLock(`fluxer:${guildId}:chan1`, 'u9');
  await purge.execute(d.interaction);
  assert.match(lastEdit(d.replies).content, /Deleted/);
  releaseFluxerKey();
});
