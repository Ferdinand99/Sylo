import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWebApp, post } from './helpers/webApp.js';
import { GID, CH } from './helpers/fakeGuild.js';
import { listComposed } from '../src/db/composedMessages.js';

const path = `/guilds/${GID}/messages/send`;
test('one-off editor is a separate page without draft controls', async () => {
  const app = await startWebApp();
  try {
    const response = await fetch(app.base + path);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Wyślij wiadomość/);
    assert.match(html, /name="channelId"/);
    assert.match(html, /embedList/);
    assert.doesNotMatch(html, /Save draft|name="name"/);
    assert.match(html, new RegExp(`action="${path}"`));
  } finally {
    app.close();
  }
});
test('text and embeds send to the chosen channel without saving a composition', async () => {
  const app = await startWebApp();
  try {
    const before = await listComposed(GID);
    const response = await post(app.base, path, {
      channelId: CH.general,
      spec: JSON.stringify({
        content: 'wiadomość jednorazowa',
        embeds: [{ title: 'Ogłoszenie', description: 'Treść osadzona' }],
      }),
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), `${path}?sent=1&channelId=${CH.general}`);
    assert.equal(app.sink.messages.length, 1);
    assert.equal(app.sink.messages[0].channel, CH.general);
    assert.equal(app.sink.messages[0].payload.content, 'wiadomość jednorazowa');
    assert.equal(app.sink.messages[0].payload.embeds[0].toJSON().title, 'Ogłoszenie');
    assert.deepEqual(await listComposed(GID), before);
    const fresh = await (await fetch(app.base + response.headers.get('location'))).text();
    assert.match(fresh, /Wiadomość wysłana/);
    assert.match(fresh, new RegExp(`value="${CH.general}" selected`));
    assert.doesNotMatch(fresh, /wiadomość jednorazowa/);
  } finally {
    app.close();
  }
});
test('invalid destinations and empty messages are rejected without sends or drafts', async () => {
  const app = await startWebApp();
  try {
    const before = await listComposed(GID);
    for (const body of [
      { channelId: '111111111111111111', spec: JSON.stringify({ content: 'test' }) },
      { channelId: CH.general, spec: '{}' },
      { channelId: CH.voice, spec: JSON.stringify({ content: 'test' }) },
    ])
      assert.equal((await post(app.base, path, body)).status, 400);
    assert.equal(app.sink.messages.length, 0);
    assert.deepEqual(await listComposed(GID), before);
  } finally {
    app.close();
  }
});
test('failed Discord delivery preserves the unsent editor content', async () => {
  const app = await startWebApp();
  try {
    app.guild.channels.cache.get(CH.general).send = async () => {
      throw new Error('Missing Access');
    };
    const response = await post(app.base, path, {
      channelId: CH.general,
      spec: JSON.stringify({ content: 'zachowaj tekst' }),
    });
    assert.equal(response.status, 400);
    const html = await response.text();
    assert.match(html, /zachowaj tekst/);
    assert.match(html, /Nie udało się wysłać wiadomości/);
    assert.equal(app.sink.messages.length, 0);
  } finally {
    app.close();
  }
});
