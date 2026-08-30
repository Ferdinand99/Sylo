// Registers a guild's custom commands as Discord slash commands when the
// custom-commands module has `slash` enabled for that guild.
//
// guild.commands.set() REPLACES the guild's whole application-command list, so
// when Sylo's built-in commands are guild-scoped for this guild (dev mode,
// DISCORD_GUILD_ID) they must be included in the payload too.
import { config } from '../../config.js';
import { getGuildModule } from '../../db/modules.js';
import { usesArgs, buildCustomReply } from '../../modules/customCommands.js';

function toSlashJSON(cmd) {
  let description = String(cmd.embedTitle || cmd.response || 'Custom command')
    .replace(/\{[a-z]+\}/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  if (!description) description = 'Custom command';
  return {
    name: cmd.name,
    description,
    options: usesArgs(cmd)
      ? [{ type: 3, name: 'text', description: 'Extra text (fills {args})', required: false }]
      : [],
  };
}

/** Push the desired application-command set for one guild. */
export async function syncGuildCustomCommands(guild) {
  if (!guild) return;
  const { enabled, config: cfg } = getGuildModule(guild.id, 'custom-commands');
  const wantCustom = enabled && cfg.slash;

  const builtins = config.discordGuildIds.includes(guild.id)
    ? [...(guild.client.commands?.values() ?? [])].map((c) => c.data.toJSON())
    : [];
  const builtinNames = new Set(builtins.map((c) => c.name));

  const customs = wantCustom
    ? (cfg.commands ?? []).filter((c) => !builtinNames.has(c.name)).map(toSlashJSON)
    : [];

  try {
    await guild.commands.set([...builtins, ...customs]);
  } catch (err) {
    console.error(`[custom-commands] slash sync failed for guild ${guild.id}:`, err.message);
  }
}

/** Startup: sync every guild that currently wants slash custom commands. */
export async function syncAllGuildCustomCommands(client) {
  for (const guild of client.guilds.cache.values()) {
    const { enabled, config: cfg } = getGuildModule(guild.id, 'custom-commands');
    if (enabled && cfg.slash) await syncGuildCustomCommands(guild);
  }
}

/**
 * Handle a slash interaction that isn't a built-in command. Returns true if it
 * was a custom command and a reply was sent.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function handleCustomSlash(interaction) {
  if (!interaction.inGuild()) return false;
  const { enabled, config: cfg } = getGuildModule(interaction.guildId, 'custom-commands');
  if (!enabled || !cfg.slash) return false;

  const cmd = (cfg.commands ?? []).find((c) => c.name === interaction.commandName);
  if (!cmd) return false;

  const payload = buildCustomReply(cmd, {
    userId: interaction.user.id,
    username: interaction.user.username,
    guildName: interaction.guild?.name ?? '',
    channelId: interaction.channelId,
    args: interaction.options.getString('text') ?? '',
  });
  await interaction.reply(payload).catch(() => {});
  return true;
}
