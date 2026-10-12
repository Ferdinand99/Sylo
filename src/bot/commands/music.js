// /music — play direct audio links and radio stations in a voice channel.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  InteractionContextType,
  PermissionFlagsBits,
} from 'discord.js';
import { isModuleEnabled, getGuildModule } from '../../db/modules.js';
import {
  MusicError,
  normaliseMusic,
  parseAudioUrl,
  assertPublicHost,
  cleanTitle,
  titleFromUrl,
  getOrCreateSession,
  getSession,
  formatDuration,
} from '../../modules/music.js';

const COOLDOWN_MS = 3000;
const lastUse = new Map();

export const data = new SlashCommandBuilder()
  .setName('music')
  .setDescription('Play audio links and radio streams in a voice channel.')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('play')
      .setDescription('Play or queue a direct audio link (MP3, OGG, radio stream).')
      .addStringOption((o) =>
        o
          .setName('url')
          .setDescription('Direct http(s) link to an audio file or stream')
          .setRequired(true)
          .setMaxLength(500)
      )
      .addStringOption((o) =>
        o.setName('title').setDescription('Optional title shown in the queue').setMaxLength(80)
      )
  )
  .addSubcommand((s) =>
    s
      .setName('radio')
      .setDescription('Play a radio station saved by the server admins.')
      .addStringOption((o) =>
        o.setName('station').setDescription('Station name (leave empty to list stations)').setMaxLength(80)
      )
  )
  .addSubcommand((s) => s.setName('queue').setDescription('Show the music queue.'))
  .addSubcommand((s) => s.setName('nowplaying').setDescription('Show what is playing now.'))
  .addSubcommand((s) => s.setName('skip').setDescription('Skip the current track.'))
  .addSubcommand((s) => s.setName('pause').setDescription('Pause playback.'))
  .addSubcommand((s) => s.setName('resume').setDescription('Resume playback.'))
  .addSubcommand((s) => s.setName('stop').setDescription('Stop playback, clear the queue and leave.'));

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });
const safe = (text) => String(text).replace(/[`*_~|<>@]/g, '');

async function respond(interaction, payload) {
  const { flags, ...rest } = payload;
  if (interaction.deferred || interaction.replied)
    return interaction.editReply({ ...rest, flags: undefined });
  return interaction.reply({ ...rest, flags });
}

function canControl(interaction, config) {
  if (!config.djRoleId) return true;
  return Boolean(
    interaction.member?.roles?.cache?.has(config.djRoleId) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  );
}

function memberChannel(interaction) {
  return interaction.member?.voice?.channelId ?? null;
}

function embedQueue(session) {
  const embed = new EmbedBuilder().setTitle('🎶 Kolejka').setColor(0x5865f2);
  const now = session.current;
  embed.addFields({
    name: 'Teraz gra',
    value: now ? `**${safe(now.title || '…')}**\nDodał(a) <@${now.requestedBy}>` : 'Nic nie gra.',
  });
  if (session.queue.length) {
    const shown = session.queue
      .slice(0, 10)
      .map((t, i) => `${i + 1}. ${safe(t.title || t.url)} — <@${t.requestedBy}>`);
    const more = session.queue.length - shown.length;
    embed.addFields({
      name: `Następne (${session.queue.length})`,
      value: shown.join('\n') + (more > 0 ? `\n… i ${more} więcej` : ''),
    });
  }
  return embed;
}

async function enqueue(interaction, config, rawUrl, rawTitle) {
  const channelId = memberChannel(interaction);
  if (!channelId) throw new MusicError('Najpierw dołącz do kanału głosowego.');
  if (!canControl(interaction, config)) throw new MusicError('Do używania muzyki wymagana jest rola DJ-a.');
  const existing = getSession(interaction.guildId);
  if (existing && existing.channelId !== channelId)
    throw new MusicError('Bot gra już na innym kanale głosowym.', 409);
  const wait = COOLDOWN_MS - (Date.now() - (lastUse.get(interaction.user.id) ?? 0));
  if (wait > 0) throw new MusicError('Zwolnij — odczekaj chwilę przed kolejnym utworem.', 429);
  lastUse.set(interaction.user.id, Date.now());

  const url = parseAudioUrl(rawUrl);
  await interaction.deferReply();
  await assertPublicHost(url);
  const session = await getOrCreateSession(interaction.guild, channelId, config);
  session.updateLimits(config);
  session.textChannel = interaction.channel;
  const track = {
    url: url.href,
    title: rawTitle ? cleanTitle(rawTitle) : '',
    requestedBy: interaction.user.id,
  };
  const position = session.enqueue(track);
  const label = safe(track.title || titleFromUrl(url));
  return respond(interaction, {
    content: position === 0 ? `▶️ Ładuję **${label}**…` : `➕ Dodano do kolejki (#${position}): **${label}**`,
    allowedMentions: { parse: [] },
  });
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (!(await isModuleEnabled(interaction.guildId, 'music'))) {
    return interaction.reply(ephemeral('Moduł Muzyka nie jest włączony na tym serwerze.'));
  }
  const config = normaliseMusic((await getGuildModule(interaction.guildId, 'music')).config);
  const sub = interaction.options.getSubcommand();
  try {
    if (sub === 'play') {
      if (!config.allowUrls)
        throw new MusicError('Odtwarzanie z własnych linków jest wyłączone — użyj /music radio.');
      return await enqueue(
        interaction,
        config,
        interaction.options.getString('url', true),
        interaction.options.getString('title')
      );
    }
    if (sub === 'radio') {
      const wanted = interaction.options.getString('station')?.trim().toLowerCase();
      if (!wanted) {
        const list = config.stations.map((s) => `• ${safe(s.name)}`).join('\n');
        return await interaction.reply(
          ephemeral(list ? `Dostępne stacje:\n${list}` : 'Administratorzy nie dodali jeszcze żadnych stacji.')
        );
      }
      const matches = config.stations.filter((s) => s.name.toLowerCase().includes(wanted));
      const station = matches.find((s) => s.name.toLowerCase() === wanted) ?? matches[0];
      if (!station)
        throw new MusicError(
          'Nie znaleziono takiej stacji. Użyj /music radio bez nazwy, aby zobaczyć listę.'
        );
      return await enqueue(interaction, config, station.url, station.name);
    }

    const session = getSession(interaction.guildId);
    if (sub === 'queue' || sub === 'nowplaying') {
      if (!session || (!session.current && !session.queue.length))
        return await interaction.reply(ephemeral('Kolejka jest pusta.'));
      if (sub === 'queue')
        return await interaction.reply({ embeds: [embedQueue(session)], allowedMentions: { parse: [] } });
      const now = session.current;
      return await interaction.reply({
        content: `🎵 **${safe(now?.title || '…')}** — ${formatDuration(session.elapsedMs())}`,
        allowedMentions: { parse: [] },
      });
    }

    // skip / pause / resume / stop
    if (!session) throw new MusicError('Nic teraz nie gra.');
    if (memberChannel(interaction) !== session.channelId)
      throw new MusicError('Musisz być na tym samym kanale głosowym co bot.');
    if (!canControl(interaction, config))
      throw new MusicError('Do sterowania muzyką wymagana jest rola DJ-a.');
    if (sub === 'skip') {
      const skipped = session.skip();
      return await interaction.reply(
        skipped ? `⏭️ Pominięto **${safe(skipped.title || 'utwór')}**.` : ephemeral('Nic nie gra.')
      );
    }
    if (sub === 'pause')
      return await interaction.reply(
        session.pause() ? '⏸️ Wstrzymano.' : ephemeral('Nic nie da się teraz wstrzymać.')
      );
    if (sub === 'resume')
      return await interaction.reply(
        session.resume() ? '▶️ Wznowiono.' : ephemeral('Odtwarzanie nie jest wstrzymane.')
      );
    if (sub === 'stop') {
      session.destroy();
      return await interaction.reply('⏹️ Zatrzymano i opuszczono kanał.');
    }
  } catch (error) {
    if (!(error instanceof MusicError)) throw error;
    return respond(interaction, ephemeral(`⚠️ ${error.message}`));
  }
}
