import { startWebApp, post } from './helpers/webApp.js';
import { GID, CH, ROLE } from './helpers/fakeGuild.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule } from '../src/db/modules.js';

test('V1 ticket topics save, render and publish a dropdown panel', async () => {
  const app = await startWebApp();
  try {
    const body = {
      dmCategory: CH.category,
      panelChannel: CH.general,
      ticketLogChannel: CH.bots,
      ticketLabel: 'Technical support',
      ticketDescription: 'Get help',
      ticketCategory: CH.category,
      staffRoles: ROLE.member,
      action: 'publish',
    };
    const response = await post(app.base, `/guilds/${GID}/m/tickets/config`, body);
    assert.equal(response.status, 302);
    const { config } = await getGuildModule(GID, 'tickets');
    assert.equal(config.ticketTypes[0].categoryId, CH.category);
    assert.ok(config.panelMessageId);
    assert.equal(config.ticketLogChannel, CH.bots);
    assert.equal(config.dmCategory, CH.category);
    const page = await fetch(`${app.base}/guilds/${GID}/m/tickets?lang=en`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Technical support/);
    assert.match(html, /Add topic/);
    assert.match(html, /Save and publish panel/);
  } finally {
    app.close();
  }
});

test('V2 ticket configuration preserves dropdown topics and category choices', async () => {
  const app = await startWebApp();
  try {
    const response = await fetch(`${app.base}/api/v2/guilds/${GID}/modules/tickets/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dmCategory: CH.category,
        panelChannel: CH.general,
        ticketLogChannel: CH.bots,
        ticketTypes: [{ id: 'appeal', label: 'Appeal', categoryId: CH.category }],
      }),
    });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.config.ticketTypes[0].id, 'appeal');
    const page = await fetch(`${app.base}/api/v2/guilds/${GID}/modules/tickets/config`);
    assert.equal(page.status, 200);
    const data = await page.json();
    assert.equal(data.config.ticketTypes[0].categoryId, CH.category);
    assert.ok(data.categories.some((category) => category.id === CH.category));
  } finally {
    app.close();
  }
});

test('server emoji picker fetches current emojis rather than a stale cache', async () => {
  const app = await startWebApp();
  try {
    let fetched = false;
    app.guild.emojis.fetch = async () => {
      fetched = true;
      return new Map([
        [
          'emoji',
          {
            name: 'kripus',
            toString: () => '<:kripus:100000000000009999>',
            imageURL: () => 'https://cdn.discordapp.com/emojis/100000000000009999.png',
          },
        ],
      ]);
    };
    const response = await fetch(`${app.base}/guilds/${GID}/emojis`);
    assert.equal(response.status, 200);
    assert.equal(fetched, true);
    assert.equal((await response.json()).custom[0].name, 'kripus');
  } finally {
    app.close();
  }
});
