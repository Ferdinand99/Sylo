// Discord staff workspace for DM modmail. User conversations remain in DMs.
import {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  MessageFlags,
} from 'discord.js';
import { getGuildModule, isModuleEnabled } from '../db/modules.js';
import {
  getTicketChannel,
  getChannelTicket,
  setTicketChannel,
  setTicketChannelCursor,
  ticketMessages,
  getTicket,
} from '../db/tickets.js';
import { registerComponent } from '../bot/lib/components.js';
import { buildTextTranscript, relayStaffReply, closeTicketWithNotice } from './tickets.js';

const jobs = new Map();
export async function withDMTicketLock(guildId, userId, fn) {
  const key = `${guildId}:${userId}`;
  const previous = jobs.get(key) || Promise.resolve();
  const job = previous.catch(() => {}).then(fn);
  jobs.set(key, job);
  try {
    return await job;
  } finally {
    if (jobs.get(key) === job) jobs.delete(key);
  }
}
const roleIds = (cfg) => [...new Set([...(cfg.staffRoles || []), ...(cfg.pingRoles || [])])];
export function canReplyToDMTicket(member, cfg) {
  return Boolean(
    member?.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    roleIds(cfg).some((role) => member?.roles?.cache?.has(role))
  );
}
async function destination(guild, cfg) {
  if (cfg.dmCategory) return cfg.dmCategory;
  const parentId = cfg.panelChannel || cfg.notifyChannel;
  const parent = parentId ? await guild.channels.fetch(parentId).catch(() => null) : null;
  return parent?.parentId || cfg.ticketTypes?.find((type) => type.categoryId)?.categoryId || '';
}
export async function syncDMTicketChannel(guild, ticket, user) {
  const cfg = (await getGuildModule(guild.id, 'tickets')).config;
  let mapping = await getTicketChannel(ticket.id);
  let channel = mapping ? await guild.channels.fetch(mapping.channel_id).catch(() => null) : null;
  if (!channel) {
    const categoryId = await destination(guild, cfg);
    if (!categoryId) throw new Error('Ustaw kategorię zgłoszeń z DM w konfiguracji ticketów.');
    const category = await guild.channels.fetch(categoryId);
    if (category?.type !== ChannelType.GuildCategory)
      throw new Error('Wybierz poprawną kategorię zgłoszeń z DM.');
    const allow = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
    ];
    const me = guild.members.me;
    if (!me) throw new Error('Nie można ustalić uprawnień bota.');
    channel = await guild.channels.create({
      name: `dm-ticket-${ticket.id}`,
      type: ChannelType.GuildText,
      parent: categoryId,
      topic: `Zgłoszenie z DM #${ticket.id} · użytkownik ${ticket.user_id}`,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: me.id, allow },
        ...roleIds(cfg)
          .filter((role) => role !== guild.id && guild.roles.cache.has(role))
          .map((role) => ({ id: role, allow })),
      ],
    });
    try {
      await setTicketChannel(ticket, channel.id);
    } catch (error) {
      await channel.delete().catch(() => {});
      throw error;
    }
    mapping = await getTicketChannel(ticket.id);
  }
  if (Number(mapping.last_message_id) === 0) {
    const pings = (cfg.pingRoles || []).filter((role) => role !== guild.id && guild.roles.cache.has(role));
    await channel.send({
      content: `🎫 Zgłoszenie z DM od **${user?.tag || ticket.user_id}** (\`${ticket.user_id}\`).\nOdpowiadaj tutaj — wiadomości i załączniki trafią na DM użytkownika.\n${pings.map((role) => `<@&${role}>`).join(' ')}`,
      allowedMentions: { parse: [], roles: pings },
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`dm-ticket-close:${ticket.id}`)
            .setLabel('Zamknij zgłoszenie')
            .setStyle(ButtonStyle.Danger)
        ),
      ],
    });
    await setTicketChannelCursor(ticket.id, -1);
    mapping.last_message_id = -1;
  }
  for (const row of await ticketMessages(ticket.id, Number(mapping.last_message_id))) {
    const label =
      row.author_kind === 'user'
        ? 'Wiadomość użytkownika'
        : row.author_kind === 'staff'
          ? 'Odpowiedź administracji'
          : 'System';
    const text = [row.content, ...row.attachments].filter(Boolean).join('\n') || '(brak treści)';
    for (let i = 0; i < text.length; i += 4000) {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x4aa3df)
            .setAuthor({ name: label })
            .setDescription(text.slice(i, i + 4000)),
        ],
        allowedMentions: { parse: [] },
      });
    }
    await setTicketChannelCursor(ticket.id, row.id);
  }
  return channel;
}

// Archive before closing or deleting. A failed export retains the open channel.
export async function archiveDMTicketChannel(ticket, staffUserId) {
  const mapping = await getTicketChannel(ticket.id);
  if (!mapping) return;
  const { runtime } = await import('../runtime.js');
  const guild = runtime.client.guilds.cache.get(ticket.guild_id);
  const cfg = (await getGuildModule(ticket.guild_id, 'tickets')).config;
  if (!cfg.ticketLogChannel || cfg.ticketLogChannel === mapping.channel_id)
    throw new Error('Ustaw osobny kanał logów ticketów przed zamknięciem zgłoszenia.');
  const logs = await guild.channels.fetch(cfg.ticketLogChannel);
  if (!logs?.isTextBased()) throw new Error('Kanał logów ticketów jest niedostępny.');
  const transcript = await buildTextTranscript({ ...ticket, closed_at: Date.now() });
  const bytes = Buffer.from(transcript.text, 'utf8');
  for (let i = 0; i < bytes.length; i += 7 * 1024 * 1024) {
    await logs.send({
      content: `Zapis zgłoszenia z DM #${ticket.id} · użytkownik ${ticket.user_id} · zamykający ${staffUserId}`,
      files: [
        new AttachmentBuilder(bytes.subarray(i, i + 7 * 1024 * 1024), {
          name: `dm-ticket-${ticket.id}-${Math.floor(i / (7 * 1024 * 1024)) + 1}.txt`,
        }),
      ],
      allowedMentions: { parse: [] },
    });
  }
}
export async function deleteDMTicketChannel(ticket) {
  const mapping = await getTicketChannel(ticket.id);
  if (!mapping) return;
  const { runtime } = await import('../runtime.js');
  const guild = runtime.client.guilds.cache.get(ticket.guild_id);
  const channel = await guild?.channels.fetch(mapping.channel_id).catch(() => null);
  if (channel) await channel.delete('Zamknięto zgłoszenie z DM; zapisano rozmowę w logach.');
}

export async function handleDMTicketStaffMessage(message) {
  if (!message.guild || message.author.bot || message.webhookId) return;
  const ticket = await getChannelTicket(message.channelId, message.guild.id);
  if (!ticket || !(await isModuleEnabled(message.guild.id, 'tickets'))) return;
  await withDMTicketLock(ticket.guild_id, ticket.user_id, async () => {
    if ((await getTicket(ticket.id))?.status !== 'open') return;
    const cfg = (await getGuildModule(ticket.guild_id, 'tickets')).config;
    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!canReplyToDMTicket(member, cfg)) return;
    const attachments = [...message.attachments.values()].map((a) => a.url);
    if (!message.content && !attachments.length) {
      await message.reply({
        content: 'Brak treści do przekazania. Sprawdź Message Content Intent bota.',
        allowedMentions: { parse: [] },
      });
      return;
    }
    await syncDMTicketChannel(message.guild, ticket);
    const result = await relayStaffReply(ticket, message.author.id, message.content || '', attachments);
    // The staff message already exists in the workspace; do not mirror it again.
    const rows = await ticketMessages(ticket.id);
    await setTicketChannelCursor(ticket.id, rows.at(-1).id);
    if (result.delivered) await message.react('✅').catch(() => {});
    else
      await message.reply({
        content: 'Nie udało się wysłać odpowiedzi na DM. Użytkownik mógł zablokować wiadomości.',
        allowedMentions: { parse: [] },
      });
  });
}
registerComponent('tickets', 'dm-ticket-close:', async (interaction) => {
  const ticket = await getTicket(Number(interaction.customId.split(':')[1]));
  const mapping = ticket && (await getTicketChannel(ticket.id));
  const cfg = interaction.guild && (await getGuildModule(interaction.guild.id, 'tickets')).config;
  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (
    !ticket ||
    mapping?.channel_id !== interaction.channelId ||
    ticket.guild_id !== interaction.guildId ||
    !(await isModuleEnabled(ticket.guild_id, 'tickets')) ||
    !canReplyToDMTicket(member, cfg || {})
  ) {
    await interaction.reply({
      content: 'Nie masz dostępu do zamknięcia tego zgłoszenia.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await closeTicketWithNotice(ticket, interaction.user.id);
    await interaction.editReply('Zgłoszenie zamknięte.').catch(() => {});
  } catch (error) {
    await interaction.editReply(`Nie udało się zamknąć zgłoszenia: ${error.message}`);
  }
});
