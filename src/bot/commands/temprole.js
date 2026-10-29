// /temprole add|remove|list — give a member a role for a set time; Sylo takes it back by itself.
// Staff only: Manage Roles (or Administrator), or one of the staff roles set on the Temporary roles
// page. The code checks that itself, so the command is visible to everyone and works the same on
// Fluxer (`!temprole add @member @role 7d reason:"Trial period"`). On top of that the caller may
// only hand out a role below their own highest role, like anywhere else in Sylo.
import { SlashCommandBuilder, InteractionContextType, MessageFlags, EmbedBuilder } from 'discord.js';
import { getGuildModule } from '../../db/modules.js';
import { listTempRoles } from '../../db/tempRoles.js';
import { guildKey } from '../../platform/platformOf.js';
import {
  LIMITS,
  addTempRole,
  canManageTempRoles,
  describeTempRole,
  normaliseTempRolesConfig,
  parseTempDuration,
  removeTempRole,
} from '../../modules/tempRoles.js';
import { grantRefusal } from '../../web/middleware/roleGrants.js';

const LIST_SHOWN = 20;

export const data = new SlashCommandBuilder()
  .setName('temprole')
  .setDescription('Give a member a role for a while; Sylo takes it back automatically.')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Give a member a role for a set time.')
      .addUserOption((o) => o.setName('member').setDescription('Who gets the role').setRequired(true))
      .addRoleOption((o) => o.setName('role').setDescription('The role to give').setRequired(true))
      .addStringOption((o) =>
        o
          .setName('duration')
          .setDescription('How long: 30m, 12h, 7d, 2w or 1d12h (1 minute to 365 days)')
          .setRequired(true)
          .setMaxLength(40)
      )
      .addStringOption((o) =>
        o.setName('reason').setDescription('Why (kept in the mod log)').setMaxLength(LIMITS.reason.maxLength)
      )
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Take a temporary role back now.')
      .addUserOption((o) => o.setName('member').setDescription('Who has the role').setRequired(true))
      .addRoleOption((o) => o.setName('role').setDescription('The role to take back').setRequired(true))
      .addStringOption((o) =>
        o.setName('reason').setDescription('Why (kept in the mod log)').setMaxLength(LIMITS.reason.maxLength)
      )
  )
  .addSubcommand((s) =>
    s
      .setName('list')
      .setDescription('List the temporary roles in this server.')
      .addUserOption((o) => o.setName('member').setDescription('Only this member'))
  );

const eph = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

async function add(interaction, cfg) {
  const o = interaction.options;
  const user = o.getUser('member', true);
  const role = o.getRole('role', true);
  const duration = parseTempDuration(o.getString('duration', true));
  if (!duration.ok) return eph(interaction, duration.error);
  const why = grantRefusal(interaction.guild, interaction.member, role);
  if (why) return eph(interaction, why);

  const member =
    o.getMember?.('member') ?? (await interaction.guild.members.fetch(user.id).catch(() => null));
  const result = await addTempRole({
    guild: interaction.guild,
    member,
    role,
    durationMs: duration.ms,
    addedBy: interaction.user.id,
    reason: o.getString('reason') ?? '',
    cfg,
  });
  if (!result.ok) return eph(interaction, result.error);

  const until = `<t:${Math.floor(result.expiresAt / 1000)}:f>`;
  const lines = [
    result.replaced
      ? `Replaced the time for <@${user.id}>: **${role.name}** now ends ${until} (it was ${`<t:${Math.floor(result.previousExpiresAt / 1000)}:f>`}).`
      : `<@${user.id}> has **${role.name}** until ${until}.`,
  ];
  if (result.alreadyHadRole) {
    lines.push('They already had the role, so it will be taken away at that time.');
  }
  if (cfg.dmMember) lines.push(result.dm ? 'They were told by DM.' : 'Their DMs are closed.');
  return eph(interaction, lines.join('\n'));
}

async function remove(interaction, cfg) {
  const o = interaction.options;
  const user = o.getUser('member', true);
  const role = o.getRole('role', true);
  const why = grantRefusal(interaction.guild, interaction.member, role);
  if (why) return eph(interaction, why.replace('hand it out', 'take it back'));

  const result = await removeTempRole({
    guild: interaction.guild,
    userId: user.id,
    roleId: role.id,
    by: interaction.user.id,
    reason: o.getString('reason') ?? '',
    cfg,
  });
  if (!result.ok) return eph(interaction, result.error);
  return eph(
    interaction,
    result.warning
      ? `Stopped the timer for <@${user.id}>. ${result.warning}`
      : `Took **${role.name}** back from <@${user.id}>.`
  );
}

async function list(interaction) {
  const user = interaction.options.getUser('member');
  const rows = await listTempRoles(guildKey(interaction.guild), { userId: user?.id ?? null, limit: 500 });
  if (!rows.length) {
    return eph(
      interaction,
      user
        ? `<@${user.id}> has no temporary roles.`
        : 'No temporary roles right now. Add one with `/temprole add`.'
    );
  }
  const lines = rows.slice(0, LIST_SHOWN).map(describeTempRole);
  if (rows.length > LIST_SHOWN) lines.push(`…and ${rows.length - LIST_SHOWN} more on the dashboard.`);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(user ? 'Temporary roles of this member' : 'Temporary roles')
    .setDescription(lines.join('\n').slice(0, 4000));
  return interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const mod = await getGuildModule(interaction.guildId, 'temp-roles');
  if (!mod.enabled) return eph(interaction, 'The Temporary roles module is not enabled in this server.');
  const cfg = normaliseTempRolesConfig(mod.config);
  if (!canManageTempRoles(interaction.member, interaction.memberPermissions, cfg)) {
    return eph(
      interaction,
      'Only staff can use this: you need the Manage Roles permission or one of the staff roles set on the Temporary roles page.'
    );
  }
  const sub = interaction.options.getSubcommand();
  if (sub === 'add') return add(interaction, cfg);
  if (sub === 'remove') return remove(interaction, cfg);
  return list(interaction);
}
