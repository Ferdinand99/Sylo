// DM → ticket bridge. A DM to the bot opens (or appends to) a ticket. When the
// user shares several ticket-enabled servers and has no open ticket, the bot
// asks which server with a select menu.
import { Events, StringSelectMenuBuilder, ActionRowBuilder } from 'discord.js';
import { ticketGuildsForUser, ingestUserDM } from '../../modules/tickets.js';
import { getOpenTicket } from '../../db/tickets.js';

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

  const guilds = await ticketGuildsForUser(message.author);
  if (guilds.length === 0) {
    await message.reply("I'm not set up to take messages for any server you're in right now.").catch(() => {});
    return;
  }

  // If there's exactly one open ticket already, keep the conversation there.
  const openGuilds = guilds.filter((g) => getOpenTicket(g.id, message.author.id));
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
      (openGuilds.length ? openGuilds : guilds).slice(0, 25).map((g) => ({ label: g.name.slice(0, 100), value: g.id }))
    );
  await message
    .reply({ content: 'You can reach staff in more than one server. Pick one:', components: [new ActionRowBuilder().addComponents(menu)] })
    .catch(() => {});
}

async function handleSelect(interaction) {
  if (!interaction.isStringSelectMenu() || interaction.customId !== SELECT_ID) return;
  const guild = interaction.client.guilds.cache.get(interaction.values[0]);
  const payload = takeStash(interaction.user.id);
  if (!guild || !payload) {
    await interaction.update({ content: 'That request expired — send your message again.', components: [] }).catch(() => {});
    return;
  }
  const ticket = await ingestUserDM(guild, interaction.user, payload);
  await interaction
    .update({ content: `Opened ticket #${ticket.id} for **${guild.name}**. Just keep replying here.`, components: [] })
    .catch(() => {});
}

/** @param {import('discord.js').Client} client */
export function register(client) {
  client.on(Events.MessageCreate, (message) => {
    handleDM(message).catch((err) => console.error('[tickets] DM handler failed:', err));
  });
  client.on(Events.InteractionCreate, (interaction) => {
    handleSelect(interaction).catch((err) => console.error('[tickets] select handler failed:', err));
  });
}
