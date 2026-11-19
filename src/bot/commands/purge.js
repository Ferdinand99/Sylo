// /purge <amount> [user] — delete recent messages in the current channel, of any age.
//
// Messages younger than 14 days go through the bulk route; older ones (Discord only: its bulk route
// refuses them) are deleted one at a time at a pace the platform accepts. Fluxer's bulk route has no
// age limit, so everything goes through it there. See bot/lib/purgeMessages.js.
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
import { MOD_COLOR, replyWithoutGuild } from '../lib/moderation.js';
import { postModLog } from '../lib/modlog.js';
import {
  MAX_RUN_MS,
  acquirePurgeLock,
  canStopPurge,
  purgeMessages,
  splitByAge,
} from '../lib/purgeMessages.js';
import { respondSafely } from '../../lib/discordErrors.js';
import { guildKey, platformOfGuild } from '../../platform/platformOf.js';
import { log } from '../../lib/log.js';

export const STOP_CUSTOM_ID = 'purge:stop';
/** Edit the progress reply at most this often (Discord allows 5 webhook edits per 5 s). */
export const PROGRESS_EDIT_MS = 2500;

export const data = new SlashCommandBuilder()
  .setName('purge')
  .setDescription('Delete recent messages in this channel, of any age (max 100).')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addIntegerOption((o) =>
    o
      .setName('amount')
      .setDescription('How many messages to scan/delete (1-100)')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(100)
  )
  .addUserOption((o) => o.setName('user').setDescription('Only delete messages from this user'));

const plural = (n) => `**${n}** message${n === 1 ? '' : 's'}`;

/** "2 already gone, 1 missing permission" for the failures that happened. */
export function describeFailures(failures) {
  return [
    failures.gone && `${failures.gone} already gone`,
    failures.permission && `${failures.permission} missing permission`,
    failures.other && `${failures.other} failed for another reason`,
  ]
    .filter(Boolean)
    .join(', ');
}

/** The reply during a long purge. */
export function progressText({ deleted, failed, total }) {
  return `🧹 Deleted **${deleted}** of **${total}**…${failed ? ` (${failed} could not be deleted)` : ''}`;
}

/** The final reply. */
export function summaryText(result, user) {
  const from = user ? ` from ${user.tag}` : '';
  const lines = [];
  if (result.stopped) {
    lines.push(
      `⏹️ Stopped. Deleted ${plural(result.deleted)}${from} of **${result.total}**; **${result.remaining}** left untouched.`
    );
  } else {
    lines.push(`🧹 Deleted ${plural(result.deleted)}${from}.`);
  }
  if (result.failed) {
    lines.push(`⚠️ ${plural(result.failed)} could not be deleted (${describeFailures(result.failures)}).`);
  }
  return lines.join('\n');
}

function stopRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(STOP_CUSTOM_ID)
      .setEmoji('🛑')
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger)
  );
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (await replyWithoutGuild(interaction)) return;
  const amount = interaction.options.getInteger('amount', true);
  const user = interaction.options.getUser('user');
  const channel = interaction.channel;

  const me = interaction.guild.members.me;
  if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply({
      content: '⚠️ I need the **Manage Messages** permission in this channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // One purge at a time per channel; taken before anything is awaited, so two commands cannot both pass.
  const release = acquirePurgeLock(`${guildKey(interaction.guild)}:${channel.id}`, interaction.user.id);
  if (!release) {
    await interaction.reply({
      content:
        '⚠️ A purge is already running in this channel. Wait for it to finish, or ask whoever started it (or a server admin) to press Stop.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let collector = null;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let messages = await channel.messages.fetch({ limit: amount });
    if (user) messages = messages.filter((m) => m.author.id === user.id);
    const targets = [...messages.values()];

    const platform = platformOfGuild(interaction.guild);
    // Only a Discord purge with messages past the bulk limit takes long enough for progress and a Stop button.
    const longRun = platform !== 'fluxer' && splitByAge(targets).old.length > 0;

    let stopRequested = false;
    let pending = Promise.resolve();
    let lastEdit = 0;
    const edit = (payload) => {
      pending = pending
        .then(() => interaction.editReply(payload))
        .catch((err) => log.warn('bot', '/purge progress update failed:', err?.message ?? err));
    };

    if (longRun) {
      await interaction.editReply({
        content: progressText({ deleted: 0, failed: 0, total: targets.length }),
        components: [stopRow()],
      });
      const message = await interaction.fetchReply();
      collector = message?.createMessageComponentCollector?.({
        componentType: ComponentType.Button,
        time: MAX_RUN_MS + 60_000,
      });
      collector?.on('collect', (i) =>
        respondSafely('bot', '/purge stop', async () => {
          const allowed = canStopPurge({
            userId: i.user.id,
            starterId: interaction.user.id,
            permissions: i.memberPermissions,
            administrator: PermissionFlagsBits.Administrator,
          });
          if (!allowed) {
            await i.reply({
              content: 'Only the person who ran this purge, or a server admin, can stop it.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          stopRequested = true;
          await i.update({ content: '⏹️ Stopping…', components: [] });
        })
      );
    }

    const result = await purgeMessages(channel, targets, {
      platform,
      isStopped: () => stopRequested,
      onProgress: (p) => {
        if (!longRun || stopRequested) return;
        const now = Date.now();
        if (now - lastEdit < PROGRESS_EDIT_MS) return;
        lastEdit = now;
        edit({ content: progressText(p) });
      },
    });

    collector?.stop('done');
    await pending;
    await interaction.editReply({
      content: summaryText(result, user),
      ...(longRun ? { components: [] } : {}),
    });

    if (result.deleted > 0) {
      const embed = new EmbedBuilder()
        .setColor(MOD_COLOR)
        .setTitle('Messages purged')
        .addFields(
          { name: 'Channel', value: `${channel}` },
          { name: 'Count', value: String(result.deleted) },
          ...(result.failed ? [{ name: 'Failed', value: String(result.failed) }] : []),
          ...(result.stopped ? [{ name: 'Stopped early', value: `${result.remaining} left untouched` }] : []),
          { name: 'Moderator', value: interaction.user.tag },
          ...(user ? [{ name: 'Filtered to', value: user.tag }] : [])
        )
        .setTimestamp(Date.now());
      await postModLog(interaction.guild, embed);
    }
  } finally {
    collector?.stop('done');
    release();
  }
}
