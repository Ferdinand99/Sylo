import { startWebApp } from './helpers/webApp.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
let app;
test.before(async () => {
  app = await startWebApp();
});
test.after(() => app.close());
test('soundboard is linked in V1 and offers voice channels only', async () => {
  app.guild.channels.cache.set('930000000000000001', {
    id: '930000000000000001',
    name: 'Test VC',
    type: ChannelType.GuildVoice,
    rawPosition: 1,
  });
  const res = await fetch(`${app.base}/guilds/${app.guild.id}/soundboard`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Dźwięki na VC/);
  assert.match(html, /Test VC/);
  assert.match(html, /id="sb-upload"/);
  assert.match(html, /Dołącz i zostań/);
  assert.match(html, /id="sb-stay"/);
});
test('cross-origin uploads are blocked before decoding and bad audio is rejected', async () => {
  const url = `${app.base}/guilds/${app.guild.id}/soundboard/upload?name=Test&filename=test.mp3`;
  const blocked = await fetch(url, {
    method: 'POST',
    headers: { origin: 'https://attacker.invalid', 'content-type': 'application/octet-stream' },
    body: 'bad',
  });
  assert.equal(blocked.status, 403);
  const invalid = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: 'bad',
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /odczytać/);
});
test('unknown guilds and missing channel selections cannot start playback', async () => {
  assert.equal((await fetch(`${app.base}/guilds/930000000000000099/soundboard`)).status, 404);
  const res = await fetch(`${app.base}/guilds/${app.guild.id}/soundboard/nope/play`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Wybierz kanał głosowy.' });
  const join = await fetch(`${app.base}/guilds/${app.guild.id}/soundboard/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(join.status, 400);
});
