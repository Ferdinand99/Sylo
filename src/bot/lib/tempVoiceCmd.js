// Shared plumbing for the /voice-* temporary-channel commands.
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { isModuleEnabled } from '../../db/modules.js';
import { getTempChannel } from '../../db/tempVoice.js';
import { hubForChannel } from '../../modules/tempVoice.js';

export const ephemeral = { flags: MessageFlags.Ephemeral };

/**
 * Resolve the temp channel the caller is acting on (the voice channel they are
 * connected to). Returns { row, hub, channel, member, isOwner, isModerator,
 * isIgnored } or { error } for an early ephemeral reply.
 */
export function resolveContext(interaction) {
  if (!interaction.inGuild()) return { error: 'Use this in a server.' };
  if (!isModuleEnabled(interaction.guildId, 'temp-voice')) {
    return { error: 'Temporary voice channels are not enabled in this server.' };
  }
  const member = interaction.member;
  const vcId = member?.voice?.channelId;
  if (!vcId) return { error: 'Join your temporary voice channel first.' };

  const row = getTempChannel(vcId);
  if (!row) return { error: 'This only works in a temporary voice channel.' };

  const channel = interaction.guild.channels.cache.get(vcId);
  if (!channel) return { error: 'That channel no longer exists.' };

  const hub = hubForChannel(interaction.guildId, row.hub_id) || {
    moderatorRoles: [],
    ignoredRoles: [],
  };
  const roleIds = [...(member.roles?.cache?.keys() ?? [])];
  const isOwner = row.owner_id === member.id;
  const isModerator =
    member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    hub.moderatorRoles.some((r) => roleIds.includes(r));
  const isIgnored = hub.ignoredRoles.some((r) => roleIds.includes(r));

  return { row, hub, channel, member, isOwner, isModerator, isIgnored };
}

/** True when the caller may run a control command on this channel. */
export function canControl(ctx) {
  return ctx.isOwner || ctx.isModerator;
}

/** Whether `targetMember` can be kicked/banned by `ctx` from this channel. */
export function targetActable(ctx, targetMember) {
  if (!targetMember) return 'That member is not in the channel.';
  if (targetMember.id === ctx.row.owner_id && !ctx.isModerator) return "You can't target the channel owner.";
  if (targetMember.id === ctx.member.id) return "You can't target yourself.";
  const tRoles = [...(targetMember.roles?.cache?.keys() ?? [])];
  if (ctx.hub.ignoredRoles?.some((r) => tRoles.includes(r)))
    return 'That member is exempt from voice commands.';
  if (!ctx.isModerator && ctx.hub.moderatorRoles?.some((r) => tRoles.includes(r))) {
    return "You can't target a voice moderator.";
  }
  return null;
}
