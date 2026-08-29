// Ticket / modmail helpers. Users DM the bot; staff reply from the dashboard.
// The bot relays messages both ways. Staff replies are anonymous ("Staff").
import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { runtime } from '../runtime.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import {
  getOpenTicket,
  createTicket,
  addTicketMessage,
  closeTicket,
} from '../db/tickets.js';

const TICKET_COLOR = 0x4aa3df;
export const DEFAULT_GREETING =
  'Thanks for contacting the staff of {server}. Your message has been received — a moderator will reply here shortly.';
export const DEFAULT_CLOSE =
  'This ticket has been closed. Send another message any time to open a new one.';

const fill = (t, guild) => String(t || '').replaceAll('{server}', guild?.name ?? 'the server');

/** Guilds where the tickets module is enabled and the user is a member. */
export async function ticketGuildsForUser(user) {
  const out = [];
  for (const guild of runtime.client.guilds.cache.values()) {
    if (!isModuleEnabled(guild.id, 'tickets')) continue;
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (member) out.push(guild);
  }
  return out;
}

async function notifyStaff(guild, text) {
  const cfg = getGuildModule(guild.id, 'tickets').config;
  if (!cfg.notifyChannel) return;
  const ch =
    guild.channels.cache.get(cfg.notifyChannel) ??
    (await guild.channels.fetch(cfg.notifyChannel).catch(() => null));
  if (!ch?.isTextBased()) return;
  const me = guild.members.me;
  if (me && !ch.permissionsFor(me)?.has(['ViewChannel', 'SendMessages'])) return;
  await ch.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
}

/**
 * Record an inbound DM into the user's open ticket for `guild`, creating the
 * ticket (and sending the greeting + staff notification) if it's new.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').User} user
 * @param {{ content: string, attachments: string[] }} payload
 */
export async function ingestUserDM(guild, user, payload) {
  const cfg = getGuildModule(guild.id, 'tickets').config;
  let ticket = getOpenTicket(guild.id, user.id);
  const isNew = !ticket;
  if (!ticket) ticket = createTicket(guild.id, user.id);

  addTicketMessage(ticket.id, {
    authorId: user.id,
    authorKind: 'user',
    content: payload.content ?? '',
    attachments: payload.attachments ?? [],
  });

  const link = config.dashboardUrl ? `\n<${config.dashboardUrl}/guilds/${guild.id}/tickets/${ticket.id}>` : '';
  if (isNew) {
    await user
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(TICKET_COLOR)
            .setTitle(`Ticket #${ticket.id} — ${guild.name}`)
            .setDescription(fill(cfg.greeting || DEFAULT_GREETING, guild)),
        ],
      })
      .catch(() => {});
    await notifyStaff(guild, `🎫 New ticket #${ticket.id} from **${user.tag}** (\`${user.id}\`)${link}`);
  } else {
    await notifyStaff(guild, `💬 New reply on ticket #${ticket.id} from **${user.tag}**${link}`);
  }
  return ticket;
}

/**
 * DM an anonymous staff reply to the ticket user and record it.
 * @returns {Promise<{ delivered: boolean }>}
 */
export async function relayStaffReply(ticket, staffUserId, content) {
  const guild = runtime.client.guilds.cache.get(ticket.guild_id);
  const user = await runtime.client.users.fetch(ticket.user_id).catch(() => null);
  let delivered = Boolean(user);
  if (user) {
    try {
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setColor(TICKET_COLOR)
            .setAuthor({ name: `Staff reply · ${guild?.name ?? 'server'}` })
            .setDescription(content),
        ],
      });
    } catch {
      delivered = false;
    }
  }
  addTicketMessage(ticket.id, { authorId: staffUserId, authorKind: 'staff', content, delivered });
  return { delivered };
}

/**
 * Close a ticket. If `closingMessage` is given it is DMed as the final staff
 * message; otherwise the configured close notice is sent.
 * @param {object} ticket
 * @param {string} staffUserId
 * @param {string} [closingMessage]
 */
export async function closeTicketWithNotice(ticket, staffUserId, closingMessage) {
  const guild = runtime.client.guilds.cache.get(ticket.guild_id);
  const cfg = getGuildModule(ticket.guild_id, 'tickets').config;
  const user = await runtime.client.users.fetch(ticket.user_id).catch(() => null);

  const text = (closingMessage ?? '').trim();
  let delivered = Boolean(user);
  if (user) {
    const embed = new EmbedBuilder().setColor(0x8b95a1);
    if (text) {
      embed.setAuthor({ name: `Staff reply · ${guild?.name ?? 'server'}` }).setDescription(text);
      embed.setFooter({ text: 'This ticket is now closed. Message again to open a new one.' });
    } else {
      embed.setDescription(fill(cfg.closeMessage || DEFAULT_CLOSE, guild));
    }
    try {
      await user.send({ embeds: [embed] });
    } catch {
      delivered = false;
    }
  }

  if (text) {
    addTicketMessage(ticket.id, { authorId: staffUserId, authorKind: 'staff', content: text, delivered });
  }
  closeTicket(ticket.id, staffUserId);
  addTicketMessage(ticket.id, { authorId: staffUserId, authorKind: 'system', content: 'Ticket closed by staff.' });
}
