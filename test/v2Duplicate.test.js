// "Duplicate" for reminders, embed messages, reaction-role sets, custom commands and shop items
// (routes/v2Duplicate.js): the copy is made server-side, never starts anything on its own, and respects
// the limits of creating one by hand.
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID, CH, ROLE } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import { getComposed, listComposed } from '../src/db/composedMessages.js';
import { createReminder, getScheduled, listScheduled } from '../src/db/scheduledMessages.js';
import { createItem, getItem, listItems } from '../src/db/economyShop.js';
import { normaliseItem } from '../src/modules/economy.js';
import { LIMITS } from '../src/lib/limits.js';
import { copyName, freeCopyName } from '../src/web/routes/v2Duplicate.js';

let app;
let api;
test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
});
test.after(() => app.close());

test('copyName cuts the original so the suffix always fits', () => {
  assert.equal(copyName('Daily', 100), 'Daily (copy)');
  const long = copyName('x'.repeat(200), 100);
  assert.equal(long.length, 100);
  assert.ok(long.endsWith(' (copy)'));
  assert.equal(
    freeCopyName('hello', () => false),
    'hello-copy'
  );
  assert.equal(
    freeCopyName('hello', (n) => n === 'hello-copy'),
    'hello-copy2'
  );
  assert.equal(
    freeCopyName('hello', (n) => n === 'hello-copy' || n === 'hello-copy2'),
    'hello-copy3'
  );
  const cut = freeCopyName('y'.repeat(60), () => false);
  assert.ok(cut.endsWith('-copy') && cut.length <= 32);
});

test('a reminder is copied paused, with its schedule and message, and the original is untouched', async () => {
  const made = await (
    await api.post('/modules/reminders/new', {
      name: 'Standup',
      channelId: CH.general,
      content: 'Time for standup',
      intervalMinutes: 120,
      days: [1, 2, 3],
    })
  ).json();
  const id = made.reminder.id;
  const res = await api.post(`/modules/reminders/${id}/duplicate`);
  assert.equal(res.status, 200);
  const { id: copyId, name } = await res.json();
  assert.equal(name, 'Standup (copy)');
  const copy = await getScheduled(GID, copyId);
  assert.equal(copy.enabled, 0, 'the copy is paused');
  assert.equal(copy.spec.content, 'Time for standup');
  assert.equal(copy.interval_minutes, 120);
  assert.deepEqual(copy.dayList, [1, 2, 3]);
  assert.equal(copy.channel_id, CH.general);
  assert.equal((await getScheduled(GID, id)).enabled, 1, 'the original keeps running');
  assert.match((await auditRows(GID, 'module:reminders'))[0].detail, /duplicated "Standup" \(paused\)/);
  assert.equal((await api.post('/modules/reminders/999999/duplicate')).status, 404);
});

test('a reminder copy is refused at the ceiling, like creating one', async () => {
  const have = (await listScheduled(GID)).length;
  const { id } = (
    await (
      await api.post('/modules/reminders/new', { name: 'Seed', channelId: CH.general, content: 'x' })
    ).json()
  ).reminder;
  const spec = { content: 'x', embeds: [] };
  for (let i = have + 1; i < LIMITS.reminders; i += 1) {
    await createReminder(GID, {
      name: `fill ${i}`,
      channelId: CH.general,
      spec,
      mode: 'multiple',
      intervalMinutes: 60,
    });
  }
  const over = await api.post(`/modules/reminders/${id}/duplicate`);
  assert.equal(over.status, 400);
  assert.match((await over.json()).error, /maximum of 50 reminders/);
});

test('a published embed message is copied as a draft and nothing is posted', async () => {
  const saved = await (
    await api.post('/messages/new', {
      name: 'Rules',
      channelId: CH.general,
      action: 'publish',
      spec: { content: 'Be kind', embeds: [{ kind: 'embed', title: 'Rules', description: 'one' }], rows: [] },
    })
  ).json();
  assert.ok(saved.rec.messageId, 'the original is published');
  const posted = app.sink.messages.length;
  const res = await api.post(`/messages/${saved.rec.id}/duplicate`);
  assert.equal(res.status, 200);
  const { id, name } = await res.json();
  assert.equal(name, 'Rules (copy)');
  const copy = await getComposed(GID, id);
  assert.equal(copy.message_id, null, 'a draft');
  assert.equal(copy.channel_id, CH.general);
  assert.equal(copy.spec.content, 'Be kind');
  assert.equal(copy.spec.embeds[0].title, 'Rules');
  assert.equal(app.sink.messages.length, posted, 'nothing was posted');
  assert.equal((await getComposed(GID, saved.rec.id)).message_id, saved.rec.messageId);
  assert.equal((await api.post('/messages/999999/duplicate')).status, 404);
  assert.equal((await api.post('/messages/abc/duplicate')).status, 400);
  assert.ok((await listComposed(GID, 200)).length >= 2);
});

test('a reaction-role set is copied as a draft with the same roles and nothing is posted', async () => {
  const made = await (
    await api.post('/modules/roles/rr', {
      channelId: CH.general,
      style: 'reaction',
      pairs: [{ emoji: '👍', roleId: ROLE.member }],
    })
  ).json();
  // The fake channel cannot take the post, so mark the original as published by hand.
  const stored = (await getGuildModule(GID, 'roles')).config;
  const posted0 = stored.reactionMessages.map((x) =>
    x.id === made.reactionMessage.id ? { ...x, messageId: '555555555555555555' } : x
  );
  await setGuildModule(GID, 'roles', { config: { ...stored, reactionMessages: posted0 } });
  const original = posted0.find((x) => x.id === made.reactionMessage.id);
  assert.ok(original.messageId, 'the original is published');
  const posted = app.sink.messages.length;
  const res = await api.post(`/modules/roles/rr/${original.id}/duplicate`);
  assert.equal(res.status, 200);
  const { id } = await res.json();
  assert.notEqual(id, original.id);
  const list = (await getGuildModule(GID, 'roles')).config.reactionMessages;
  const copy = list.find((x) => x.id === id);
  assert.equal(copy.messageId, '', 'a draft');
  assert.equal(copy.channelId, CH.general);
  assert.deepEqual(copy.pairs, original.pairs);
  assert.equal(list.find((x) => x.id === original.id).messageId, original.messageId);
  assert.equal(app.sink.messages.length, posted, 'nothing was posted');
  assert.equal((await api.post('/modules/roles/rr/nope/duplicate')).status, 404);
});

test('a reaction-role copy is refused at the ceiling', async () => {
  const cfg = (await getGuildModule(GID, 'roles')).config;
  const one = cfg.reactionMessages[0];
  const filler = Array.from({ length: 50 }, (_, i) => ({ ...one, id: String(1000 + i) }));
  await setGuildModule(GID, 'roles', { config: { ...cfg, reactionMessages: filler } });
  const res = await api.post('/modules/roles/rr/1000/duplicate');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /maximum of 50 reaction-role messages/);
  assert.equal((await getGuildModule(GID, 'roles')).config.reactionMessages.length, 50);
});

test('a custom command is copied with a free "-copy" name, and the name stays unique', async () => {
  const made = await api.post('/modules/custom-commands/cmd', {
    name: 'hello',
    actions: [{ type: 'reply', content: 'hi there' }],
  });
  assert.equal(made.status, 200);
  const { command } = await made.json();
  const first = await (await api.post(`/modules/custom-commands/cmd/${command.id}/duplicate`)).json();
  assert.equal(first.name, 'hello-copy');
  const second = await (await api.post(`/modules/custom-commands/cmd/${command.id}/duplicate`)).json();
  assert.equal(second.name, 'hello-copy2');
  const { commands } = (await getGuildModule(GID, 'custom-commands')).config;
  const names = commands.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, 'names are unique');
  assert.ok(commands.find((c) => c.id === first.id).actions[0].messages[0].content === 'hi there');
  assert.notEqual(first.id, command.id);
  assert.match(
    (await auditRows(GID, 'module:custom-commands'))[0].detail,
    /duplicated \/hello as \/hello-copy2/
  );
  assert.equal((await api.post('/modules/custom-commands/cmd/12345/duplicate')).status, 404);
});

test('a shop item is copied paused, with its settings, a zero sold count and no picture', async () => {
  await setGuildModule(GID, 'economy', { enabled: true, config: {} });
  const made = await (
    await api.post('/modules/economy/shop/items', {
      name: 'Golden ticket',
      price: 250,
      type: 'custom',
      stock: 10,
      perMemberLimit: 2,
    })
  ).json();
  const res = await api.post(`/modules/economy/shop/items/${made.id}/duplicate`);
  assert.equal(res.status, 200);
  const copyBody = await res.json();
  assert.equal(copyBody.name, 'Golden ticket (copy)');
  assert.equal(copyBody.pictureCopied, false);
  const copy = await getItem(GID, copyBody.id);
  assert.equal(copy.enabled, false, 'paused');
  assert.equal(copy.price, 250);
  assert.equal(copy.stock, 10);
  assert.equal(copy.perMemberLimit, 2);
  assert.equal(copy.sold, 0);
  assert.equal(copy.imageId, null);
  assert.equal((await getItem(GID, made.id)).enabled, true, 'the original is still on sale');
  assert.equal((await api.post('/modules/economy/shop/items/999999/duplicate')).status, 404);
  assert.ok((await listItems(GID)).length >= 2);
});

test('a shop copy is refused at the ceiling', async () => {
  const items = await listItems(GID);
  const src = items[0];
  for (let i = items.length; i < LIMITS.shopItems; i += 1) {
    await createItem(GID, normaliseItem({ name: `fill ${i}`, price: 1, type: 'custom' }));
  }
  const over = await api.post(`/modules/economy/shop/items/${src.id}/duplicate`);
  assert.equal(over.status, 400);
  assert.match((await over.json()).error, /maximum of 100 shop items/);
});
