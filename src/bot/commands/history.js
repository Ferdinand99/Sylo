// /history <user> [page] — private, paginated moderation history including archived cases.
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
import { listUserCases } from '../../db/modCases.js';
import { INFO_COLOR } from '../lib/moderation.js';
import { log } from '../../lib/log.js';

export const HISTORY_PAGE_SIZE = 5;

export const ACTION_LABELS = {
  warn: '⚠️ Ostrzeżenie',
  note: '📝 Notatka',
  timeout: '⏳ Wyciszenie',
  untimeout: '⏳ Cofnięcie wyciszenia',
  kick: '👢 Wyrzucenie',
  ban: '🔨 Ban',
  unban: '🔓 Odbanowanie',
};

/** Mention a moderator account, or label an automated/dashboard action. */
export function moderatorMention(id) {
  if (/^\d{17,20}$/.test(id)) return `<@${id}>`;
  return { automod: 'AutoMod', auto: 'Automatyczny próg kar', web: 'Panel', '': 'System' }[id] ?? id;
}

export const data = new SlashCommandBuilder()
  .setName('history')
  .setDescription("Show a member's moderation history.")
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('user').setDescription('Member to look up').setRequired(true))
  .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1));

export async function loadHistoryPage(guildId, userId, asked = 1) {
  const requested = Math.max(1, Math.floor(asked));
  const options = {
    limit: HISTORY_PAGE_SIZE,
    offset: (requested - 1) * HISTORY_PAGE_SIZE,
    includeInactive: true,
  };
  let result = await listUserCases(guildId, userId, options);
  const pages = Math.max(1, Math.ceil(result.total / HISTORY_PAGE_SIZE));
  const page = Math.min(requested, pages);
  if (page !== requested) {
    result = await listUserCases(guildId, userId, { ...options, offset: (page - 1) * HISTORY_PAGE_SIZE });
  }
  return { ...result, page, pages };
}

export function historyEmbed(user, { rows, total, page, pages }) {
  const embed = new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setAuthor({ name: `Historia kar — ${user.tag}`.slice(0, 256), iconURL: user.displayAvatarURL() })
    .setDescription(
      total
        ? `Użytkownik: <@${user.id}>\nWpisy archiwalne pozostają w historii; nie oznaczają aktualnie obowiązującej kary.`
        : 'Brak zapisanych kar i notatek dla tego użytkownika.'
    )
    .setFooter({ text: `${total} wpisów · strona ${page}/${pages}` });
  // Five bounded fields leave room below Discord's 6000-character embed limit.
  for (const c of rows.slice(0, HISTORY_PAGE_SIZE)) {
    const label = ACTION_LABELS[c.action] ?? c.action;
    const detail = c.detail ? ` · ${c.detail}` : '';
    embed.addFields({
      name: `#${c.case_number} · ${label}${c.active ? '' : ' · archiwalny'}${detail}`.slice(0, 180),
      value:
        `Data: <t:${Math.floor(c.created_at / 1000)}:f>\nModerator: ${String(moderatorMention(c.moderator_id)).slice(0, 100)}\nPowód: ${c.reason || 'Nie podano powodu.'}`.slice(
          0,
          850
        ),
    });
  }
  return embed;
}

export function historyButtons({ page, pages }, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('history:previous')
        .setLabel('Poprzednia')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || page <= 1),
      new ButtonBuilder()
        .setCustomId('history:next')
        .setLabel('Następna')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || page >= pages)
    ),
  ];
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const user = interaction.options.getUser('user', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let state = await loadHistoryPage(
    interaction.guild.id,
    user.id,
    interaction.options.getInteger('page') ?? 1
  );
  const payload = () => ({
    embeds: [historyEmbed(user, state)],
    components: historyButtons(state),
    allowedMentions: { parse: [] },
  });
  const message = await interaction.editReply(payload());
  if (state.pages <= 1) return;
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 120_000,
  });
  let busy = false;
  collector.on('collect', async (click) => {
    let acquired = false;
    try {
      if (click.user.id !== interaction.user.id) {
        await click.reply({
          content: 'Otwórz własną historię komendą /history.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!['history:previous', 'history:next'].includes(click.customId)) return;
      if (busy) {
        await click.deferUpdate();
        return;
      }
      busy = true;
      acquired = true;
      // Recheck delegated roles and disabled/channel restrictions on every click.
      const { overrideBlockReason } = await import('../events/interactionCreate.js');
      const blocked = await overrideBlockReason({
        commandName: 'history',
        inGuild: () => click.inGuild(),
        guildId: click.guildId,
        channelId: click.channelId,
        member: click.member,
        memberPermissions: click.memberPermissions,
      });
      if (blocked) {
        await click.reply({
          content: 'Nie masz już dostępu do historii kar w tym kanale.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await click.deferUpdate();
      const asked = state.page + (click.customId === 'history:next' ? 1 : -1);
      state = await loadHistoryPage(interaction.guild.id, user.id, asked);
      await interaction.editReply({ ...payload(), components: historyButtons(state, collector.ended) });
    } catch (err) {
      log.error('history', 'History pagination failed:', err.message);
      if (!click.deferred && !click.replied) {
        await click
          .reply({
            content: 'Nie udało się wczytać historii. Spróbuj ponownie.',
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }
    } finally {
      if (acquired) busy = false;
    }
  });
  collector.on('end', () => {
    interaction.editReply({ components: historyButtons(state, true) }).catch(() => {});
  });
}
