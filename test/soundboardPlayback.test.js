import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ChannelType } from 'discord.js';
import { AudioPlayerStatus, VoiceConnectionStatus, StreamType } from '@discordjs/voice';
import { config } from '../src/config.js';
import { playSound, stopSound, soundboardStatus } from '../src/modules/soundboard.js';
const clipId = '11111111-1111-4111-8111-111111111111';
let count = 940000000000000001n;
async function environment(mode) {
  const guildId = String(count++),
    channelId = String(count++);
  const folder = join(dirname(config.databasePath), 'soundboard', guildId);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'index.json'), JSON.stringify([{ id: clipId, name: 'Test' }]));
  const connection = new EventEmitter();
  connection.state = { status: VoiceConnectionStatus.Ready };
  connection.subscribe = () => {};
  let destroyed = 0,
    options;
  connection.destroy = () => {
    destroyed++;
    connection.state.status = VoiceConnectionStatus.Destroyed;
  };
  const player = new EventEmitter();
  player.stop = () => player.emit(AudioPlayerStatus.Idle);
  let started;
  const playing = new Promise((resolve) => {
    started = resolve;
  });
  player.play = () => {
    started();
    if (mode === 'idle') setImmediate(() => player.emit(AudioPlayerStatus.Idle));
    if (mode === 'error') setImmediate(() => player.emit('error', new Error('decode')));
  };
  const voice = {
    getVoiceConnection: () => null,
    joinVoiceChannel: (value) => {
      options = value;
      return connection;
    },
    entersState: async () => {
      if (mode === 'joinError') throw new Error('timeout');
    },
    createAudioPlayer: () => player,
    createAudioResource: (path, value) => {
      assert.equal(value.inputType, StreamType.OggOpus);
      assert.equal(path, join(folder, `${clipId}.ogg`));
      return {};
    },
  };
  const guild = {
    id: guildId,
    members: { me: {} },
    voiceAdapterCreator: {},
    channels: {
      fetch: async () => ({
        type: ChannelType.GuildVoice,
        joinable: true,
        permissionsFor: () => ({ has: () => true }),
      }),
    },
  };
  return {
    guild,
    channelId,
    voice,
    playing,
    get destroyed() {
      return destroyed;
    },
    get options() {
      return options;
    },
  };
}
test('end of audio disconnects and keeps the bot deafened', async () => {
  const env = await environment('idle');
  await playSound(env.guild, clipId, env.channelId, env.voice);
  assert.equal(env.destroyed, 1);
  assert.equal(env.options.selfDeaf, true);
  assert.deepEqual(soundboardStatus(env.guild.id), { playing: false });
});
test('stop is idempotent and overlapping playback is refused', async () => {
  const env = await environment('wait');
  const job = playSound(env.guild, clipId, env.channelId, env.voice);
  await env.playing;
  assert.equal(soundboardStatus(env.guild.id).playing, true);
  await assert.rejects(playSound(env.guild, clipId, env.channelId, env.voice), /już odtwarza/);
  stopSound(env.guild.id);
  stopSound(env.guild.id);
  await job;
  assert.equal(env.destroyed, 1);
  assert.deepEqual(soundboardStatus(env.guild.id), { playing: false });
});
test('join and player errors both destroy the voice connection', async () => {
  for (const mode of ['joinError', 'error']) {
    const env = await environment(mode);
    await assert.rejects(playSound(env.guild, clipId, env.channelId, env.voice), /Nie udało/);
    assert.equal(env.destroyed, 1);
    assert.deepEqual(soundboardStatus(env.guild.id), { playing: false });
  }
});
test.after(async () => {
  await rm(join(dirname(config.databasePath), 'soundboard'), { recursive: true, force: true });
});
