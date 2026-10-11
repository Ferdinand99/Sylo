// Local, per-guild sound library. Decode once on upload, stream Opus on playback.
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  getVoiceConnection,
} from '@discordjs/voice';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_CLIPS = 200;
export const MAX_SECONDS = 30;
const PCM_RATE = 48000 * 2 * 2;
const locks = new Map();
const sessions = new Map();
const heldConnections = new Map();
const lastPlay = new Map();
let converting = false;

export class SoundboardError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const root = () => resolve(dirname(config.databasePath), 'soundboard');
function directory(guildId) {
  if (!/^\d{17,20}$/.test(guildId)) throw new SoundboardError('Nieprawidłowy serwer.');
  return join(root(), guildId);
}
function clipFile(guildId, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new SoundboardError('Nieprawidłowy klip.');
  return join(directory(guildId), `${id}.ogg`);
}
async function serial(guildId, job) {
  const previous = locks.get(guildId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(job);
  locks.set(guildId, current);
  try {
    return await current;
  } finally {
    if (locks.get(guildId) === current) locks.delete(guildId);
  }
}
export async function listSounds(guildId) {
  try {
    return JSON.parse(await readFile(join(directory(guildId), 'index.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
async function saveIndex(guildId, clips) {
  const dir = directory(guildId);
  const tmp = join(dir, `${randomUUID()}.json.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(clips), { mode: 0o600, flag: 'wx' });
    await rename(tmp, join(dir, 'index.json'));
  } finally {
    await rm(tmp, { force: true });
  }
}

// No shell, no remote protocols, bounded decoding time and output size.
function runFFmpeg(args, input = null, maxOutput = 0) {
  return new Promise((resolveJob, reject) => {
    const executable =
      process.env.FFMPEG_PATH || (ffmpegStatic && existsSync(ffmpegStatic) ? ffmpegStatic : 'ffmpeg');
    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = [];
    let bytes = 0;
    let failure;
    const timer = setTimeout(() => {
      failure = new SoundboardError('Konwersja trwała zbyt długo.');
      child.kill('SIGKILL');
    }, 20000);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutput) {
        failure = new SoundboardError('Klip może mieć maksymalnie 30 sekund.');
        child.kill('SIGKILL');
      } else output.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      reject(new SoundboardError('Brak działającego FFmpeg. Sprawdź instalację lub FFMPEG_PATH.', 503));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new SoundboardError('Nie można odczytać pliku dźwiękowego.'));
      else resolveJob(Buffer.concat(output));
    });
    child.stdin.end(input);
  });
}

export async function uploadSound(guildId, name, originalName, bytes) {
  name = String(name || '')
    .trim()
    .slice(0, 80);
  if (!name) throw new SoundboardError('Nadaj nazwę klipowi.');
  if (!/\.(mp3|wav|ogg|opus|m4a|aac|flac|webm)$/i.test(originalName || ''))
    throw new SoundboardError('Wybierz MP3, WAV, OGG, Opus, M4A, AAC, FLAC lub WebM.');
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_UPLOAD_BYTES)
    throw new SoundboardError('Plik musi mieć od 1 bajta do 8 MB.');
  if (converting) throw new SoundboardError('Trwa konwersja innego klipu. Spróbuj za chwilę.', 409);
  converting = true;
  try {
    return await serial(guildId, async () => {
      const clips = await listSounds(guildId);
      if (clips.length >= MAX_CLIPS)
        throw new SoundboardError(`Limit ${MAX_CLIPS} klipów na serwer został osiągnięty.`);
      const dir = directory(guildId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const id = randomUUID(),
        source = join(dir, `${id}.upload`),
        dest = clipFile(guildId, id);
      try {
        await writeFile(source, bytes, { flag: 'wx', mode: 0o600 });
        const pcm = await runFFmpeg(
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-threads',
            '1',
            '-protocol_whitelist',
            'file,pipe',
            '-format_whitelist',
            'mp3,wav,ogg,mov,aac,flac,matroska,webm',
            '-i',
            source,
            '-map',
            '0:a:0',
            '-vn',
            '-t',
            '31',
            '-ar',
            '48000',
            '-ac',
            '2',
            '-f',
            's16le',
            'pipe:1',
          ],
          null,
          MAX_SECONDS * PCM_RATE
        );
        if (!pcm.length) throw new SoundboardError('Plik nie zawiera dźwięku.');
        await runFFmpeg(
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-threads',
            '1',
            '-f',
            's16le',
            '-ar',
            '48000',
            '-ac',
            '2',
            '-i',
            'pipe:0',
            '-map_metadata',
            '-1',
            '-c:a',
            'libopus',
            '-b:a',
            '96k',
            '-threads',
            '1',
            '-f',
            'ogg',
            dest,
          ],
          pcm
        );
        const clip = {
          id,
          name,
          seconds: Math.round((pcm.length / PCM_RATE) * 10) / 10,
          bytes: (await stat(dest)).size,
        };
        await saveIndex(guildId, [...clips, clip]);
        return clip;
      } catch (error) {
        await rm(dest, { force: true });
        throw error;
      } finally {
        await rm(source, { force: true });
      }
    });
  } finally {
    converting = false;
  }
}
export async function deleteSound(guildId, id) {
  return serial(guildId, async () => {
    if (sessions.get(guildId)?.clipId === id)
      throw new SoundboardError('Najpierw zatrzymaj odtwarzanie klipu.', 409);
    const clips = await listSounds(guildId);
    if (!clips.some((clip) => clip.id === id)) throw new SoundboardError('Nie znaleziono klipu.', 404);
    await saveIndex(
      guildId,
      clips.filter((clip) => clip.id !== id)
    );
    await rm(clipFile(guildId, id), { force: true });
  });
}
export function soundboardStatus(guildId) {
  const active = sessions.get(guildId);
  const held = heldConnections.get(guildId);
  if (active)
    return {
      playing: true,
      name: active.name,
      channelId: active.channelId,
      connected: active.connection?.state.status === VoiceConnectionStatus.Ready,
    };
  if (held)
    return {
      playing: false,
      connected: held.connection?.state.status === VoiceConnectionStatus.Ready,
      joining: !held.connection,
      channelId: held.channelId,
    };
  return { playing: false };
}
function releaseHeld(guildId) {
  const held = heldConnections.get(guildId);
  if (!held) return;
  held.cancelled = true;
  heldConnections.delete(guildId);
  if (held.connection?.state.status !== VoiceConnectionStatus.Destroyed) held.connection?.destroy();
}
export function stopSound(guildId) {
  sessions.get(guildId)?.stop();
  releaseHeld(guildId);
}

const voiceApi = {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
};
function atConnectionLimit(guildId) {
  const guilds = new Set([...sessions.keys(), ...heldConnections.keys()]);
  return !guilds.has(guildId) && guilds.size >= 3;
}
async function checkVoiceChannel(guild, channelId) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (
    channel?.type !== ChannelType.GuildVoice ||
    !channel
      .permissionsFor(me)
      ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])
  )
    throw new SoundboardError('Wybierz kanał głosowy, na którym bot może się połączyć i mówić.');
  if (!channel.joinable && guild.members.me?.voice?.channelId !== channelId)
    throw new SoundboardError('Kanał jest pełny lub niedostępny dla bota.');
}
async function connectHeld(guild, channelId, voice) {
  const existing = heldConnections.get(guild.id);
  if (existing) {
    if (existing.channelId !== channelId)
      throw new SoundboardError('Bot pozostaje na innym kanale. Najpierw kliknij „Rozłącz”.', 409);
    if (!existing.connection || existing.connection.state.status !== VoiceConnectionStatus.Ready)
      throw new SoundboardError('Bot jeszcze się łączy. Spróbuj za chwilę.', 409);
    return existing.connection;
  }
  if (voice.getVoiceConnection(guild.id))
    throw new SoundboardError('Bot ma już inne połączenie głosowe.', 409);
  if (atConnectionLimit(guild.id))
    throw new SoundboardError('Bot jest już połączony na trzech serwerach.', 409);
  const held = { channelId, cancelled: false };
  heldConnections.set(guild.id, held);
  try {
    await checkVoiceChannel(guild, channelId);
    if (held.cancelled) throw new SoundboardError('Dołączanie zostało anulowane.');
    held.connection = voice.joinVoiceChannel({
      channelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    const drop = () => {
      if (heldConnections.get(guild.id) === held) releaseHeld(guild.id);
    };
    held.connection.on('error', drop);
    held.connection.on(VoiceConnectionStatus.Disconnected, drop);
    held.connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (heldConnections.get(guild.id) === held) heldConnections.delete(guild.id);
    });
    await voice.entersState(held.connection, VoiceConnectionStatus.Ready, 15000);
    if (held.cancelled) throw new SoundboardError('Dołączanie zostało anulowane.');
    return held.connection;
  } catch (error) {
    if (heldConnections.get(guild.id) === held) releaseHeld(guild.id);
    if (error instanceof SoundboardError) throw error;
    throw new SoundboardError('Nie udało się dołączyć do kanału głosowego.', 503);
  }
}
export async function joinSoundboard(guild, channelId, voice = voiceApi) {
  if (sessions.has(guild.id)) throw new SoundboardError('Najpierw zatrzymaj odtwarzanie klipu.', 409);
  await connectHeld(guild, channelId, voice);
}
export async function playSound(guild, id, channelId, voice = voiceApi, keepConnected = false) {
  if (sessions.has(guild.id)) throw new SoundboardError('Bot już odtwarza klip na tym serwerze.', 409);
  if (atConnectionLimit(guild.id))
    throw new SoundboardError('Bot odtwarza już na trzech serwerach. Spróbuj za chwilę.', 409);
  if (Date.now() - (lastPlay.get(guild.id) ?? 0) < 2000)
    throw new SoundboardError('Odczekaj 2 sekundy między klipami.', 429);
  if (voice.getVoiceConnection(guild.id) && !heldConnections.has(guild.id))
    throw new SoundboardError('Bot ma już inne połączenie głosowe.', 409);
  const session = {
    clipId: id,
    channelId,
    name: '',
    stopped: false,
    failed: false,
    stop: () => {
      session.stopped = true;
      session.player?.stop(true);
      if (session.connection?.state.status !== VoiceConnectionStatus.Destroyed) session.connection?.destroy();
    },
  };
  sessions.set(guild.id, session);
  lastPlay.set(guild.id, Date.now());
  try {
    const clip = (await listSounds(guild.id)).find((item) => item.id === id);
    if (!clip) throw new SoundboardError('Nie znaleziono klipu.', 404);
    session.name = clip.name;
    await checkVoiceChannel(guild, channelId);
    if (session.stopped) return;
    const held = heldConnections.get(guild.id);
    if (held && held.channelId !== channelId)
      throw new SoundboardError('Bot pozostaje na innym kanale. Najpierw kliknij „Rozłącz”.', 409);
    const connection =
      held || keepConnected
        ? await connectHeld(guild, channelId, voice)
        : voice.joinVoiceChannel({
            channelId,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: true,
            selfMute: false,
          });
    session.connection = connection;
    const onConnectionError = () => {
      session.failed = true;
    };
    session.onConnectionError = onConnectionError;
    connection.on('error', onConnectionError);
    await voice.entersState(connection, VoiceConnectionStatus.Ready, 15000);
    if (session.stopped) return;
    const player = voice.createAudioPlayer();
    session.player = player;
    connection.subscribe(player);
    const resource = voice.createAudioResource(clipFile(guild.id, id), { inputType: StreamType.OggOpus });
    await new Promise((done, reject) => {
      let settled = false;
      const onIdle = () => finish();
      const onDisconnected = () => finish(new SoundboardError('Połączenie głosowe zostało przerwane.'));
      const onDestroyed = () => finish(new SoundboardError('Bot został rozłączony.'));
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        player.off('error', finish);
        player.off(AudioPlayerStatus.Idle, onIdle);
        connection.off('error', finish);
        connection.off(VoiceConnectionStatus.Disconnected, onDisconnected);
        connection.off(VoiceConnectionStatus.Destroyed, onDestroyed);
        if (error) reject(error);
        else done();
      };
      const timer = setTimeout(() => finish(new SoundboardError('Przekroczono czas odtwarzania.')), 35000);
      player.once('error', finish);
      player.once(AudioPlayerStatus.Idle, onIdle);
      connection.once('error', finish);
      connection.once(VoiceConnectionStatus.Disconnected, onDisconnected);
      connection.once(VoiceConnectionStatus.Destroyed, onDestroyed);
      try {
        player.play(resource);
      } catch (error) {
        finish(error);
      }
    });
  } catch (error) {
    session.failed = true;
    if (!session.stopped) {
      if (error instanceof SoundboardError) throw error;
      throw new SoundboardError(
        'Nie udało się odtworzyć klipu. Sprawdź uprawnienia i połączenie UDP bota.',
        503
      );
    }
  } finally {
    session.player?.stop(true);
    if (session.onConnectionError) session.connection?.off('error', session.onConnectionError);
    if (session.stopped || session.failed) releaseHeld(guild.id);
    if (
      !heldConnections.has(guild.id) &&
      session.connection?.state.status !== VoiceConnectionStatus.Destroyed
    )
      session.connection?.destroy();
    sessions.delete(guild.id);
  }
}
