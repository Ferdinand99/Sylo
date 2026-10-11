import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { config } from '../src/config.js';
import {
  uploadSound,
  listSounds,
  deleteSound,
  playSound,
  soundboardStatus,
} from '../src/modules/soundboard.js';
const guildId = '920000000000000001',
  otherId = '920000000000000002';
const folder = join(dirname(config.databasePath), 'soundboard', guildId);
function audio(seconds) {
  const result = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      String(seconds),
      '-f',
      'wav',
      'pipe:1',
    ],
    { maxBuffer: 8 * 1024 * 1024 }
  );
  assert.equal(result.status, 0);
  return result.stdout;
}
let clip;
test('upload validates actual audio, converts to Opus and isolates guild libraries', async () => {
  clip = await uploadSound(guildId, '<b>Test</b>', 'test.wav', audio(0.25));
  assert.equal(clip.seconds, 0.3);
  assert.equal(clip.name, '<b>Test</b>');
  const output = await readFile(join(folder, `${clip.id}.ogg`));
  assert.equal(output.subarray(0, 4).toString(), 'OggS');
  assert.ok(output.includes(Buffer.from('OpusHead')));
  assert.deepEqual(await listSounds(otherId), []);
  assert.equal((await listSounds(guildId)).length, 1);
});
test('invalid and overlong uploads leave no temporary or indexed files', async () => {
  await assert.rejects(uploadSound(guildId, 'bad', 'bad.mp3', Buffer.from('not audio')), /odczytać/);
  await assert.rejects(uploadSound(guildId, 'long', 'long.wav', audio(31)), /30 sekund/);
  await assert.rejects(uploadSound(guildId, 'bad', 'bad.exe', audio(0.1)), /Wybierz/);
  await assert.rejects(uploadSound('../escape', 'bad', 'bad.wav', audio(0.1)), /serwer/);
  assert.deepEqual((await readdir(folder)).sort(), [`${clip.id}.ogg`, 'index.json'].sort());
});
test('quota is enforced and malformed clip ids cannot access files', async () => {
  const path = join(dirname(config.databasePath), 'soundboard', otherId);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'index.json'),
    JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: String(i) })))
  );
  await assert.rejects(uploadSound(otherId, 'extra', 'extra.wav', audio(0.1)), /200 klipów/);
  await assert.rejects(deleteSound(guildId, '../index.json'), /znaleziono/);
});
test('failed playback releases its reservation and cross-guild deletion is rejected', async () => {
  const guild = { id: guildId, channels: { fetch: async () => null }, members: { me: {} } };
  await assert.rejects(playSound(guild, clip.id, '920000000000000004'), /kanał głosowy/);
  assert.deepEqual(soundboardStatus(guildId), { playing: false });
  await assert.rejects(deleteSound(otherId, clip.id), /znaleziono/);
  await deleteSound(guildId, clip.id);
  assert.deepEqual(await listSounds(guildId), []);
  assert.deepEqual(await readdir(folder), ['index.json']);
});
test.after(async () => {
  await rm(join(dirname(config.databasePath), 'soundboard'), { recursive: true, force: true });
});
