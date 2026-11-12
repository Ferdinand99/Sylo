// Economy: a currency members earn by chatting, speaking in voice, /daily and /work, keep in cash
// or in a bank, send to each other, and (when the server turns it on) steal from each other.
// Staff can add, remove, set and reset money from /eco and from the dashboard.
//
// This file owns the rules and what the commands and the dashboard say. The money itself only ever
// moves through modules/lib/economy.js (one transaction per change, one ledger row per change); the
// settings and their normaliser are in modules/lib/economyConfig.js. Every function here that takes
// `random` or `now` lets a test fix them.
//
// Amounts are whole numbers. Each server has its own balances (the server key from guildKey()).
// Message text is never read beyond its length and never logged.
import { EmbedBuilder } from 'discord.js';
import { on } from './dispatch.js';
import { every } from './schedule.js';
import { getGuildModule } from '../db/modules.js';
import {
  accountCount,
  getAccount,
  listAccounts,
  pruneCooldowns,
  pruneTransactions,
  rankOfTotal,
  topAccounts,
} from '../db/economy.js';
import {
  credit,
  debit,
  deposit,
  resetAccount,
  resetGuild,
  setBalance,
  transact,
  transfer,
  withdraw,
} from './lib/economy.js';
import {
  DAILY_COOLDOWN_MS,
  DAILY_STREAK_BREAK_MS,
  DAILY_STREAK_CAP,
  LIMITS,
  MAX_BALANCE,
  VOICE_BLOCK_MS,
  WORK_LINES,
  formatMoney,
  formatNumber,
  normaliseEconomyConfig,
  normaliseReason,
} from './lib/economyConfig.js';
import './lib/shop.js'; // its sweep for purchases stuck half way
import { allClientsReady, allGuilds, guildKey, platformOfClient } from '../platform/platformOf.js';
import { config as appConfig } from '../config.js';
import { sendToChannel } from './lib/send.js';
import { log } from '../lib/log.js';

export { LIMITS, MAX_BALANCE, formatMoney, formatNumber, normaliseEconomyConfig, normaliseReason };
export { clampAmount, itemProblem, normaliseItem } from './lib/economyConfig.js';
export { DAILY_STREAK_CAP, WORK_LINES };

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** The module's enabled state and normalised settings for a server. */
export async function economySettings(guildId) {
  const mod = await getGuildModule(guildId, 'economy');
  return { enabled: mod.enabled, config: normaliseEconomyConfig(mod.config) };
}

/** A whole number from `min` to `max`, both included, from a [0, 1) source. */
export function randomInt(min, max, random = Math.random) {
  return min + Math.floor(random() * (max - min + 1));
}

/** "3h 20m", "45s": how long until something can be done again. */
export function waitText(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

// --- earning from messages -------------------------------------------------------------------------

// Fast path so chat does not hit the database for every message: key -> time of the last payout.
// The database still enforces the cooldown (last_message_earn_at), across restarts too.
const messageCooldowns = new Map();
every('economy', 600_000, () => {
  const cutoff = Date.now() - HOUR_MS;
  for (const [k, ts] of messageCooldowns) if (ts < cutoff) messageCooldowns.delete(k);
});

/**
 * Pay a member for a chat message, if the rules allow it.
 * @param {{ guildId: string, userId: string, length: number | null, channelId: string, roleIds?: string[],
 *   config: object, now?: number, random?: () => number }} input  `length` is the message's length,
 *   or null when it cannot be known (Discord without the Message Content intent): then the minimum
 *   length is not checked, and nothing else changes
 * @returns {Promise<{ ok: true, amount: number } | { ok: false, reason: string }>}
 */
export async function earnFromMessage({
  guildId,
  userId,
  length,
  channelId,
  roleIds = [],
  config,
  now = Date.now(),
  random = Math.random,
}) {
  if (!config.messageEnabled) return { ok: false, reason: 'off' };
  if (config.ignoredChannels.includes(channelId)) return { ok: false, reason: 'ignored_channel' };
  if (roleIds.some((id) => config.ignoredRoles.includes(id))) return { ok: false, reason: 'ignored_role' };
  if (length !== null && length < config.messageMinLength) return { ok: false, reason: 'too_short' };

  const key = `${guildId}:${userId}`;
  const cooldownMs = config.messageCooldownSeconds * 1000;
  if (now - (messageCooldowns.get(key) ?? 0) < cooldownMs) return { ok: false, reason: 'cooldown' };
  messageCooldowns.set(key, now);

  const amount = randomInt(config.messageMin, config.messageMax, random);
  const out = await transact(
    guildId,
    [userId],
    (accounts) => {
      if (accounts.get(userId).lastMessageEarnAt > now - cooldownMs)
        return { refuse: { reason: 'cooldown' } };
      return {
        changes: [{ userId, cash: amount, clamp: true, kind: 'message' }],
        stamps: { [userId]: { last_message_earn_at: now } },
      };
    },
    { now, config }
  );
  if (!out.ok) return { ok: false, reason: out.reason };
  return { ok: true, amount: out.applied[0]?.applied ?? 0 };
}

/** Whether the platform gives us the text of a message (Discord needs the Message Content intent). */
const contentVisible = (message) =>
  appConfig.intentMessageContent || platformOfClient(message.client) === 'fluxer';

on('economy', 'messageCreate', async (message, rawConfig, guildId) => {
  if (!message.member || message.author?.bot) return;
  const config = normaliseEconomyConfig(rawConfig);
  await earnFromMessage({
    guildId,
    userId: message.author.id,
    // Without the Message Content intent Discord sends no text, so the length is unknown.
    length: contentVisible(message) ? String(message.content ?? '').trim().length : null,
    channelId: message.channelId,
    roleIds: [...(message.member.roles?.cache?.keys?.() ?? [])],
    config,
  });
});

// --- earning from voice ----------------------------------------------------------------------------
//
// Once a minute every member in voice gets a minute of "eligible time" when they count: not alone
// in the channel (bots do not count as company), not deafened, not in the AFK channel. Every
// VOICE_BLOCK_MS (5 minutes) of eligible time pays `voiceAmount`. There is no event handler: the tick
// looks at who is in voice right now, so members already connected when Sylo starts are covered.

/** Open voice sessions: guild key -> user id -> { channelId, at, eligibleMs }. */
const voiceSessions = new Map();
/** A tick that was delayed longer than this counts for no more (a stalled loop must not pay extra). */
const VOICE_MAX_STEP_MS = 2 * MINUTE_MS;

/**
 * Add the time since the last tick to a session when the member counts, and take out the whole
 * blocks it adds up to. Changes `session` in place.
 * @returns {number} how many 5-minute blocks are due now
 */
export function advanceVoiceSession(session, now, eligible) {
  const step = Math.min(Math.max(0, now - session.at), VOICE_MAX_STEP_MS);
  session.at = now;
  if (eligible) session.eligibleMs += step;
  const blocks = Math.floor(session.eligibleMs / VOICE_BLOCK_MS);
  session.eligibleMs -= blocks * VOICE_BLOCK_MS;
  return blocks;
}

/** Whether a voice state counts for earning right now. */
export function voiceEligible(guild, voiceState) {
  if (!voiceState?.channelId) return false;
  if (voiceState.channelId === guild.afkChannelId) return false;
  if (voiceState.deaf || voiceState.selfDeaf) return false;
  let company = 0;
  for (const other of guild.voiceStates.cache.values()) {
    if (other.channelId === voiceState.channelId && other.member?.user?.bot !== true) company += 1;
  }
  return company >= 2;
}

/**
 * One pass over the voice channels. `guilds` and `now` can be given by a test.
 * @returns {Promise<number>} how many members were paid
 */
export async function tickVoice(now = Date.now(), { guilds = allGuilds() } = {}) {
  let paid = 0;
  const seenGuilds = new Set();
  for (const guild of guilds) {
    const guildId = guildKey(guild);
    seenGuilds.add(guildId);
    const { enabled, config } = await economySettings(guildId);
    if (!enabled || !config.voiceEnabled) {
      voiceSessions.delete(guildId);
      continue;
    }
    let sessions = voiceSessions.get(guildId);
    if (!sessions) {
      sessions = new Map();
      voiceSessions.set(guildId, sessions);
    }
    const present = new Set();
    for (const vs of guild.voiceStates.cache.values()) {
      if (!vs.channelId || vs.member?.user?.bot) continue;
      const userId = vs.id ?? vs.member?.id;
      if (!userId) continue;
      present.add(userId);
      let session = sessions.get(userId);
      if (!session) {
        session = { channelId: vs.channelId, at: now, eligibleMs: 0 };
        sessions.set(userId, session);
        continue;
      }
      session.channelId = vs.channelId;
      const blocks = advanceVoiceSession(session, now, voiceEligible(guild, vs));
      if (blocks < 1) continue;
      const out = await credit(guildId, userId, blocks * config.voiceAmount, { kind: 'voice', now, config });
      if (out.ok && out.applied > 0) paid += 1;
    }
    for (const userId of sessions.keys()) if (!present.has(userId)) sessions.delete(userId);
  }
  for (const guildId of voiceSessions.keys()) if (!seenGuilds.has(guildId)) voiceSessions.delete(guildId);
  return paid;
}

every('economy', MINUTE_MS, async () => {
  if (!allClientsReady()) return;
  await tickVoice();
});

// --- the ledger keeps 180 days ---------------------------------------------------------------------

every(
  'economy',
  24 * HOUR_MS,
  async () => {
    const removed = await pruneTransactions();
    if (removed) log.info('economy', `pruned ${removed} ledger row(s) older than 180 days`);
  },
  { firstDelayMs: 10 * MINUTE_MS }
);

// The /forget cooldown records last 7 days; deleting them every hour keeps that promise to within an hour.
every('economy', HOUR_MS, () => pruneCooldowns());

// --- /daily and /work ------------------------------------------------------------------------------

/**
 * The daily reward. Once per 24 hours; the streak grows by one when the last claim was within 48
 * hours, and starts again at 1 otherwise. The reward is the base plus the streak bonus for each
 * day after the first, counting at most DAILY_STREAK_CAP days.
 * @returns {Promise<{ ok: true, amount: number, streak: number, bonus: number, account: object } | { ok: false, reason: 'cooldown', retryAt: number }>}
 */
export async function claimDaily({ guildId, userId, config, now = Date.now() }) {
  const out = await transact(
    guildId,
    [userId],
    (accounts) => {
      const acc = accounts.get(userId);
      if (acc.lastDailyAt > 0 && now - acc.lastDailyAt < DAILY_COOLDOWN_MS) {
        return { refuse: { reason: 'cooldown', retryAt: acc.lastDailyAt + DAILY_COOLDOWN_MS } };
      }
      const keeps = acc.lastDailyAt > 0 && now - acc.lastDailyAt <= DAILY_STREAK_BREAK_MS;
      const streak = keeps ? acc.dailyStreak + 1 : 1;
      const bonus = config.dailyStreakBonus * (Math.min(streak, DAILY_STREAK_CAP) - 1);
      return {
        changes: [{ userId, cash: config.dailyBase + bonus, clamp: true, kind: 'daily' }],
        stamps: { [userId]: { daily_streak: streak, last_daily_at: now } },
        result: { streak, bonus },
      };
    },
    { now, config }
  );
  if (!out.ok) return out;
  return {
    ok: true,
    amount: out.applied[0]?.applied ?? 0,
    streak: out.result.streak,
    bonus: out.result.bonus,
    account: out.accounts.get(userId),
  };
}

/**
 * /work: a random pay and one of the built-in lines. Once per cooldown.
 * @returns {Promise<{ ok: true, amount: number, line: string, account: object } | { ok: false, reason: 'cooldown', retryAt: number }>}
 */
export async function doWork({ guildId, userId, config, now = Date.now(), random = Math.random }) {
  const cooldownMs = config.workCooldownMinutes * MINUTE_MS;
  const pay = randomInt(config.workMin, config.workMax, random);
  const line = WORK_LINES[Math.floor(random() * WORK_LINES.length)];
  const out = await transact(
    guildId,
    [userId],
    (accounts) => {
      const acc = accounts.get(userId);
      if (acc.lastWorkAt > 0 && now - acc.lastWorkAt < cooldownMs) {
        return { refuse: { reason: 'cooldown', retryAt: acc.lastWorkAt + cooldownMs } };
      }
      return {
        changes: [{ userId, cash: pay, clamp: true, kind: 'work' }],
        stamps: { [userId]: { last_work_at: now } },
      };
    },
    { now, config }
  );
  if (!out.ok) return out;
  return { ok: true, amount: out.applied[0]?.applied ?? 0, line, account: out.accounts.get(userId) };
}

// --- bank, pay -------------------------------------------------------------------------------------

/** Deposit cash (`amount` a number or 'all'). Refused with `bank_off` when the bank is off. */
export async function doDeposit({ guildId, userId, amount, config, now }) {
  if (!config.bankEnabled) return { ok: false, reason: 'bank_off' };
  return deposit(guildId, userId, amount, { now, config });
}

/** Withdraw from the bank (`amount` a number or 'all'). */
export async function doWithdraw({ guildId, userId, amount, config, now }) {
  if (!config.bankEnabled) return { ok: false, reason: 'bank_off' };
  return withdraw(guildId, userId, amount, { now, config });
}

/**
 * The tax on a payment: the configured percentage of the amount, rounded up, so any taxed payment
 * pays at least 1 (small payments cannot be used to avoid it). No tax at 0 percent.
 */
export const taxOn = (amount, percent) => (percent > 0 ? Math.floor((amount * percent + 99) / 100) : 0);

/**
 * /pay. Refused: `pay_off`, `self`, `bot`, `invalid_amount`, `insufficient` (the sender needs the
 * amount plus the tax), `recipient_cap`.
 */
export async function doPay({ guildId, fromId, toId, toIsBot = false, amount, config, now }) {
  if (!config.payEnabled) return { ok: false, reason: 'pay_off' };
  if (fromId === toId) return { ok: false, reason: 'self' };
  if (toIsBot) return { ok: false, reason: 'bot' };
  const tax = taxOn(amount, config.payTaxPercent);
  return transfer(guildId, fromId, toId, amount, { tax, now, config });
}

// --- rob -------------------------------------------------------------------------------------------

/**
 * Try to rob a member's cash. The rules, in the order they are checked:
 *   the module setting is on (it is off by default); not yourself; not a bot; the victim has been
 *   in the server for the configured time; then, on the locked accounts: the robber's cooldown,
 *   the victim holds the minimum cash, the victim was not robbed within the protection window.
 * `random` is called first for the success roll (success when roll * 100 < the chance), then, on a
 * success, once to pick the percentage stolen.
 *
 * Success: the victim loses a share of their cash (min..max percent, at least 1) and the robber
 * gains it. Failure: the robber pays a fine to the victim (a percentage of their own cash, at
 * least the minimum). To attempt a rob the robber must hold at least the smallest fine in cash,
 * so the fine can always be paid from cash. Either way the robber's cooldown starts; only a
 * success protects the victim for a while.
 * @param {{ guildId: string, robberId: string, victimId: string, victimIsBot?: boolean,
 *   victimJoinedAt?: number | null, config: object, now?: number, random?: () => number }} input
 * @returns {Promise<{ ok: true, success: boolean, amount: number, robber: object, victim: object } | { ok: false, reason: string, retryAt?: number }>}
 */
export async function doRob({
  guildId,
  robberId,
  victimId,
  victimIsBot = false,
  victimJoinedAt = null,
  config,
  now = Date.now(),
  random = Math.random,
}) {
  if (!config.robEnabled) return { ok: false, reason: 'rob_off' };
  if (robberId === victimId) return { ok: false, reason: 'self' };
  if (victimIsBot) return { ok: false, reason: 'bot' };
  // New members are safe for a while. If their join time cannot be read, the guard cannot be
  // checked, so the attempt is refused (it fails closed) rather than skipped.
  if (config.robNewMemberHours > 0) {
    if (!Number.isFinite(victimJoinedAt) || victimJoinedAt <= 0) return { ok: false, reason: 'join_unknown' };
    if (now - victimJoinedAt < config.robNewMemberHours * HOUR_MS) {
      return {
        ok: false,
        reason: 'new_member',
        retryAt: victimJoinedAt + config.robNewMemberHours * HOUR_MS,
      };
    }
  }
  const cooldownMs = config.robCooldownHours * HOUR_MS;
  const protectionMs = config.robProtectionMinutes * MINUTE_MS;

  const out = await transact(
    guildId,
    [robberId, victimId],
    (accounts) => {
      const robber = accounts.get(robberId);
      const victim = accounts.get(victimId);
      if (robber.lastRobAt > 0 && now - robber.lastRobAt < cooldownMs) {
        return { refuse: { reason: 'cooldown', retryAt: robber.lastRobAt + cooldownMs } };
      }
      // The robber must be able to pay the fine from cash, so a failed rob always costs something:
      // at least the smallest fine (and 1, when that is set to 0).
      const needed = Math.max(1, config.robFineMin);
      if (robber.cash < needed) return { refuse: { reason: 'robber_poor', needed } };
      if (victim.cash < Math.max(1, config.robVictimMinCash)) return { refuse: { reason: 'victim_poor' } };
      if (victim.lastRobbedAt > 0 && now - victim.lastRobbedAt < protectionMs) {
        return { refuse: { reason: 'victim_protected', retryAt: victim.lastRobbedAt + protectionMs } };
      }

      const success = random() * 100 < config.robChancePercent;
      if (success) {
        const percent = randomInt(config.robMinPercent, config.robMaxPercent, random);
        const room = Math.max(0, MAX_BALANCE - robber.total);
        const stolen = Math.min(Math.max(1, Math.floor((victim.cash * percent) / 100)), victim.cash, room);
        if (stolen < 1) return { refuse: { reason: 'robber_cap' } };
        return {
          changes: [
            { userId: victimId, cash: -stolen, kind: 'rob_loss', counterpartyId: robberId },
            { userId: robberId, cash: stolen, kind: 'rob_win', counterpartyId: victimId },
          ],
          stamps: { [robberId]: { last_rob_at: now }, [victimId]: { last_robbed_at: now } },
          result: { success: true, amount: stolen },
        };
      }
      // The fine is payable from cash (checked above); it is cut only to what fits under the
      // victim's cap.
      const room = Math.max(0, MAX_BALANCE - victim.total);
      const fine = Math.min(
        Math.max(config.robFineMin, 1, Math.floor((robber.cash * config.robFinePercent) / 100)),
        robber.cash,
        room
      );
      return {
        changes:
          fine > 0
            ? [
                { userId: robberId, cash: -fine, kind: 'rob_fine_out', counterpartyId: victimId },
                { userId: victimId, cash: fine, kind: 'rob_fine_in', counterpartyId: robberId },
              ]
            : [],
        stamps: { [robberId]: { last_rob_at: now } },
        result: { success: false, amount: fine },
      };
    },
    { now, config }
  );
  if (!out.ok) {
    return {
      ok: false,
      reason: out.reason,
      ...(out.retryAt && { retryAt: out.retryAt }),
      ...(out.needed && { needed: out.needed }),
    };
  }
  return {
    ok: true,
    success: out.result.success,
    amount: out.result.amount,
    robber: out.accounts.get(robberId),
    victim: out.accounts.get(victimId),
  };
}

// --- reading balances and the ranking --------------------------------------------------------------

const ZERO = { cash: 0, bank: 0 };

/** A member's balances (zeros without an account) and, with an account, their rank by total. */
export async function balanceOf(guildId, userId) {
  const row = await getAccount(guildId, userId);
  if (!row) return { ...ZERO, total: 0, rank: null, hasAccount: false, dailyStreak: 0 };
  const total = Number(row.cash) + Number(row.bank);
  return {
    cash: Number(row.cash),
    bank: Number(row.bank),
    total,
    rank: await rankOfTotal(guildId, total),
    hasAccount: true,
    dailyStreak: Number(row.daily_streak),
  };
}

/** One page of the leaderboard (top by total). `page` starts at 1 and is clamped to what exists. */
export async function leaderboardPage(guildId, page = 1, perPage = 10) {
  const total = await accountCount(guildId);
  const pages = Math.max(1, Math.ceil(total / perPage));
  const at = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  const rows = await topAccounts(guildId, perPage, (at - 1) * perPage);
  return {
    page: at,
    pages,
    total,
    rows: rows.map((r, i) => ({
      rank: (at - 1) * perPage + i + 1,
      userId: r.user_id,
      cash: Number(r.cash),
      bank: Number(r.bank),
      total: Number(r.cash) + Number(r.bank),
    })),
  };
}

/** A page of accounts for the dashboard's member list. */
export async function memberPage(guildId, { sort = 'total', dir = 'desc', page = 1, perPage = 25 } = {}) {
  const total = await accountCount(guildId);
  const pages = Math.max(1, Math.ceil(total / perPage));
  const at = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  const rows = await listAccounts(guildId, { sort, dir, limit: perPage, offset: (at - 1) * perPage });
  return {
    page: at,
    pages,
    total,
    rows: rows.map((r) => ({
      userId: r.user_id,
      cash: Number(r.cash),
      bank: Number(r.bank),
      total: Number(r.cash) + Number(r.bank),
      dailyStreak: Number(r.daily_streak),
    })),
  };
}

// --- staff: add, remove, set, reset ----------------------------------------------------------------

/**
 * A staff change to one member, through the money API (so the ledger has it). `action` is `add`,
 * `remove`, `set` (cash) or `reset-user`. `remove` takes cash first and then bank, and is refused
 * (`insufficient`) when the member has less in total. Posts to the log channel when one is set.
 * @returns {Promise<{ ok: true, action: string, applied: number, clamped?: boolean, account: object } | { ok: false, reason: string }>}
 */
export async function staffAdjust({ guildId, actorId, userId, action, amount, reason = '', config, guild }) {
  const meta = { actorId, reason: normaliseReason(reason), config };
  let out;
  if (action === 'add') {
    out = await credit(guildId, userId, amount, { kind: 'staff_add', ...meta });
    if (out.ok) out = { ok: true, applied: out.applied, clamped: out.clamped, account: out.account };
  } else if (action === 'remove') {
    out = await debit(guildId, userId, amount, { kind: 'staff_remove', from: 'cash-then-bank', ...meta });
    if (out.ok) out = { ok: true, applied: out.applied, account: out.account };
  } else if (action === 'set') {
    out = await setBalance(guildId, userId, amount, { kind: 'staff_set', ...meta });
    if (out.ok) out = { ok: true, applied: out.ledger[0]?.amount ?? 0, account: out.account };
  } else if (action === 'reset-user') {
    out = await resetAccount(guildId, userId, meta);
    if (out.ok) out = { ok: true, applied: out.account.total - out.before.total, account: out.account };
  } else {
    return { ok: false, reason: 'invalid_action' };
  }
  // The refusal is about the member's money, not the staff member's.
  if (!out.ok) return out.reason === 'insufficient' ? { ...out, reason: 'member_poor' } : out;
  await logStaffAction({
    guildId,
    config,
    guild,
    line: describeStaffAction({ action, userId, actorId, amount, applied: out.applied, config }),
    reason: meta.reason,
  });
  return { ...out, action };
}

/** Reset the whole server's economy (the dashboard's danger zone). */
export async function resetEconomy({ guildId, actorId, config, guild, beforeChunk }) {
  const out = await resetGuild(guildId, { actorId, reason: 'Economy reset', config, beforeChunk });
  const who = actorId ? `<@${actorId}>` : 'The dashboard';
  await logStaffAction({
    guildId,
    config,
    guild,
    line: out.ok
      ? `${who} reset the economy: ${formatNumber(out.accounts)} account(s) went back to a new start.`
      : `${who} tried to reset the economy. Partial reset: ${formatNumber(out.accounts)} of ${formatNumber(out.total)}, run it again to finish.`,
    reason: '',
  });
  return out;
}

function describeStaffAction({ action, userId, actorId, amount, applied, config }) {
  const who = `<@${userId}>`;
  const by = actorId ? `<@${actorId}>` : 'The dashboard';
  if (action === 'add') return `${by} added ${formatMoney(applied, config)} to ${who}.`;
  if (action === 'remove') return `${by} removed ${formatMoney(-applied, config)} from ${who}.`;
  if (action === 'set') return `${by} set the cash of ${who} to ${formatMoney(amount, config)}.`;
  return `${by} reset the account of ${who}.`;
}

/** Post a staff change to the module's log channel, if one is set. Never throws, never logs message text. */
async function logStaffAction({ guildId, config, line, reason }) {
  if (!config.logChannelId) return false;
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('Economy: staff change')
    .setDescription(line)
    .setTimestamp(Date.now());
  if (reason) embed.addFields({ name: 'Reason', value: reason.slice(0, LIMITS.reason.maxLength) });
  return sendToChannel(guildId, config.logChannelId, { embeds: [embed], allowedMentions: { parse: [] } });
}

// --- what the commands say -------------------------------------------------------------------------

/** The sentence for a refusal, or a generic one. `config` formats amounts. */
export function refusalText(result, config) {
  const at = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
  switch (result.reason) {
    case 'cooldown':
      return `You have to wait: try again ${at(result.retryAt)}.`;
    case 'insufficient':
      return result.needed
        ? `You do not have enough cash: you need ${formatMoney(result.needed, config)}.`
        : 'You do not have enough for that.';
    case 'member_poor':
      return 'That member does not have that much.';
    case 'nothing':
      return 'There is nothing to move.';
    case 'invalid_amount':
      return 'Give a whole number of at least 1, or "all".';
    case 'bank_off':
      return 'The bank is turned off in this server.';
    case 'pay_off':
      return 'Payments between members are turned off in this server.';
    case 'rob_off':
      return 'Robbing is turned off in this server.';
    case 'self':
      return 'You cannot do that to yourself.';
    case 'bot':
      return 'Bots do not have an account.';
    case 'recipient_cap':
      return `They cannot hold more than ${formatMoney(MAX_BALANCE, config)}.`;
    case 'cap':
      return `A balance cannot go above ${formatMoney(MAX_BALANCE, config)}.`;
    case 'join_unknown':
      return "I can't verify how long they've been here, so I can't let you rob them.";
    case 'robber_poor':
      return `You need at least ${formatMoney(result.needed, config)} cash to attempt a rob.`;
    case 'new_member':
      return `That member joined too recently to be robbed: try again ${at(result.retryAt)}.`;
    case 'victim_poor':
      return `Not worth it: they hold less than ${formatMoney(Math.max(1, config.robVictimMinCash), config)} in cash.`;
    case 'victim_protected':
      return `They were robbed a moment ago and are protected until ${at(result.retryAt)}.`;
    case 'robber_cap':
      return 'You could not carry any more.';
    default:
      return 'That did not work.';
  }
}

export const _internals = { voiceSessions, messageCooldowns };
