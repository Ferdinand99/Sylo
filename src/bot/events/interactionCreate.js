// The single InteractionCreate listener. Message-component interactions
// (buttons, selects) go to the component router; slash commands are routed to
// their command module with per-guild overrides applied. Every handler is
// wrapped so a thrown error is logged and shown to the user, never crashing the
// process.
import { Events, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { getCommandOverride } from '../../db/commandOverrides.js';
import { handleCustomSlash } from '../lib/customCommandSync.js';
import { routeComponent } from '../lib/components.js';
import { log } from '../../lib/log.js';

export const name = Events.InteractionCreate;

/**
 * Check a per-guild command override. Returns a user-facing block reason, or
 * null when the command may run.
 *
 * A full disable applies to everyone (admins included) — if a server turns a
 * command off, it's off. Channel / role restrictions are bypassed by
 * administrators.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export function overrideBlockReason(interaction) {
  if (!interaction.inGuild()) return null;

  const ov = getCommandOverride(interaction.guildId, interaction.commandName);
  if (!ov) return null;

  if (!ov.enabled) return 'This command is disabled in this server.';

  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return null;

  if (ov.allowedChannels.length && !ov.allowedChannels.includes(interaction.channelId)) {
    return `This command can only be used in: ${ov.allowedChannels.map((c) => `<#${c}>`).join(', ')}.`;
  }

  if (ov.allowedRoles.length) {
    const roles = interaction.member?.roles;
    const ids = roles?.cache ? [...roles.cache.keys()] : Array.isArray(roles) ? roles : [];
    if (!ov.allowedRoles.some((r) => ids.includes(r))) {
      return 'You do not have a role allowed to use this command here.';
    }
  }

  return null;
}

/** @param {import('discord.js').Interaction} interaction */
export async function execute(interaction) {
  if (interaction.isMessageComponent()) {
    await routeComponent(interaction);
    return;
  }
  if (!interaction.isChatInputCommand()) return;

  const command = interaction.client.commands.get(interaction.commandName);
  if (!command) {
    try {
      if (await handleCustomSlash(interaction)) return;
    } catch (err) {
      log.error('bot', `Custom slash command "${interaction.commandName}" failed:`, err);
      return;
    }
    log.warn('bot', `Received unknown command: ${interaction.commandName}`);
    return;
  }

  const blocked = overrideBlockReason(interaction);
  if (blocked) {
    await interaction.reply({ content: `⚠️ ${blocked}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    log.error('bot', `Command "${interaction.commandName}" threw:`, err);

    const payload = {
      content: '⚠️ Something went wrong running that command. Please try again later.',
      flags: MessageFlags.Ephemeral,
    };
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch {
      // The interaction token may have expired; nothing more we can do.
    }
  }
}
