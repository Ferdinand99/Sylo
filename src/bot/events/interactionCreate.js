// Routes incoming slash-command interactions to the matching command module.
// Every command's execute() is wrapped so a thrown error is logged and shown to
// the user without ever crashing the process.
import { Events, MessageFlags } from 'discord.js';
import { setLastError } from '../../runtime.js';

export const name = Events.InteractionCreate;

/** @param {import('discord.js').Interaction} interaction */
export async function execute(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const command = interaction.client.commands.get(interaction.commandName);
  if (!command) {
    console.warn(`[bot] Received unknown command: ${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    setLastError(err);
    console.error(`[bot] Command "${interaction.commandName}" threw:`, err);

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
