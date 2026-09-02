// Registers a guild's custom commands as Discord `/slash` commands and executes
// them. guild.commands.set() REPLACES the guild's whole application-command
// list, so when Sylo's built-in commands are guild-scoped for this guild (dev
// mode, DISCORD_GUILD_ID) they must be included in the payload too.
import { MessageFlags } from 'discord.js';
import { config } from '../../config.js';
import { getGuildModule } from '../../db/modules.js';
import { usesArgs, pickMessage, buildActionPayload } from '../../modules/customCommands.js';
import { log } from '../../lib/log.js';

function toSlashJSON(cmd) {
  let description = String(cmd.description || cmd.name || 'Custom command')
    .replace(/\{[a-z.]+\}/gi, '')
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

  const builtins = config.discordGuildIds.includes(guild.id)
    ? [...(guild.client.commands?.values() ?? [])].map((c) => c.data.toJSON())
    : [];
  const builtinNames = new Set(builtins.map((c) => c.name));

  const customs = enabled
    ? (cfg.commands ?? []).filter((c) => !builtinNames.has(c.name)).map(toSlashJSON)
    : [];

  try {
    await guild.commands.set([...builtins, ...customs]);
  } catch (err) {
    log.error('custom-commands', `slash sync failed for guild ${guild.id}:`, err.message);
  }
}

/** Startup: sync every guild that has the module enabled. */
export async function syncAllGuildCustomCommands(client) {
  for (const guild of client.guilds.cache.values()) {
    if (getGuildModule(guild.id, 'custom-commands').enabled) {
      await syncGuildCustomCommands(guild);
    }
  }
}

// --- execution ---------------------------------------------------------------

const cooldowns = new Map(); // `${guildId}:${name}:${userId}` -> expiresAt (ms)

function blockReason(cmd, interaction) {
  if (cmd.allowedChannels?.length && !cmd.allowedChannels.includes(interaction.channelId)) {
    return `This command can only be used in: ${cmd.allowedChannels.map((c) => `<#${c}>`).join(', ')}.`;
  }
  if (cmd.allowedRoles?.length) {
    const roles = interaction.member?.roles;
    const ids = roles?.cache ? [...roles.cache.keys()] : Array.isArray(roles) ? roles : [];
    if (!cmd.allowedRoles.some((r) => ids.includes(r))) {
      return 'You do not have a role allowed to use this command.';
    }
  }
  if (cmd.cooldownSeconds > 0) {
    const key = `${interaction.guildId}:${cmd.name}:${interaction.user.id}`;
    const until = cooldowns.get(key) ?? 0;
    if (Date.now() < until) {
      return `⏳ That command is on cooldown — try again in ${Math.ceil((until - Date.now()) / 1000)}s.`;
    }
    cooldowns.set(key, Date.now() + cmd.cooldownSeconds * 1000);
  }
  return null;
}

/**
 * Handle a slash interaction that isn't a built-in command. Returns true if it
 * was a custom command (and was handled).
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function handleCustomSlash(interaction) {
  if (!interaction.inGuild()) return false;
  const { enabled, config: cfg } = getGuildModule(interaction.guildId, 'custom-commands');
  if (!enabled) return false;

  const cmd = (cfg.commands ?? []).find((c) => c.name === interaction.commandName);
  if (!cmd) return false;

  const blocked = blockReason(cmd, interaction);
  if (blocked) {
    await interaction.reply({ content: blocked, flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }

  const ctx = {
    userId: interaction.user.id,
    username: interaction.user.username,
    guildName: interaction.guild?.name ?? '',
    channelId: interaction.channelId,
    args: interaction.options.getString('text') ?? '',
  };

  const firstReply = cmd.actions.find((a) => a.type === 'reply');
  const deferEphemeral = firstReply ? firstReply.private : true;
  await interaction.deferReply(deferEphemeral ? { flags: MessageFlags.Ephemeral } : {}).catch(() => {});

  let answered = false;
  for (const action of cmd.actions) {
    try {
      if (action.type === 'reply') {
        const payload = buildActionPayload(pickMessage(action.messages), ctx);
        if (!answered) {
          await interaction.editReply(payload);
          answered = true;
        } else {
          await interaction.followUp({
            ...payload,
            flags: action.private ? MessageFlags.Ephemeral : undefined,
          });
        }
      } else if (action.type === 'send') {
        if (!/^\d{17,20}$/.test(action.channelId)) continue;
        const ch = interaction.guild.channels.cache.get(action.channelId);
        if (ch?.isTextBased()) await ch.send(buildActionPayload(pickMessage(action.messages), ctx));
      } else if (action.type === 'add-role' || action.type === 'remove-role') {
        if (!/^\d{17,20}$/.test(action.roleId)) continue;
        const member =
          interaction.member && interaction.member.roles?.add
            ? interaction.member
            : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) continue;
        if (action.type === 'add-role') await member.roles.add(action.roleId, 'Custom command');
        else await member.roles.remove(action.roleId, 'Custom command');
      }
    } catch (err) {
      log.error('custom-commands', `"${cmd.name}" action "${action.type}" failed:`, err.message);
    }
  }

  if (!answered) await interaction.editReply({ content: '✅ Done.' }).catch(() => {});
  return true;
}
