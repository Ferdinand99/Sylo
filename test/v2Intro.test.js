// The Introductions page of the new dashboard: settings, and publishing the pinned prompt message
// with its button, through /api/v2 with the stored config and audit rows asserted. Who may call these
// routes is in v2.permissions*.test.js (helpers/v2Guarded.js lists them).
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID, CH, ROLE } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule } from '../src/db/modules.js';

let app;
let api;
const posted = new Map(); // message id -> the fake message of #general
let nextId = 800000000000000001n;
let failMessageCalls = false; // edit and delete by id fail with a server error

test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
  // #general keeps what is sent to it, with the message methods the prompt uses.
  for (const channel of [app.guild.channels.cache.get(CH.general), app.guild.channels.cache.get(CH.bots)]) {
    channel.send = async (payload) => {
      const message = {
        id: String(nextId++),
        payload,
        pinned: false,
        edits: 0,
        edit: async (next) => {
          message.payload = next;
          message.edits += 1;
        },
        delete: async () => posted.delete(message.id),
        pin: async () => {
          message.pinned = true;
        },
      };
      posted.set(message.id, message);
      return message;
    };
    channel.messages = {
      edit: async (id, payload) => {
        if (failMessageCalls) throw Object.assign(new Error('Internal Server Error'), { status: 500 });
        if (!posted.has(id)) throw Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
        await posted.get(id).edit(payload);
      },
      delete: async (id) => {
        if (failMessageCalls) throw Object.assign(new Error('Internal Server Error'), { status: 500 });
        if (!posted.has(id)) throw Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
        await posted.get(id).delete();
      },
      fetch: async (id) => {
        if (!posted.has(id)) throw new Error('Unknown Message');
        return posted.get(id);
      },
    };
  }
});
test.after(() => app.close());

const json = async (res) => res.json();

test('GET config: the default questions, the channel and role lists, the placeholders', async () => {
  const res = await api.get('/modules/introductions/config');
  assert.equal(res.status, 200);
  const data = await json(res);
  assert.deepEqual(
    data.config.questions.map((q) => q.label),
    ['About me', 'Likes', 'Dislikes', 'Pronouns', 'DMs']
  );
  assert.equal(data.config.channelId, '');
  assert.equal(data.config.deleteOnLeave, true);
  assert.deepEqual(data.config.roleGroups, []);
  assert.ok(data.channels.some((c) => c.id === CH.general));
  assert.ok(data.roles.some((r) => r.id === ROLE.member));
  assert.ok(!data.roles.some((r) => r.id === ROLE.bot), 'a managed role is not offered');
  assert.deepEqual(data.placeholders, ['{user}', '{user.name}', '{server}', '{rolegroup:<name>}']);
  assert.equal(data.introductions, 0);
});

test('POST config stores the cleaned settings and writes an audit row', async () => {
  const res = await api.post('/modules/introductions/config', {
    channelId: CH.general,
    questions: [
      { id: 'about', label: 'About me', prompt: 'Tell us.', required: true, maxLength: 99999, inline: false },
      { label: '   ' },
    ],
    roleGroups: [{ name: 'Country', roleIds: [ROLE.member, 'junk'], hideWhenEmpty: true }],
    showRoles: true,
    colorMode: 'role',
    color: 'zzz',
    description: 'Hi {user}',
    footer: 'Bye',
    deleteOnLeave: false,
    promptChannelId: CH.bots, // the server's to set, not the form's
    promptMessageId: '800000000000009999',
  });
  assert.equal(res.status, 200);
  const { config } = await json(res);
  assert.equal(config.channelId, CH.general);
  assert.equal(config.questions.length, 1);
  assert.equal(config.questions[0].maxLength, 1024, 'clamped');
  assert.deepEqual(config.roleGroups, [{ name: 'Country', roleIds: [ROLE.member], hideWhenEmpty: true }]);
  assert.equal(config.colorMode, 'role');
  assert.equal(config.color, '');
  assert.equal(config.deleteOnLeave, false);
  assert.equal(config.promptChannelId, '');
  assert.equal(config.promptMessageId, '');
  assert.deepEqual((await getGuildModule(GID, 'introductions')).config, config);
  assert.deepEqual((await json(await api.get('/modules/introductions/config'))).config, config);
  const audit = await auditRows(GID, 'module:introductions');
  assert.equal(audit[0].detail, 'settings saved');
  assert.equal(audit[0].actor, 'Dashboard');
});

test('publishing the prompt needs a channel', async () => {
  await api.post('/modules/introductions/config', { questions: [] });
  const res = await api.post('/modules/introductions/prompt/publish', {});
  assert.equal(res.status, 400);
  assert.match((await json(res)).error, /Pick the introductions channel/);
});

test('publishing posts a pinned message with the Create my intro button, and publishing again edits it', async () => {
  const res = await api.post('/modules/introductions/prompt/publish', {
    channelId: CH.general,
    promptText: 'Say hi!',
  });
  assert.equal(res.status, 200);
  const { config } = await json(res);
  assert.equal(config.promptChannelId, CH.general);
  assert.match(config.promptMessageId, /^\d{18}$/);
  assert.equal(config.channelId, CH.general, 'the channel of the draft is saved with it');
  assert.equal(config.promptText, 'Say hi!');

  const message = posted.get(config.promptMessageId);
  assert.equal(message.payload.content, 'Say hi!');
  const button = message.payload.components[0].toJSON().components[0];
  assert.equal(button.custom_id, 'intro:create');
  assert.equal(button.label, 'Create my intro');
  assert.deepEqual(message.payload.allowedMentions, { parse: [] });
  assert.equal(message.pinned, true, 'pinned');
  assert.equal((await auditRows(GID, 'module:introductions'))[0].detail, 'published the prompt message');

  const again = await json(
    await api.post('/modules/introductions/prompt/publish', { channelId: CH.general, promptText: 'New text' })
  );
  assert.equal(again.config.promptMessageId, config.promptMessageId, 'the same message');
  assert.equal(posted.size, 1, 'nothing new was posted');
  assert.equal(message.edits, 1);
  assert.equal(message.payload.content, 'New text');
});

test('saving the settings keeps track of the published prompt', async () => {
  const before = (await getGuildModule(GID, 'introductions')).config;
  assert.ok(before.promptMessageId);
  const { config } = await json(await api.post('/modules/introductions/config', { channelId: CH.general }));
  assert.equal(config.promptMessageId, before.promptMessageId);
  assert.equal(config.promptChannelId, before.promptChannelId);
});

test('removing the prompt deletes the message and forgets it', async () => {
  const { promptMessageId } = (await getGuildModule(GID, 'introductions')).config;
  const res = await api.post('/modules/introductions/prompt/unpublish');
  assert.equal(res.status, 200);
  const { config } = await json(res);
  assert.equal(config.promptMessageId, '');
  assert.equal(config.promptChannelId, '');
  assert.equal(posted.has(promptMessageId), false, 'the message is gone');
  assert.equal((await auditRows(GID, 'module:introductions'))[0].detail, 'removed the prompt message');
  assert.equal(
    (await api.post('/modules/introductions/prompt/unpublish')).status,
    200,
    'again: nothing to remove'
  );
});

test('the module can be switched on and off like any other', async () => {
  const on = await api.post('/modules/introductions', { enabled: true });
  assert.equal(on.status, 200);
  assert.equal((await getGuildModule(GID, 'introductions')).enabled, true);
});

test('publishing the prompt to another channel deletes the old prompt', async () => {
  const first = await json(
    await api.post('/modules/introductions/prompt/publish', { channelId: CH.general, promptText: 'Hi' })
  );
  const oldId = first.config.promptMessageId;
  assert.ok(posted.has(oldId));
  const moved = await json(
    await api.post('/modules/introductions/prompt/publish', { channelId: CH.bots, promptText: 'Hi' })
  );
  assert.equal(moved.config.promptChannelId, CH.bots);
  assert.notEqual(moved.config.promptMessageId, oldId);
  assert.equal(posted.has(oldId), false, 'the old prompt and its button are gone');
  assert.equal(posted.has(moved.config.promptMessageId), true);
  assert.equal(posted.size, 1);
  await api.post('/modules/introductions/prompt/unpublish');
  assert.equal(posted.size, 0);
});

test('a failing delete keeps the stored prompt id and says so; a failing move leaves a warning', async () => {
  const first = await json(
    await api.post('/modules/introductions/prompt/publish', { channelId: CH.general, promptText: 'Hi' })
  );
  const id = first.config.promptMessageId;
  failMessageCalls = true;
  const refused = await api.post('/modules/introductions/prompt/unpublish');
  assert.equal(refused.status, 502);
  assert.match((await json(refused)).error, /could not delete the prompt message/);
  assert.equal((await getGuildModule(GID, 'introductions')).config.promptMessageId, id, 'the id is kept');
  assert.equal(posted.has(id), true);

  const moved = await json(
    await api.post('/modules/introductions/prompt/publish', { channelId: CH.bots, promptText: 'Hi' })
  );
  assert.match(moved.warning, /old one was not removed/);
  assert.equal(posted.size, 2, 'the old one is still there, and the user was told');
  failMessageCalls = false;
  // a prompt that is gone is not an error
  posted.delete(moved.config.promptMessageId);
  assert.equal((await api.post('/modules/introductions/prompt/unpublish')).status, 200);
  posted.clear();
});

test('switching the module off from the dashboard ends the running questionnaires of that server', async () => {
  const { startQuestionnaire, hasActiveQuestionnaire, _resetQuestionnaires } =
    await import('../src/bot/lib/dmQuestionnaire.js');
  const dms = [];
  const user = { id: '700000000000000070', send: async (payload) => dms.push(payload) };
  await startQuestionnaire({
    user,
    questions: [{ id: 'a', label: 'A', required: true, maxLength: 10 }],
    scope: `introductions:${GID}`,
    onComplete: async () => {},
  });
  assert.equal(hasActiveQuestionnaire('discord', user.id), true);
  assert.equal((await api.post('/modules/introductions', { enabled: false })).status, 200);
  assert.equal(hasActiveQuestionnaire('discord', user.id), false);
  assert.match(dms.at(-1).content, /questionnaire was stopped/);

  await startQuestionnaire({
    user,
    questions: [{ id: 'a', label: 'A', required: true, maxLength: 10 }],
    scope: `introductions:${GID}`,
    onComplete: async () => {},
  });
  await api.post('/modules/introductions', { enabled: true });
  assert.equal(hasActiveQuestionnaire('discord', user.id), true, 'switching it on stops nothing');
  assert.equal((await api.post('/modules/bulk', { ids: ['introductions'], enabled: false })).status, 200);
  assert.equal(hasActiveQuestionnaire('discord', user.id), false, 'the bulk switch too');
  _resetQuestionnaires();
});
