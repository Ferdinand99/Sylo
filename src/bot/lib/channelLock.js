// Locking a channel = denying the message-sending permissions for @everyone,
// having first saved whatever @everyone overwrite was there before. Unlocking
// restores that saved state exactly (or removes the overwrite if there wasn't
// one). Shared by /lock, /unlock and /lockdown.
import { PermissionFlagsBits } from 'discord.js';
import { recordChannelLock, getChannelLock, clearChannelLock } from '../../db/channelLocks.js';

// The permissions a lock takes away. Threads + reactions are included so a
// locked channel can't be talked in sideways.
export const LOCK_PERMS = [
  'SendMessages',
  'SendMessagesInThreads',
  'CreatePublicThreads',
  'CreatePrivateThreads',
  'AddReactions',
];

/** Channel types /lock and /lockdown can act on. */
export function isLockableChannel(channel) {
  return Boolean(channel?.permissionOverwrites) && typeof channel.permissionOverwrites.edit === 'function';
}

/**
 * Can Sylo edit @everyone overwrites here? Returns a user-facing reason string
 * when it can't, or null when it can.
 * @param {import('discord.js').GuildChannel} channel
 */
export function lockPreflight(channel) {
  const me = channel.guild.members.me;
  if (!me) return "I'm not a member of this server.";
  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.ViewChannel)) return `I can't see ${channel}.`;
  if (!perms.has(PermissionFlagsBits.ManageRoles)) {
    return `I need **Manage Permissions** in ${channel} to lock it.`;
  }
  return null;
}

/** `{ SendMessages: false, ... }` — deny every lock perm. */
export function denyLockPerms() {
  return Object.fromEntries(LOCK_PERMS.map((p) => [p, false]));
}

/**
 * Rebuild the `permissionOverwrites.edit` payload that restores @everyone to its
 * saved state, touching only the lock perms: allow-bit → true, deny-bit → false,
 * neither → null (inherit). `prevAllow` / `prevDeny` are bitfields (BigInt or a
 * decimal string).
 */
export function restoreLockPerms(prevAllow, prevDeny) {
  const allow = BigInt(prevAllow);
  const deny = BigInt(prevDeny);
  const out = {};
  for (const p of LOCK_PERMS) {
    const bit = PermissionFlagsBits[p];
    if ((allow & bit) === bit) out[p] = true;
    else if ((deny & bit) === bit) out[p] = false;
    else out[p] = null;
  }
  return out;
}

/**
 * Lock a channel. No-op-safe: the pre-lock overwrite is only recorded the first
 * time, so a second lock can't overwrite the saved baseline with locked values.
 * @param {import('discord.js').GuildChannel} channel
 * @param {{ moderatorTag: string, lockdown?: boolean }} opts
 */
export async function lockChannel(channel, { moderatorTag, lockdown = false }) {
  const everyone = channel.guild.roles.everyone;
  if (!getChannelLock(channel.guild.id, channel.id)) {
    const existing = channel.permissionOverwrites.cache.get(everyone.id);
    recordChannelLock({
      guildId: channel.guild.id,
      channelId: channel.id,
      prevAllow: existing?.allow.bitfield ?? 0n,
      prevDeny: existing?.deny.bitfield ?? 0n,
      hadOverwrite: Boolean(existing),
      lockedBy: moderatorTag,
      lockdown,
    });
  }
  await channel.permissionOverwrites.edit(everyone, denyLockPerms(), { reason: `Locked by ${moderatorTag}` });
}

/**
 * Unlock a channel, restoring the saved @everyone state. If there is no saved
 * row (locked before this feature, or the DB row was lost) it just clears the
 * lock perms back to "inherit".
 * @param {import('discord.js').GuildChannel} channel
 * @param {{ moderatorTag: string }} opts
 */
export async function unlockChannel(channel, { moderatorTag }) {
  const everyone = channel.guild.roles.everyone;
  const saved = getChannelLock(channel.guild.id, channel.id);
  const reason = `Unlocked by ${moderatorTag}`;

  if (saved && !saved.had_overwrite) {
    await channel.permissionOverwrites.delete(everyone, reason);
  } else if (saved) {
    await channel.permissionOverwrites.edit(everyone, restoreLockPerms(saved.prev_allow, saved.prev_deny), {
      reason,
    });
  } else {
    await channel.permissionOverwrites.edit(everyone, Object.fromEntries(LOCK_PERMS.map((p) => [p, null])), {
      reason,
    });
  }
  clearChannelLock(channel.guild.id, channel.id);
}
