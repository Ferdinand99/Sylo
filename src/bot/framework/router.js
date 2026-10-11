// Runs a command from a chat message (`!ban @user spam`, or `@Sylo ban @user spam`)
// the way interactionCreate.js runs one from a slash command: the same command
// modules, the same per-guild overrides, the same error handling. Checks, in
// order: guild-only, the command's default member permissions (a platform with
// no slash commands has no permission gating of its own, so it is enforced
// here), per-guild overrides, then argument parsing and resolution.
import { MessageFlags, PermissionFlagsBits, InteractionContextType } from 'discord.js';
import { overrideBlockReason } from '../events/interactionCreate.js';
import { MessageInteraction } from './MessageInteraction.js';
import { parseArgs, ParseError } from './parser.js';
import { resolveOptions } from './resolve.js';
import { usageLines } from './usage.js';
import { log } from '../../lib/log.js';
import { inc } from '../../lib/metrics.js';

const NO_ARGS = { subcommand: null, values: {} };

/**
 * Split a message into command name + argument text, or null when it isn't a
 * command. Accepts the prefix or a leading mention of the bot.
 * @param {string} content
 * @param {string} prefix
 * @param {string | null | undefined} botId
 * @returns {{ name: string, rest: string } | null}
 */
export function splitCommand(content, prefix, botId) {
  let body = null;
  if (content.startsWith(prefix)) body = content.slice(prefix.length);
  else if (botId && /^\d+$/.test(botId)) {
    const m = new RegExp(`^<@!?${botId}>\\s*`).exec(content);
    if (m) body = content.slice(m[0].length);
  }
  if (body == null) return null;
  const m = /^([a-z0-9_-]+)(?:\s+|$)/i.exec(body);
  if (!m) return null;
  return { name: m[1].toLowerCase(), rest: body.slice(m[0].length) };
}

/**
 * @param {any} message  the incoming message
 * @param {{ commands: Map<string, { data: any, execute: Function }>, prefix: string, botId?: string }} opts
 */
export async function handleMessage(message, { commands, prefix, botId = message.client?.user?.id }) {
  if (message.author?.bot || typeof message.content !== 'string') return;
  const split = splitCommand(message.content, prefix, botId);
  if (!split) return;
  const command = commands.get(split.name);
  if (!command) return;

  const schema = command.data.toJSON();
  const init = { message, commandName: split.name };
  const early = new MessageInteraction({ ...init, parsed: NO_ARGS, resolved: {} });
  const refuse = (text) =>
    early.reply({ content: `⚠️ ${text}`, flags: MessageFlags.Ephemeral }).catch(() => {});

  if (!message.guild && schema.contexts && !schema.contexts.includes(InteractionContextType.BotDM)) {
    return refuse('This command can only be used in a server.');
  }

  if (schema.default_member_permissions && message.guild) {
    const perms = message.member?.permissions;
    const needed = BigInt(schema.default_member_permissions);
    if (!(perms?.has(needed) || perms?.has(PermissionFlagsBits.Administrator))) {
      return refuse("You don't have permission to use this command.");
    }
  }

  const blocked = await overrideBlockReason(early);
  if (blocked) return refuse(blocked);

  let parsed;
  let resolved;
  try {
    parsed = parseArgs(schema, split.rest);
    resolved = await resolveOptions(parsed.values, { client: message.client, guild: message.guild });
  } catch (err) {
    if (!(err instanceof ParseError)) throw err;
    const usage = usageLines(prefix, schema)
      .map((l) => `\`${l}\``)
      .join('\n');
    return refuse(`${err.message}\nUsage: ${usage}`);
  }

  const interaction = new MessageInteraction({ ...init, parsed, resolved });
  inc('sylo_commands_total', { command: split.name });
  try {
    await command.execute(interaction);
  } catch (err) {
    log.error('bot', `Command "${split.name}" threw:`, err);
    const payload = {
      content: '⚠️ Something went wrong running that command. Please try again later.',
      flags: MessageFlags.Ephemeral,
    };
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch {
      // Nothing more we can do.
    }
  }
}

/**
 * Listen for prefix commands on a chat client.
 * @param {{ on: Function }} client
 * @param {{ commands: Map<string, { data: any, execute: Function }>, prefix: string }} opts
 */
export function attachPrefixCommands(client, { commands, prefix }) {
  client.on('messageCreate', (message) => {
    handleMessage(message, { commands, prefix }).catch((err) =>
      log.error('bot', 'prefix command failed:', err)
    );
  });
}
