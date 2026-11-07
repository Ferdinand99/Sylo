// Every reason there is no public leaderboard gives the same 404, byte for byte, so the page does
// not reveal which server ids Sylo is in or which of them use leveling. A server with leveling on
// and no setting for it still has a public leaderboard (the long-standing default).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startWebApp } from './helpers/webApp.js';
import { GID } from './helpers/fakeGuild.js';
import { setGuildModule } from '../src/db/modules.js';
import { setVanitySlug } from '../src/db/leaderboardVanity.js';

let app;
test.before(async () => {
  app = await startWebApp();
});
test.after(() => app.close());

const get = (path) => fetch(app.base + path);

test('all not-found variants answer with one identical 404', async () => {
  const answers = [];
  const record = async (path) => {
    const res = await get(path);
    answers.push({ path, status: res.status, body: await res.text() });
  };

  await record('/leaderboard/not-a-server'); // malformed id
  await record('/leaderboard/100000000000000999'); // a server Sylo is not in
  await record(`/leaderboard/${encodeURIComponent('fluxer:900000000000000010')}`);
  await record('/lb/nobody-uses-this'); // an unused vanity link
  await record(`/leaderboard/${GID}`); // Sylo is in it, leveling never enabled
  await setGuildModule(GID, 'leveling', { enabled: false, config: {} });
  await record(`/leaderboard/${GID}`); // leveling off
  await setGuildModule(GID, 'leveling', { enabled: true, config: { publicLeaderboard: false } });
  await record(`/leaderboard/${GID}`); // page switched off
  await setVanitySlug(GID, 'hidden-board');
  await record('/lb/hidden-board'); // vanity link of a server whose page is off

  for (const a of answers) assert.equal(a.status, 404, a.path);
  assert.match(answers[0].body, /There is no public leaderboard at this address/);
  assert.equal(new Set(answers.map((a) => a.body)).size, 1, 'one body for every reason');
});

test('leveling on with no setting for the page keeps the page public (the default)', async () => {
  await setGuildModule(GID, 'leveling', { enabled: true, config: {} });
  const res = await get(`/leaderboard/${GID}`);
  assert.equal(res.status, 200);
});
