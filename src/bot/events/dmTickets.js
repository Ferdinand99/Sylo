// DM → ticket bridge. A DM to the bot opens (or appends to) a ticket. When the
// user shares several ticket-enabled servers and has no open ticket, the bot
// asks which server with a select menu.
import { guildKey, guildByKey } from '../../platform/platformOf.js';
import { Events, StringSelectMenuBuilder, ActionRowBuilder } from 'discord.js';
import { ticketGuildsForUser, ingestUserDM } from '../../modules/tickets.js';
import { getOpenTicket } from '../../db/tickets.js';
import { registerComponent } from '../lib/components.js';
import { log } from '../../lib/log.js';

const SELECT_ID = 'ticket-guild';
const pending = new Map(); // userId -> { content, attachments, at }
const PENDING_TTL = 10 * 60 * 1000;

function stash(userId, payload) {
  pending.set(userId, { ...payload, at: Date.now() });
}
function takeStash(userId) {
  const p = pending.get(userId);
  pending.delete(userId);
  if (!p || Date.now() - p.at > PENDING_TTL) return null;
  return p;
}

async function handleDM(message) {
  if (message.guild || message.author.bot) return;
  if (message.partial) {
    try {
      await message.fetch();
    } catch {
      return;
    }
  }

  const payload = {
    content: message.content ?? '',
    attachments: [...message.attachments.values()].map((a) => a.url),
  };
  if (!payload.content && payload.attachments.length === 0) return;

  // Only the servers on the platform this DM arrived on: a user id means nothing on the other one.
  const guilds = await ticketGuildsForUser(message.author, message.client);
  if (guilds.length === 0) {
    await message
      .reply("I'm not set up to take messages for any server you're in right now.")
      .catch(() => {});
    return;
  }

  // If there's exactly one open ticket already, keep the conversation there.
  const openFlags = await Promise.all(guilds.map((g) => getOpenTicket(guildKey(g), message.author.id)));
  const openGuilds = guilds.filter((g, i) => openFlags[i]);
  if (openGuilds.length === 1) {
    await ingestUserDM(openGuilds[0], message.author, payload);
    await message.react('✅').catch(() => {});
    return;
  }
  if (openGuilds.length === 0 && guilds.length === 1) {
    await ingestUserDM(guilds[0], message.author, payload);
    await message.react('✅').catch(() => {});
    return;
  }

  // Ambiguous — ask which server.
  stash(message.author.id, payload);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(SELECT_ID)
    .setPlaceholder('Which server is this about?')
    .addOptions(
      (openGuilds.length ? openGuilds : guilds)
        .slice(0, 25)
        .map((g) => ({ label: g.name.slice(0, 100), value: guildKey(g) }))
    );
  await message
    .reply({
      content: 'You can reach staff in more than one server. Pick one:',
      components: [new ActionRowBuilder().addComponents(menu)],
    })
    .catch(() => {});
}

async function handleSelect(interaction) {
  const guild = guildByKey(interaction.values[0]);
  const payload = takeStash(interaction.user.id);
  if (!guild || !payload) {
    await interaction
      .update({ content: 'That request expired — send your message again.', components: [] })
      .catch(() => {});
    return;
  }
  const ticket = await ingestUserDM(guild, interaction.user, payload);
  await interaction
    .update({
      content: `Opened ticket #${ticket.id} for **${guild.name}**. Just keep replying here.`,
      components: [],
    })
    .catch(() => {});
}

registerComponent('tickets', SELECT_ID, handleSelect);

/** @param {import('discord.js').Client} client */
export function register(client, { isCommand = () => false } = {}) {
  client.on(Events.MessageCreate, (message) => {
    // `!help` in a DM is a command for the router (Fluxer), not a ticket message.
    if (isCommand(message)) return;
    handleDM(message).catch((err) => log.error('tickets', 'DM handler failed:', err));
  });
}
