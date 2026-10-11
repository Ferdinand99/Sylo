import test from 'node:test';
import assert from 'node:assert/strict';
import { startWebApp } from './helpers/webApp.js';
import { GID } from './helpers/fakeGuild.js';

test('settings exposes export/import and the JSON file can be restored on the same server', async () => {
  const app = await startWebApp();
  try {
    const settings = await (await fetch(`${app.base}/guilds/${GID}/settings`)).text();
    assert.match(settings, /Eksportuj konfigurację/);
    assert.match(settings, /data-config-import/);
    const response = await fetch(`${app.base}/guilds/${GID}/export`);
    assert.match(response.headers.get('content-disposition'), /attachment/);
    const backup = await response.json();
    const restored = await fetch(`${app.base}/guilds/${GID}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backup }),
    });
    assert.equal(restored.status, 200);
    assert.match((await restored.json()).message, /Przywrócono konfigurację/);
    const denied = await fetch(`${app.base}/guilds/${GID}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backup: { ...backup, guildId: '123456789012345678' } }),
    });
    assert.equal(denied.status, 400);
  } finally {
    app.close();
  }
});
