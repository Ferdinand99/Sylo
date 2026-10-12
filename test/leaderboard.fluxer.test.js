// The public leaderboard page accepts a Fluxer guild key ("fluxer:<id>").
import test from 'node:test';
import assert from 'node:assert/strict';
import { startWebApp } from './helpers/webApp.js';

test('/leaderboard/fluxer:<id> is a server lookup, not an "Unknown server" id error', async () => {
  const app = await startWebApp();
  try {
    const res = await fetch(`${app.base}/leaderboard/${encodeURIComponent('fluxer:900000000000000010')}`);
    const body = await res.text();
    assert.equal(res.status, 404);
    assert.match(body, /Sylo is not in that server/);
    assert.doesNotMatch(body, /Unknown server/);
  } finally {
    app.close();
  }
});
