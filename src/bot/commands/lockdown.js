// /lockdown start|end — lock (or unlock) every text channel at once, for raids.
// Each channel's prior overwrite is saved individually, so `/lockdown end`
// restores them to exactly where they were.
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import { MOD_COLOR, NO_REASON } from '../lib/moderation.js';
import { postModLog } from '../lib/modlog.js';
import { lockPreflight, lockChannel, unlockChannel } from '../lib/channelLock.js';
import { isChannelLocked, lockdownChannelLocks, clearChannelLock } from '../../db/channelLocks.js';

const LOCKDOWN_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
]);
// A hard ceiling so a huge server can't spawn thousands of permission edits.
const MAX_CHANNELS = 500;

export const data = new SlashCommandBuilder()
  .setName('lockdown')
  .setDescription('Lock or unlock every text channel at once.')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommand((c) =>
    c
      .setName('start')
      .setDescription('Lock every text channel.')
      .addStringOption((o) =>
        o.setName('reason').setDescription('Shown in the audit log and mod-log').setMaxLength(400)
      )
  )
  .addSubcommand((c) => c.setName('end').setDescription('Unlock everything /lockdown start locked.'));

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const reason = interaction.options.getString('reason') ?? NO_REASON;
  const { guild } = interaction;
  const moderatorTag = interaction.user.tag;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (sub === 'start') {
    const targets = [...guild.channels.cache.values()]
      .filter((ch) => LOCKDOWN_TYPES.has(ch.type))
      .slice(0, MAX_CHANNELS);

    let locked = 0;
    let skipped = 0;
    for (const channel of targets) {
      if (isChannelLocked(guild.id, channel.id) || lockPreflight(channel)) {
        skipped += 1;
        continue;
      }
      try {
        await lockChannel(channel, { moderatorTag, lockdown: true });
        locked += 1;
      } catch {
        skipped += 1;
      }
    }

    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('🔒 Server lockdown started')
      .addFields(
        { name: 'Channels locked', value: String(locked) },
        { name: 'Skipped', value: `${skipped} (already locked or missing perms)` },
        { name: 'Moderator', value: moderatorTag },
        { name: 'Reason', value: reason }
      )
      .setTimestamp(Date.now());
    await interaction.editReply({ embeds: [embed] });
    await postModLog(guild, embed);
    return;
  }

  // end
  const rows = lockdownChannelLocks(guild.id);
  if (rows.length === 0) {
    await interaction.editReply({ content: 'No lockdown is active.' });
    return;
  }

  let unlocked = 0;
  let failed = 0;
  for (const row of rows) {
    const channel =
      guild.channels.cache.get(row.channel_id) ??
      (await guild.channels.fetch(row.channel_id).catch(() => null));
    if (!channel) {
      clearChannelLock(guild.id, row.channel_id); // channel gone — drop the stale row
      failed += 1;
      continue;
    }
    try {
      await unlockChannel(channel, { moderatorTag });
      unlocked += 1;
    } catch {
      failed += 1;
    }
  }

  const embed = new EmbedBuilder()
    .setColor(MOD_COLOR)
    .setTitle('🔓 Server lockdown ended')
    .addFields(
      { name: 'Channels unlocked', value: String(unlocked) },
      { name: 'Failed', value: String(failed) },
      { name: 'Moderator', value: moderatorTag }
    )
    .setTimestamp(Date.now());
  await interaction.editReply({ embeds: [embed] });
  await postModLog(guild, embed);
}
