// /event create|list|cancel — schedule events with Join / Maybe / Leave sign-ups. Staff only:
// Manage Events (or Manage Server) or one of the staff roles set on the Events page. The code
// checks that itself, so the command is visible to everyone and works the same on Fluxer
// (`!event create title:"Game night" start:"2026-11-05 19:00"`).
import {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
  EmbedBuilder,
  ChannelType,
} from 'discord.js';
import { getGuildModule } from '../../db/modules.js';
import { eventStatusCount, upcomingEvents } from '../../db/events.js';
import { LimitError } from '../../lib/limits.js';
import {
  LIMITS,
  canManageEvents,
  cancelEvent,
  createEvent,
  normaliseEventsConfig,
  parseEventInput,
} from '../../modules/events.js';
import { grantRefusal } from '../../web/middleware/roleGrants.js';

const LIST_SHOWN = 20;

export const data = new SlashCommandBuilder()
  .setName('event')
  .setDescription('Schedule events with Join / Maybe / Leave sign-ups.')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('create')
      .setDescription('Post a new event.')
      .addStringOption((o) =>
        o
          .setName('title')
          .setDescription('Name of the event')
          .setRequired(true)
          .setMaxLength(LIMITS.title.maxLength)
      )
      .addStringOption((o) =>
        o
          .setName('start')
          .setDescription('Start time as YYYY-MM-DD HH:mm, e.g. 2026-11-05 19:00 (see the timezone option)')
          .setRequired(true)
      )
      .addStringOption((o) => o.setName('end').setDescription('End time, same format (optional)'))
      .addStringOption((o) =>
        o
          .setName('timezone')
          .setDescription(
            'Time zone the times are written in, e.g. Europe/Oslo (default: the server setting, else UTC)'
          )
      )
      .addStringOption((o) =>
        o
          .setName('description')
          .setDescription('What the event is about')
          .setMaxLength(LIMITS.description.maxLength)
      )
      .addStringOption((o) =>
        o.setName('location').setDescription('Where it happens').setMaxLength(LIMITS.location.maxLength)
      )
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Where to post it (default: the Events page setting, else this channel)')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
      .addIntegerOption((o) =>
        o
          .setName('capacity')
          .setDescription('Most people who can press Join (default: no limit)')
          .setMinValue(LIMITS.capacity.min)
          .setMaxValue(LIMITS.capacity.max)
      )
      .addRoleOption((o) =>
        o.setName('role').setDescription('Role given to people who join, removed when the event is over')
      )
      .addIntegerOption((o) =>
        o
          .setName('reminder')
          .setDescription(
            'Minutes before the start to remind everyone, 0 = none (default: the Events page setting)'
          )
          .setMinValue(0)
          .setMaxValue(LIMITS.reminderMinutes.max)
      )
      .addStringOption((o) =>
        o
          .setName('image')
          .setDescription('https link to a picture for the event')
          .setMaxLength(LIMITS.imageUrl.maxLength)
      )
  )
  .addSubcommand((s) => s.setName('list').setDescription('List the upcoming events in this server.'))
  .addSubcommand((s) =>
    s
      .setName('cancel')
      .setDescription('Cancel an upcoming event.')
      .addIntegerOption((o) => o.setName('id').setDescription('Event id (see /event list)').setRequired(true))
  );

const eph = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

async function create(interaction, cfg) {
  const o = interaction.options;
  const parsed = parseEventInput(
    {
      title: o.getString('title', true),
      start: o.getString('start', true),
      end: o.getString('end'),
      timeZone: o.getString('timezone'),
      description: o.getString('description'),
      location: o.getString('location'),
      imageUrl: o.getString('image'),
      capacity: o.getInteger('capacity'),
      reminderMinutes: o.getInteger('reminder'),
    },
    { defaults: { timeZone: cfg.timeZone, reminderMinutes: cfg.reminderMinutes } }
  );
  if (!parsed.ok) return eph(interaction, parsed.error);

  const role = o.getRole('role');
  if (role) {
    const why = grantRefusal(interaction.guild, interaction.member, role);
    if (why) return eph(interaction, why);
  }
  const channelId = o.getChannel('channel')?.id ?? (cfg.channel || interaction.channelId);

  let result;
  try {
    result = await createEvent({
      guild: interaction.guild,
      hostId: interaction.user.id,
      channelId,
      roleId: role?.id ?? null,
      input: parsed.value,
    });
  } catch (err) {
    if (err instanceof LimitError) return eph(interaction, err.message);
    throw err;
  }
  if (!result.ok) return eph(interaction, result.error);
  return eph(
    interaction,
    `Event **#${result.id}** is up in <#${channelId}>, starting <t:${Math.floor(parsed.value.startAt / 1000)}:f>.`
  );
}

async function list(interaction) {
  const events = await upcomingEvents(interaction.guildId);
  if (!events.length) return eph(interaction, 'No upcoming events. Make one with `/event create`.');
  const lines = [];
  for (const ev of events.slice(0, LIST_SHOWN)) {
    const going = await eventStatusCount(ev.id, 'join');
    const maybe = await eventStatusCount(ev.id, 'maybe');
    lines.push(
      `**#${ev.id}** · ${ev.title} — <t:${Math.floor(ev.start_at / 1000)}:f> · ✅ ${going}${ev.capacity ? `/${ev.capacity}` : ''} · ❔ ${maybe} · <#${ev.channel_id}>`
    );
  }
  if (events.length > LIST_SHOWN) lines.push(`…and ${events.length - LIST_SHOWN} more on the dashboard.`);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Upcoming events')
    .setDescription(lines.join('\n'));
  return interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const mod = await getGuildModule(interaction.guildId, 'events');
  if (!mod.enabled) return eph(interaction, 'The Events module is not enabled in this server.');
  const cfg = normaliseEventsConfig(mod.config);
  if (!canManageEvents(interaction.member, interaction.memberPermissions, cfg)) {
    return eph(
      interaction,
      'Only staff can manage events: you need the Manage Events permission or one of the staff roles set on the Events page.'
    );
  }

  const sub = interaction.options.getSubcommand();
  if (sub === 'create') return create(interaction, cfg);
  if (sub === 'list') return list(interaction);

  const id = interaction.options.getInteger('id', true);
  const result = await cancelEvent(id, interaction.guildId);
  return eph(interaction, result.ok ? `Event **#${id}** is cancelled.` : result.error);
}
