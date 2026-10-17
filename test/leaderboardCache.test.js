// The public leaderboard needs no login, and each view used to look up the page's members on
// Discord (a gateway request, plus a REST call per member who left). A short cache keeps an
// anonymous visitor from spending the bot's Discord budget by reloading.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startWebApp } from './helpers/webApp.js';
import { setGuildModule } from '../src/db/modules.js';
import { addXp } from '../src/db/leveling.js';

test('reloading the leaderboard does not look the members up again', async () => {
  const app = await startWebApp();
  try {
    await setGuildModule(app.guild.id, 'leveling', { enabled: true, config: {} });
    await addXp(app.guild.id, '900000000000004321', 50);
    app.guild.client ??= { users: { fetch: async () => null } };
    let lookups = 0;
    const inner = app.guild.members.fetch;
    app.guild.members.fetch = async (arg) => {
      if (typeof arg === 'object') lookups += 1;
      return typeof arg === 'object' ? new Map() : inner(arg);
    };
    for (let i = 0; i < 3; i++) {
      assert.equal((await fetch(`${app.base}/leaderboard/${app.guild.id}`)).status, 200);
    }
    assert.equal(lookups, 1);
  } finally {
    app.close();
  }
});
