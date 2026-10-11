import { randomUUID } from 'node:crypto';
import {
  AttachmentBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { registerComponent } from '../bot/lib/components.js';
import { getGuildModule, isModuleEnabled } from '../db/modules.js';
import { sendToChannel } from './lib/send.js';

const id = (value) => (/^\d{17,20}$/.test(value ?? '') ? value : '');
export const DEFAULT_TICKET_FIELDS = [
  { label: 'Tytuł', placeholder: '', style: 'short', required: true },
  { label: 'Opis', placeholder: '', style: 'paragraph', required: true },
];
export function ticketFormFields(config = {}) {
  const raw = Array.isArray(config.formFields) ? config.formFields : DEFAULT_TICKET_FIELDS;
  const fields = raw
    .filter((field) => field && typeof field === 'object')
    .slice(0, 5)
    .map((field) => ({
      label: String(field.label || '')
        .trim()
        .slice(0, 45),
      placeholder: String(field.placeholder || '').slice(0, 100),
      style: field.style === 'short' ? 'short' : 'paragraph',
      required: field.required !== false && field.required !== 'no',
    }))
    .filter((field) => field.label);
  return fields.length ? fields : DEFAULT_TICKET_FIELDS.map((field) => ({ ...field }));
}
const formFieldId = (index) => ['title', 'description'][index] || `field_${index}`;
export function normaliseChannelTickets(input = {}, previous = {}) {
  const seen = new Set();
  const types = (Array.isArray(input.ticketTypes) ? input.ticketTypes : [])
    .filter((row) => row && typeof row === 'object')
    .slice(0, 25)
    .flatMap((row) => {
      const label = String(row.label ?? '')
        .trim()
        .slice(0, 100);
      if (!label) return [];
      let key = /^[a-zA-Z0-9_-]{1,50}$/.test(row.id ?? '') ? row.id : randomUUID();
      if (seen.has(key)) key = randomUUID();
      seen.add(key);
      return [
        {
          id: key,
          label,
          description: String(row.description ?? '')
            .trim()
            .slice(0, 100),
          categoryId: id(row.categoryId),
        },
      ];
    });
  const panelChannel = id(input.panelChannel);
  return {
    panelChannel,
    dmCategory: id(input.dmCategory ?? previous.dmCategory),
    panelMessageId: panelChannel === previous.panelChannel ? previous.panelMessageId || '' : '',
    panelTitle: String(input.panelTitle || 'Tickety pomocy').slice(0, 256),
    panelText: String(
      input.panelText || 'Kliknij przycisk, aby wybrać temat i otworzyć prywatny ticket.'
    ).slice(0, 2000),
    ticketLogChannel: id(input.ticketLogChannel),
    ticketTypes: types,
    formTitle:
      String(input.formTitle || 'Otwórz ticket')
        .trim()
        .slice(0, 45) || 'Otwórz ticket',
    formFields: ticketFormFields(input),
    pingRoles: [...new Set([].concat(input.pingRoles ?? []).filter((role) => id(role)))].slice(0, 20),
  };
}

export async function publishTicketPanel(guild, cfg) {
  if (!cfg.panelChannel || !cfg.ticketTypes?.length)
    throw new Error('Wybierz kanał panelu i dodaj przynajmniej jeden temat ticketa.');
  if (cfg.ticketTypes.some((type) => !type.categoryId))
    throw new Error('Wybierz kategorię dla każdego tematu ticketa.');
  for (const type of cfg.ticketTypes) {
    const category = await guild.channels.fetch(type.categoryId);
    if (category?.type !== ChannelType.GuildCategory)
      throw new Error('Brakuje kategorii ticketa. Wybierz ją ponownie.');
  }
  const channel = await guild.channels.fetch(cfg.panelChannel);
  if (!channel?.isTextBased()) throw new Error('Kanał panelu jest niedostępny.');
  const payload = {
    embeds: [new EmbedBuilder().setColor(0x4aa3df).setTitle(cfg.panelTitle).setDescription(cfg.panelText)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket-channel:start')
          .setLabel('Otwórz ticket')
          .setStyle(ButtonStyle.Primary)
      ),
    ],
    allowedMentions: { parse: [] },
  };
  const old = cfg.panelMessageId ? await channel.messages.fetch(cfg.panelMessageId).catch(() => null) : null;
  if (old?.author.id === guild.members.me.id) return (await old.edit(payload)).id;
  return (await channel.send(payload)).id;
}

const locks = new Set();
const callCooldowns = new Map();
const topicFor = (owner, type) => `sylo-ticket:${owner}:${type}:open`;
export const parseTicketTopic = (topic) =>
  /^sylo-ticket:(\d{17,20}):([a-zA-Z0-9_-]{1,50}):(open|closed)$/.exec(topic || '');
async function ticketLog(guild, cfg, title, fields) {
  return sendToChannel(guild.id, cfg.ticketLogChannel, {
    embeds: [new EmbedBuilder().setColor(0x4aa3df).setTitle(title).addFields(fields).setTimestamp()],
  });
}

// Fetch every page, including messages that are not in the bot cache.
export async function channelTicketTranscript(channel, ownerId, closerId) {
  const messages = [];
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    messages.push(...batch.values());
    const oldest = [...batch.keys()].reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
    if (oldest === before) throw new Error('Nie udało się pobrać kolejnej strony historii ticketa.');
    before = oldest;
    if (batch.size < 100) break;
  }
  messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
  const blocks = [
    `Kanał ticketa: #${channel.name || channel.id} (${channel.id})\nAutor: ${ownerId}\nZamknął: ${closerId}\nZarchiwizowano: ${new Date().toISOString()}\nWiadomości: ${messages.length}\n\n`,
    ...messages.map((message) => {
      const lines = [
        `[${new Date(message.createdTimestamp).toISOString()}] ${message.author?.tag || 'Nieznany'} (${message.author?.id || 'unknown'}) | Wiadomość ${message.id}`,
      ];
      if (message.content) lines.push(message.content);
      for (const embed of message.embeds || []) {
        if (embed.title) lines.push(`[Embed] ${embed.title}`);
        if (embed.description) lines.push(embed.description);
        for (const field of embed.fields || []) lines.push(`${field.name}: ${field.value}`);
        if (embed.image?.url) lines.push(`[Obraz] ${embed.image.url}`);
      }
      for (const file of message.attachments?.values() || [])
        lines.push(`[Załącznik] ${file.name || 'file'}: ${file.url}`);
      return lines.join('\n') + '\n\n';
    }),
  ];
  const parts = [];
  let buffers = [];
  let size = 0;
  for (const block of blocks) {
    const bytes = Buffer.from(block, 'utf8');
    if (size && size + bytes.length > 7 * 1024 * 1024) {
      parts.push(Buffer.concat(buffers));
      buffers = [];
      size = 0;
    }
    buffers.push(bytes);
    size += bytes.length;
  }
  if (size) parts.push(Buffer.concat(buffers));
  return parts;
}

export async function archiveChannelTicket(guild, channel, cfg, ownerId, closerId) {
  if (!cfg.ticketLogChannel || cfg.ticketLogChannel === channel.id)
    throw new Error('Przed zamknięciem wybierz osobny kanał logów ticketów.');
  const parts = await channelTicketTranscript(channel, ownerId, closerId);
  for (let index = 0; index < parts.length; index++) {
    const sent = await sendToChannel(guild.id, cfg.ticketLogChannel, {
      embeds: [
        new EmbedBuilder()
          .setColor(0x8b95a1)
          .setTitle('Ticket zamknięty')
          .addFields(
            { name: 'Użytkownik', value: `<@${ownerId}> (${ownerId})` },
            { name: 'Zamknął', value: `<@${closerId}> (${closerId})` },
            { name: 'Kanał', value: `#${channel.name || channel.id} (${channel.id})` },
            { name: 'Zapis rozmowy', value: `Część ${index + 1}/${parts.length}` }
          )
          .setTimestamp(),
      ],
      files: [
        new AttachmentBuilder(parts[index], { name: `ticket-${channel.id}-transcript-${index + 1}.txt` }),
      ],
      allowedMentions: { parse: [] },
    });
    if (!sent) throw new Error('Nie udało się wysłać zapisu rozmowy; kanał ticketa pozostał.');
  }
  await channel.delete(`Ticket zarchiwizowany i zamknięty przez ${closerId}`);
}

export async function handleChannelTicket(interaction) {
  if (!interaction.guild || !(await isModuleEnabled(interaction.guildId, 'tickets'))) {
    return interaction.reply({
      content: 'Tickets are disabled in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const current = (await getGuildModule(interaction.guildId, 'tickets')).config;
  if (interaction.customId === 'ticket-channel:start') {
    if (
      !interaction.isButton() ||
      interaction.channelId !== current.panelChannel ||
      interaction.message.id !== current.panelMessageId
    )
      return interaction.reply({
        content: 'Użyj aktualnego panelu ticketów.',
        flags: MessageFlags.Ephemeral,
      });
    if (!current.ticketTypes?.length)
      return interaction.reply({ content: 'Brak skonfigurowanych tematów.', flags: MessageFlags.Ephemeral });
    return interaction.reply({
      content: 'Wybierz temat zgłoszenia:',
      flags: MessageFlags.Ephemeral,
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket-channel:select:${interaction.user.id}:${current.panelMessageId}`)
            .setPlaceholder('Wybierz temat zgłoszenia')
            .addOptions(
              current.ticketTypes.map((type) => ({
                label: type.label,
                value: type.id,
                ...(type.description ? { description: type.description } : {}),
              }))
            )
        ),
      ],
    });
  }
  const selected = /^ticket-channel:select:(\d{17,20}):(\d{17,20})$/.exec(interaction.customId);
  if (selected) {
    if (
      selected[1] !== interaction.user.id ||
      selected[2] !== current.panelMessageId ||
      interaction.channelId !== current.panelChannel ||
      !interaction.isStringSelectMenu()
    )
      return interaction.reply({
        content: 'Otwórz własny formularz z aktualnego panelu.',
        flags: MessageFlags.Ephemeral,
      });
    const type = current.ticketTypes?.find((item) => item.id === interaction.values[0]);
    if (!type)
      return interaction.reply({
        content: 'Ten temat nie jest już dostępny.',
        flags: MessageFlags.Ephemeral,
      });
    return interaction.showModal(
      new ModalBuilder()
        .setCustomId(`ticket-channel:submit:${interaction.user.id}:${type.id}`)
        .setTitle(current.formTitle || 'Otwórz ticket')
        .addComponents(
          ...ticketFormFields(current).map((field, index) => {
            const input = new TextInputBuilder()
              .setCustomId(formFieldId(index))
              .setLabel(field.label)
              .setStyle(field.style === 'short' ? TextInputStyle.Short : TextInputStyle.Paragraph)
              .setRequired(field.required)
              .setMaxLength(index === 0 ? 100 : 1000);
            if (field.placeholder) input.setPlaceholder(field.placeholder);
            return new ActionRowBuilder().addComponents(input);
          })
        )
    );
  }
  const submission = /^ticket-channel:submit:(\d{17,20}):([a-zA-Z0-9_-]{1,50})$/.exec(interaction.customId);
  if (
    submission &&
    (submission[1] !== interaction.user.id ||
      interaction.channelId !== current.panelChannel ||
      !interaction.isModalSubmit())
  )
    return interaction.reply({ content: 'Otwórz własny formularz ticketu.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const cfg = (await getGuildModule(guild.id, 'tickets')).config;
  const opening = interaction.customId === 'ticket-channel:open' || Boolean(submission);
  const lock = opening ? `${guild.id}:${interaction.user.id}` : `${guild.id}:${interaction.channelId}`;
  if (locks.has(lock)) return interaction.editReply('Trwa już wykonywanie działania na tym tickecie.');
  locks.add(lock);
  try {
    if (opening) {
      if (!submission && !interaction.isStringSelectMenu())
        return interaction.editReply('Wybierz temat zgłoszenia z menu.');
      if (
        interaction.channelId !== cfg.panelChannel ||
        (!submission && interaction.message.id !== cfg.panelMessageId)
      )
        return interaction.editReply('Ten panel jest nieaktualny. Użyj obecnego panelu ticketów.');
      const type = cfg.ticketTypes?.find(
        (item) => item.id === (submission ? submission[2] : interaction.values[0])
      );
      const answers = submission
        ? ticketFormFields(cfg).map((field, index) => {
            let value = '';
            try {
              value = interaction.fields.getTextInputValue(formFieldId(index)).trim();
            } catch {
              /* A form changed while open. */
            }
            return { ...field, value: value.slice(0, index === 0 ? 100 : 1000) };
          })
        : [];
      if (answers.some((field) => field.required && !field.value))
        return interaction.editReply(
          'Uzupełnij wymagane pola. Jeśli formularz się zmienił, otwórz go ponownie.'
        );
      const title = answers[0]?.value || type?.label;
      const description =
        answers.length > 1
          ? answers
              .slice(1)
              .map((field) => `**${field.label}**\n${field.value || '—'}`)
              .join('\n\n')
              .slice(0, 4096)
          : 'Zgłoszenie dla administracji.';
      if (!type) return interaction.editReply('Ten temat ticketa nie jest już dostępny.');
      const existing = guild.channels.cache.find((channel) => {
        const match = parseTicketTopic(channel.topic);
        return match?.[1] === interaction.user.id && match[3] === 'open';
      });
      if (existing) return interaction.editReply(`Masz już otwarty ticket: ${existing}`);
      const category = await guild.channels.fetch(type.categoryId);
      if (category?.type !== ChannelType.GuildCategory)
        return interaction.editReply('Kategoria ticketa jest niedostępna. Skontaktuj się z administracją.');
      const permissions = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ];
      const pingRoles = [...new Set([].concat(cfg.pingRoles || []))]
        .filter((role) => role !== guild.id && guild.roles.cache.has(role))
        .slice(0, 20);
      const staffRoles = [...new Set([...(cfg.staffRoles || []), ...pingRoles])].filter(
        (role) => role !== guild.id && guild.roles.cache.has(role)
      );
      const channel = await guild.channels.create({
        name: `ticket-${interaction.user.username.replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'member'}-${interaction.user.id.slice(-4)}`,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: topicFor(interaction.user.id, type.id),
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: permissions },
          { id: guild.members.me.id, allow: [...permissions, PermissionFlagsBits.ManageChannels] },
          ...staffRoles.map((role) => ({ id: role, allow: permissions })),
        ],
        reason: `Ticket otwarty przez ${interaction.user.id}: ${type.label}`,
      });
      try {
        await channel.send({
          content: [`<@${interaction.user.id}>`, ...pingRoles.map((role) => `<@&${role}>`)].join(' '),
          allowedMentions: { parse: [], users: [interaction.user.id], roles: pingRoles },
          embeds: [
            new EmbedBuilder()
              .setColor(0x4aa3df)
              .setTitle(title)
              .setDescription(description)
              .addFields(
                { name: 'Autor', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Utworzono', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true }
              )
              .setTimestamp(),
          ],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('ticket-channel:close')
                .setStyle(ButtonStyle.Danger)
                .setLabel('Zamknij ticket'),
              new ButtonBuilder()
                .setCustomId('ticket-channel:call')
                .setStyle(ButtonStyle.Primary)
                .setLabel('Przywołaj administratora')
            ),
          ],
        });
      } catch (error) {
        await channel.delete('Nie udało się skonfigurować ticketa').catch(() => {});
        throw error;
      }
      await ticketLog(guild, cfg, 'Ticket otwarty', [
        { name: 'Użytkownik', value: `<@${interaction.user.id}> (${interaction.user.id})` },
        { name: 'Temat', value: type.label },
        { name: 'Kanał', value: `${channel} (${channel.id})` },
      ]);
      return interaction.editReply(`Twój ticket jest gotowy: ${channel}`);
    }
    if (
      !['ticket-channel:close', 'ticket-channel:call'].includes(interaction.customId) ||
      !interaction.isButton()
    )
      return interaction.editReply('Nieznane działanie ticketa.');
    const channel = interaction.channel;
    const match = parseTicketTopic(channel?.topic);
    if (!match) return interaction.editReply('Ten ticket jest już zamknięty lub niedostępny.');
    const member = await guild.members.fetch(interaction.user.id);
    const staff =
      member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      (cfg.staffRoles || []).some((role) => member.roles.cache.has(role));
    if (match[1] !== interaction.user.id && !staff)
      return interaction.editReply('Tylko autor ticketa lub administracja mogą używać jego przycisków.');
    if (interaction.customId === 'ticket-channel:call') {
      const key = `${guild.id}:${channel.id}`;
      if ((callCooldowns.get(key) || 0) > Date.now())
        return interaction.editReply('Poczekaj 5 minut przed kolejnym przywołaniem.');
      const roles = [...new Set(cfg.pingRoles || [])]
        .filter((role) => role !== guild.id && guild.roles.cache.has(role))
        .slice(0, 20);
      if (!roles.length) return interaction.editReply('Administracja nie ustawiła ról do przywołania.');
      callCooldowns.set(key, Date.now() + 300000);
      try {
        await channel.send({
          content: `Przywołano: ${roles.map((role) => `<@&${role}>`).join(' ')}`,
          allowedMentions: { parse: [], roles },
        });
      } catch (error) {
        callCooldowns.delete(key);
        throw error;
      }
      for (const [id, expires] of callCooldowns) if (expires <= Date.now()) callCooldowns.delete(id);
      return interaction.editReply('Przywołano administrację.');
    }
    if (!cfg.ticketLogChannel || cfg.ticketLogChannel === channel.id)
      return interaction.editReply('Przed zamknięciem ustaw osobny kanał logów ticketów w panelu.');
    await channel.permissionOverwrites.edit(match[1], {
      SendMessages: false,
      AddReactions: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false,
    });
    await channel.setTopic(`sylo-ticket:${match[1]}:${match[2]}:closed`);
    await archiveChannelTicket(guild, channel, cfg, match[1], interaction.user.id);
    return interaction.editReply('Zapis rozmowy wysłano na kanał logów, a kanał ticketa usunięto.');
  } catch (error) {
    await interaction.editReply(
      'Działanie nie powiodło się. Poproś administrację o sprawdzenie uprawnień bota i ustawień kategorii.'
    );
    throw error;
  } finally {
    locks.delete(lock);
  }
}
registerComponent('tickets', 'ticket-channel:', handleChannelTicket);
