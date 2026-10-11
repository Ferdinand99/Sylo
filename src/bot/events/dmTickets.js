// DM → ticket bridge. A DM to the bot opens (or appends to) a ticket. When the
// bot serves several ticket-enabled servers and the destination is ambiguous, it
// asks which server with a select menu.
import { Events, StringSelectMenuBuilder, ActionRowBuilder } from 'discord.js';
import { ticketGuildsForDM, ingestUserDM } from '../../modules/tickets.js';
import { handleDMTicketStaffMessage } from '../../modules/dmTicketChannels.js';
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

  const guilds = await ticketGuildsForDM();
  if (guilds.length === 0) {
    await message.reply('Nie obsługuję obecnie zgłoszeń DM na żadnym serwerze.').catch(() => {});
    return;
  }

  // If there's exactly one open ticket already, keep the conversation there.
  const openFlags = await Promise.all(guilds.map((g) => getOpenTicket(g.id, message.author.id)));
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
    .setPlaceholder('Którego serwera dotyczy zgłoszenie?')
    .addOptions(
      (openGuilds.length ? openGuilds : guilds)
        .slice(0, 25)
        .map((g) => ({ label: g.name.slice(0, 100), value: g.id }))
    );
  await message
    .reply({
      content: 'Możesz skontaktować się z administracją kilku serwerów. Wybierz jeden:',
      components: [new ActionRowBuilder().addComponents(menu)],
    })
    .catch(() => {});
}

async function handleSelect(interaction) {
  const guild = interaction.client.guilds.cache.get(interaction.values[0]);
  const payload = takeStash(interaction.user.id);
  if (!guild || !payload) {
    await interaction
      .update({ content: 'Ten wybór wygasł — wyślij swoją wiadomość ponownie.', components: [] })
      .catch(() => {});
    return;
  }
  await interaction.deferUpdate();
  if (!(await ticketGuildsForDM()).some((candidate) => candidate.id === guild.id)) {
    await interaction.editReply({
      content: 'Zgłoszenia DM na tym serwerze zostały wyłączone.',
      components: [],
    });
    return;
  }
  const ticket = await ingestUserDM(guild, interaction.user, payload);
  await interaction
    .editReply({
      content: `Otwarto zgłoszenie #${ticket.id} dla serwera **${guild.name}**. Kolejne wiadomości wysyłaj tutaj.`,
      components: [],
    })
    .catch(() => {});
}

registerComponent('tickets', SELECT_ID, handleSelect);

/** @param {import('discord.js').Client} client */
export function register(client) {
  client.on(Events.MessageCreate, (message) => {
    const job = message.guild ? handleDMTicketStaffMessage(message) : handleDM(message);
    job.catch(async (err) => {
      log.error('tickets', 'Ticket message handler failed:', err);
      if (!message.author.bot)
        await message
          .reply({
            content:
              'Nie udało się przekazać wiadomości. Administracja musi sprawdzić konfigurację i uprawnienia ticketów.',
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
    });
  });
}
