// /giveaway start|end|reroll|list — run prize giveaways with an Enter button.
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
  EmbedBuilder,
} from 'discord.js';
import { isModuleEnabled } from '../../db/modules.js';
import {
  createGiveaway,
  setGiveawayMessage,
  getGiveawayInGuild,
  activeGiveaways,
  giveawayEntryCount,
} from '../../db/giveaways.js';
import {
  buildGiveawayPayload,
  endGiveaway,
  MIN_MS,
  MAX_MS,
  MAX_WINNERS,
} from '../../modules/giveaways.js';
import { parseDuration, formatDuration } from '../lib/duration.js';

export const data = new SlashCommandBuilder()
  .setName('giveaway')
  .setDescription('Run a prize giveaway.')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) =>
    s
      .setName('start')
      .setDescription('Start a giveaway in this channel.')
      .addStringOption((o) => o.setName('prize').setDescription('What is being given away').setRequired(true).setMaxLength(250))
      .addStringOption((o) =>
        o.setName('duration').setDescription('How long it runs, e.g. 30m, 6h, 2d (min 1m, max 60d)').setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName('winners').setDescription('Number of winners (default 1)').setMinValue(1).setMaxValue(MAX_WINNERS)
      )
      .addRoleOption((o) => o.setName('required_role').setDescription('Only members with this role may enter'))
  )
  .addSubcommand((s) =>
    s.setName('end').setDescription('End a giveaway now and draw the winners.').addIntegerOption((o) => o.setName('id').setDescription('Giveaway id (see /giveaway list)').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('reroll')
      .setDescription('Draw new winners for a finished giveaway.')
      .addIntegerOption((o) => o.setName('id').setDescription('Giveaway id').setRequired(true))
      .addIntegerOption((o) => o.setName('count').setDescription('How many new winners (default 1)').setMinValue(1).setMaxValue(MAX_WINNERS))
  )
  .addSubcommand((s) => s.setName('list').setDescription('List the active giveaways in this server.'));

const eph = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (!isModuleEnabled(interaction.guildId, 'giveaways')) {
    return eph(interaction, 'The Giveaways module is not enabled in this server.');
  }
  const sub = interaction.options.getSubcommand();

  if (sub === 'start') {
    const prize = interaction.options.getString('prize', true).trim();
    const ms = parseDuration(interaction.options.getString('duration', true));
    if (ms == null || ms < MIN_MS || ms > MAX_MS) {
      return eph(interaction, 'Duration must be between 1m and 60d (e.g. `30m`, `6h`, `2d`).');
    }
    const winners = interaction.options.getInteger('winners') ?? 1;
    const role = interaction.options.getRole('required_role');
    const endsAt = Date.now() + ms;

    const { id } = createGiveaway({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      prize,
      winners,
      hostId: interaction.user.id,
      requiredRoleId: role?.id ?? null,
      endsAt,
    });

    const row = {
      id,
      prize,
      winners,
      host_id: interaction.user.id,
      required_role_id: role?.id ?? null,
      ends_at: endsAt,
      created_at: Date.now(),
      ended: false,
      wonIds: [],
    };
    await interaction.reply(buildGiveawayPayload(row, { entryCount: 0 }));
    const message = await interaction.fetchReply();
    setGiveawayMessage(id, message.id);
    return interaction.followUp({
      content: `Giveaway **#${id}** started — ends in ${formatDuration(ms)}.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'end') {
    const id = interaction.options.getInteger('id', true);
    const g = getGiveawayInGuild(id, interaction.guildId);
    if (!g) return eph(interaction, `No giveaway **#${id}** in this server.`);
    if (g.ended) return eph(interaction, `Giveaway **#${id}** has already ended — use \`/giveaway reroll\`.`);
    const r = await endGiveaway(id);
    return eph(
      interaction,
      r.winners?.length ? `Ended **#${id}** — winner(s): ${r.winners.map((w) => `<@${w}>`).join(', ')}` : `Ended **#${id}** — no valid entries.`
    );
  }

  if (sub === 'reroll') {
    const id = interaction.options.getInteger('id', true);
    const count = interaction.options.getInteger('count') ?? 1;
    const g = getGiveawayInGuild(id, interaction.guildId);
    if (!g) return eph(interaction, `No giveaway **#${id}** in this server.`);
    if (!g.ended) return eph(interaction, `Giveaway **#${id}** is still running — use \`/giveaway end\` first.`);
    const r = await endGiveaway(id, { rerollCount: count });
    return eph(
      interaction,
      r.winners?.length ? `Rerolled **#${id}** — new winner(s): ${r.winners.map((w) => `<@${w}>`).join(', ')}` : `Rerolled **#${id}** — no eligible entries left.`
    );
  }

  // list
  const active = activeGiveaways(interaction.guildId);
  if (!active.length) return eph(interaction, 'No active giveaways. Start one with `/giveaway start`.');
  const embed = new EmbedBuilder()
    .setColor(0xf0b232)
    .setTitle('Active giveaways')
    .setDescription(
      active
        .map(
          (g) =>
            `**#${g.id}** · ${g.prize} — ${g.winners} winner${g.winners === 1 ? '' : 's'} · ` +
            `${giveawayEntryCount(g.id)} entries · ends <t:${Math.floor(g.ends_at / 1000)}:R> · <#${g.channel_id}>`
        )
        .join('\n')
    );
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
