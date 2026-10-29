// Counting mini-game: members count upward, one number per message, in a
// designated channel. A wrong number (or, unless allowed, the same person
// twice in a row) breaks the streak.
//
// config shape: { channelId, allowSameUser, resetOnFail, react,
//                 penaltyRoleId, penaltyMinutes }
// Running state (current/record/last counter) lives in the `counting` table;
// active "benches" live in `counting_penalties`.
import { allClientsReady, guildByKey, guildKey } from '../platform/platformOf.js';
import { on } from './dispatch.js';
import { log } from '../lib/log.js';
import { every } from './schedule.js';
import { getCounting, advanceCount, resetCount } from '../db/counting.js';
import {
  addCountingPenalty,
  clearCountingPenalty,
  dueCountingPenalties,
  getCountingPenalty,
} from '../db/countingPenalties.js';

/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  penaltyMinutes: { min: 1, max: 10080 },
  // the running count an admin can set by hand (POST …/counting/count)
  count: { min: 0, max: 1e12 },
};

/** The count to store, or null when it is not a whole number inside the limits. */
export function validCount(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= LIMITS.count.min && n <= LIMITS.count.max ? n : null;
}

const idOrEmpty = (v) => (/^\d{17,20}$/.test(v ?? '') ? v : '');

/** Coerce a submitted counting config into the canonical shape. */
export function normaliseCountingConfig(raw = {}) {
  const penaltyMinutes = Math.round(Number(raw.penaltyMinutes));
  return {
    channelId: idOrEmpty(raw.channelId),
    allowSameUser: Boolean(raw.allowSameUser),
    resetOnFail: Boolean(raw.resetOnFail),
    react: Boolean(raw.react),
    penaltyRoleId: idOrEmpty(raw.penaltyRoleId),
    penaltyMinutes:
      Number.isFinite(penaltyMinutes) && penaltyMinutes >= LIMITS.penaltyMinutes.min
        ? Math.min(penaltyMinutes, LIMITS.penaltyMinutes.max)
        : 15,
  };
}

const OK = '✅';
const BAD = '❌';
const NUMBER_RE = /^\s*(\d{1,15})\s*$/;

on('counting', 'messageCreate', async (message, config, guildId) => {
  if (!config.channelId || message.channelId !== config.channelId) return;

  const match = NUMBER_RE.exec(message.content ?? '');
  if (!match) return; // not a counting attempt — leave chatter alone

  const value = Number(match[1]);
  const state = await getCounting(guildId);
  const expected = state.current + 1;

  const sameUser = !config.allowSameUser && state.last_user_id === message.author.id;
  const wrongNumber = value !== expected;

  if (sameUser || wrongNumber) {
    return fail(message, config, guildId, {
      brokeAt: state.current,
      record: state.record,
      reason: sameUser ? "you can't count twice in a row" : `the next number was **${expected}**`,
    });
  }

  // Someone else's count landed between our read and now: this number is a repeat.
  const advanced = await advanceCount(guildId, {
    current: value,
    userId: message.author.id,
    messageId: message.id,
    from: state.current,
  });
  if (!advanced) {
    const now = await getCounting(guildId);
    return fail(message, config, guildId, {
      brokeAt: now.current,
      record: now.record,
      reason: `the next number was **${now.current + 1}**`,
    });
  }

  if (config.react !== false) {
    await message.react(value > state.record ? '🎉' : OK).catch(() => {});
  }
});

// When someone breaks the streak: if a penalty role + duration are configured,
// pull that role off them and schedule its return. This only ever touches the
// one configured role — no ban, no timeout, no mod case.
async function benchCounter(message, config, guildId) {
  const roleId = config.penaltyRoleId;
  const minutes = Number(config.penaltyMinutes);
  if (!roleId || !Number.isFinite(minutes) || minutes <= 0) return null;

  const member = message.member;
  if (!member || member.user.bot) return null;
  if (!member.roles.cache.has(roleId)) return null; // nothing to take

  const guild = message.guild;
  const role = guild.roles.cache.get(roleId);
  const me = guild.members.me;
  if (!role || !role.editable || !me || me.roles.highest.comparePositionTo(role) <= 0) {
    log.warn('module:counting', `penalty role ${roleId} is above Sylo's highest role in guild ${guildId}`);
    return null;
  }

  await member.roles.remove(role, 'Counting: broke the streak').catch(() => {});
  const restoreAt = Date.now() + minutes * 60_000;
  await addCountingPenalty({ guildId, userId: member.id, roleId, restoreAt });
  return { minutes };
}

async function fail(message, config, guildId, { brokeAt, record, reason }) {
  const canManage = message.channel
    .permissionsFor(message.guild.members.me)
    ?.has(['SendMessages', 'AddReactions']);

  const bench = await benchCounter(message, config, guildId);
  const benchNote = bench ? ` You can't count for **${bench.minutes} min**.` : '';

  if (config.resetOnFail === false) {
    // Reject the bad number, keep the streak.
    await message.react(BAD).catch(() => {});
    if (message.deletable) await message.delete().catch(() => {});
    if (bench && canManage) {
      await message.channel
        .send({
          content: `${BAD} ${message.author} — ${reason}.${benchNote}`,
          allowedMentions: { users: [message.author.id] },
        })
        .catch(() => {});
    }
    return;
  }

  await resetCount(guildId);
  await message.react(BAD).catch(() => {});
  if (canManage) {
    await message.channel
      .send({
        content:
          `${BAD} ${message.author} broke the count at **${brokeAt}** — ${reason}.\n` +
          `Starting over from **1**.` +
          (record ? ` Best streak so far: **${record}**.` : '') +
          benchNote,
        allowedMentions: { users: [message.author.id] },
      })
      .catch(() => {});
  }
}

// A member who leaves forfeits any pending bench — the role is already gone
// with them, and a stale row must not follow them back in on rejoin.
on('counting', 'guildMemberRemove', async (member, _config, guildId) => {
  await clearCountingPenalty(guildId, member.id).catch(() => {});
});

// --- bench-expiry loop ------------------------------------------------
// Mirrors moderation.js's temp-ban sweep: a slow tick that hands the role
// back once `restore_at` has passed.

const PENALTY_TICK_MS = 30_000;

async function restoreBench(row, guild = guildByKey(row.guild_id)) {
  await clearCountingPenalty(row.guild_id, row.user_id); // clear first so a throw can't loop
  if (!guild) return;

  const role = guild.roles.cache.get(row.role_id);
  const me = guild.members.me;
  if (!role || !role.editable || !me || me.roles.highest.comparePositionTo(role) <= 0) return;

  const member = await guild.members.fetch(row.user_id).catch(() => null);
  if (!member) return; // left the server
  if (member.roles.cache.has(row.role_id)) return; // already re-added manually

  await member.roles.add(role, 'Counting: bench time served');
}

/**
 * End a member's bench early (the dashboard's "Release"): hand back the role stored with their
 * penalty. Nothing for someone who is not benched.
 * @returns {Promise<boolean>} whether there was a bench to end
 */
export async function releaseCountingPenalty(guild, userId) {
  const row = await getCountingPenalty(guildKey(guild), userId);
  if (!row) return false;
  await restoreBench(row, guild);
  return true;
}

every('counting', PENALTY_TICK_MS, async () => {
  if (!allClientsReady()) return;
  for (const row of await dueCountingPenalties(Date.now())) {
    restoreBench(row).catch((err) => log.error('module:counting', 'bench restore failed:', err.message));
  }
});
