// The modules that "Undo this change" can restore (src/web/lib/configUndo.js): each one goes through the same
// normaliser as its save route, so what an undo saves is always a config the module would have saved.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CH, ROLE, fakeGuild } from './helpers/fakeGuild.js';
import {
  UNDOABLE,
  UndoError,
  describeUndo,
  namesFor,
  targetOf,
  undoModule,
  undoRefusal,
  undoSettings,
} from '../src/web/lib/configUndo.js';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import { getAuditEntry, listAuditPage, recordAudit } from '../src/db/audit.js';
import { runWithCapture } from '../src/db/auditCapture.js';
import {
  getBotMasterRoles,
  getGuildSettings,
  setBotMasterRoles,
  setEmbedColor,
  setModlogChannel,
} from '../src/db/guildSettings.js';
import { getModule } from '../src/modules/registry.js';
import { LOG_EVENTS } from '../src/modules/logging.js';
import { MASK, undoState } from '../src/lib/configSnapshot.js';

const { guild } = fakeGuild();
const G = guild.id;

test('every undoable module is a real, ordinary module', () => {
  for (const id of Object.keys(UNDOABLE)) {
    const mod = getModule(id);
    assert.ok(mod, `${id} is a module`);
    assert.ok(!mod.ownerOnly, `${id} is not operator-only`);
    assert.equal(typeof UNDOABLE[id].normalise, 'function');
  }
});

test("saving a module's own config back through its normaliser changes nothing", async () => {
  for (const [id, entry] of Object.entries(UNDOABLE)) {
    const first = await entry.normalise({}, { guild, prev: {} });
    const again = await entry.normalise(structuredClone(first), { guild, prev: first });
    assert.deepEqual(again, first, `${id}: a saved config survives its own normaliser`);
  }
});

// Two different valid configs per module; an undo of the second save must give the first back exactly.
const PAIRS = {
  logging: [
    { channel: CH.general, events: {} },
    { channel: CH.bots, events: { [LOG_EVENTS[0][0]]: true } },
  ],
  'free-games': [
    { channelId: CH.general, roleId: '' },
    { channelId: CH.bots, roleId: ROLE.member },
  ],
  tickets: [
    { greeting: 'Hello there', staffRoles: [] },
    { greeting: 'Hi', staffRoles: [ROLE.member], closeMessage: 'Bye' },
  ],
  counting: [{ channelId: CH.general }, { channelId: CH.bots, react: false, allowSameUser: true }],
  polls: [
    { pollMessage: { title: 'First' } },
    { pollMessage: { title: 'Second' }, resultsMessage: { title: 'Done' } },
  ],
  afk: [
    { setNickname: true, mentionReply: true, ignoreChannels: [CH.general] },
    { setNickname: false, mentionReply: true, ignoreChannels: [] },
  ],
};

for (const [id, [a, b]] of Object.entries(PAIRS)) {
  test(`${id}: an undo gives the earlier saved config back, through the normaliser`, async () => {
    const earlier = await UNDOABLE[id].normalise(a, { guild, prev: {} });
    const later = await UNDOABLE[id].normalise(b, { guild, prev: earlier });
    await setGuildModule(G, id, { config: earlier });
    await runWithCapture(async () => {
      await setGuildModule(G, id, { config: later });
      await recordAudit(G, { actor: 'Ann', action: `module:${id}`, detail: 'settings saved' });
    });
    const row = (await listAuditPage(G, { limit: 1 })).rows[0];
    const entry = await getAuditEntry(G, row.id);
    assert.ok(entry.change.before, 'the save kept its change');

    const current = (await getGuildModule(G, id)).config;
    assert.equal(undoState(current, entry.change), 'clean');
    const info = await describeUndo(guild, { kind: 'module', id }, entry.change);
    assert.equal(info.available, true);
    await undoModule(guild, id, entry.change);
    assert.deepEqual((await getGuildModule(G, id)).config, earlier);
    assert.equal(undoState((await getGuildModule(G, id)).config, entry.change), 'reverted');
  });
}

test('an undo cannot save past a limit: the normaliser clamps what is restored, and says so', async () => {
  // an old entry holds a list longer than today's limit: the module's normaliser cuts it, as a save would
  const long = Array.from({ length: 500 }, (_, i) => `1000000000000${String(i).padStart(5, '0')}`);
  await setGuildModule(G, 'afk', { config: { setNickname: true, mentionReply: true, ignoreChannels: [] } });
  const change = { before: { ignoreChannels: long }, after: { ignoreChannels: [] } };
  const { adjusted } = await undoModule(guild, 'afk', change);
  const saved = (await getGuildModule(G, 'afk')).config;
  assert.ok(saved.ignoreChannels.length > 0 && saved.ignoreChannels.length < long.length);
  assert.deepEqual(adjusted, ['ignoreChannels']);
});

test('the settings an undo leaves alone are named, and an entry with nothing else in it has no undo', async () => {
  // Welcome: the switch goes with the auto-roles of the Roles page
  await setGuildModule(G, 'welcome', { config: { autoroleEnabled: true, joinEnabled: false } });
  const onlyBot = { before: { autoroleEnabled: false }, after: { autoroleEnabled: true } };
  const info = await describeUndo(guild, { kind: 'module', id: 'welcome' }, onlyBot);
  assert.equal(info.available, false);
  assert.match(info.reason, /Nothing in this change can be restored/);
  assert.deepEqual(
    info.notRestored.map((n) => n.key),
    ['autoroleEnabled']
  );
  await assert.rejects(
    undoModule(guild, 'welcome', onlyBot),
    (err) => err instanceof UndoError && err.status === 400
  );

  // with another setting in it, that one is restored and the switch stays
  const both = {
    before: { autoroleEnabled: false, joinEnabled: true, joinChannel: CH.general, joinMessage: 'Hi' },
    after: { autoroleEnabled: true, joinEnabled: false },
  };
  const res = await undoModule(guild, 'welcome', both);
  const saved = (await getGuildModule(G, 'welcome')).config;
  assert.equal(saved.autoroleEnabled, true, 'the switch stays as saved now');
  assert.equal(saved.joinEnabled, true);
  assert.deepEqual(
    res.notRestored.map((n) => n.key),
    ['autoroleEnabled']
  );
});

test('a change to only the message ids Sylo keeps has nothing to undo', async () => {
  await setGuildModule(G, 'introductions', {
    config: { promptChannelId: '', promptMessageId: '', channelId: CH.general },
  });
  const change = {
    before: { promptChannelId: CH.general, promptMessageId: '100000000000000999' },
    after: { promptChannelId: '', promptMessageId: '' },
  };
  const info = await describeUndo(guild, { kind: 'module', id: 'introductions' }, change);
  assert.equal(info.available, false);
  assert.deepEqual(info.notRestored.map((n) => n.key).sort(), ['promptChannelId', 'promptMessageId']);
});

test('an undo takes a masked secret from the same item by id, never from another place in the list', async () => {
  const url = (n) => `https://example.com/${n}.xml?token=secret-${n}`;
  const feed = (id, n, ch) => ({
    id,
    type: 'url',
    ref: url(n),
    url: url(n),
    channelId: ch,
    roleId: '',
    template: '',
  });
  await setGuildModule(G, 'rss', {
    config: { feeds: [feed('aaaaaaaa', 1, CH.general), feed('bbbbbbbb', 2, CH.bots)] },
  });
  // "before": the same two feeds in the other order, secrets masked; "after" is what is saved
  const masked = (id, ch) => ({
    id,
    type: 'url',
    ref: MASK,
    url: MASK,
    channelId: ch,
    roleId: '',
    template: '',
  });
  const change = {
    before: { feeds: [masked('bbbbbbbb', CH.general), masked('aaaaaaaa', CH.bots)] },
    after: { feeds: [masked('aaaaaaaa', CH.general), masked('bbbbbbbb', CH.bots)] },
  };
  await undoModule(guild, 'rss', change);
  const saved = (await getGuildModule(G, 'rss')).config.feeds;
  const byId = Object.fromEntries(saved.map((f) => [f.id, f]));
  assert.match(byId.aaaaaaaa.url, /secret-1/, 'a feed keeps its own secret');
  assert.match(byId.bbbbbbbb.url, /secret-2/);
  assert.equal(byId.bbbbbbbb.channelId, CH.general, 'the channels went back');

  // an item with no id has nothing to take its secret from: the secret is left out and reported
  await setGuildModule(G, 'twitch-alerts', { config: { alerts: [] } });
  const noId = {
    before: { alerts: [{ login: 'someone', channelId: CH.general, webhookUrl: MASK }] },
    after: { alerts: [] },
  };
  const info = await describeUndo(guild, { kind: 'module', id: 'twitch-alerts' }, noId);
  assert.deepEqual(info.droppedSecrets, ['alerts']);
  const res = await undoModule(guild, 'twitch-alerts', noId);
  assert.ok(res.adjusted.includes('alerts'));
  assert.doesNotMatch(JSON.stringify((await getGuildModule(G, 'twitch-alerts')).config), /••••••/);
});

test('two undos at once restore once: the second finds it already put back', async () => {
  await setGuildModule(G, 'afk', { config: { setNickname: true, mentionReply: true, ignoreChannels: [] } });
  const change = { before: { setNickname: false }, after: { setNickname: true } };
  const results = await Promise.allSettled([
    undoModule(guild, 'afk', change),
    undoModule(guild, 'afk', change),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  const refused = results.find((r) => r.status === 'rejected').reason;
  assert.equal(refused.status, 409);
});

test('settings changed again need the confirmation of what the page showed, not just a yes', async () => {
  await setGuildModule(G, 'afk', { config: { setNickname: false, mentionReply: true, ignoreChannels: [] } });
  // saved again after the entry below was written
  await setGuildModule(G, 'afk', {
    config: { setNickname: false, mentionReply: false, ignoreChannels: [CH.bots] },
  });
  const change2 = { before: { ignoreChannels: [] }, after: { ignoreChannels: [CH.general] } };
  const info = await describeUndo(guild, { kind: 'module', id: 'afk' }, change2);
  assert.equal(info.state, 'changed');
  assert.ok(info.token);
  await assert.rejects(
    undoModule(guild, 'afk', change2, { confirm: true }),
    (e) => e.extra.code === 'changed-since'
  );
  await assert.rejects(
    undoModule(guild, 'afk', change2, { confirm: true, token: 'not-the-token' }),
    (e) => e.status === 409 && e.extra.token === info.token
  );
  await undoModule(guild, 'afk', change2, { confirm: true, token: info.token });
  assert.deepEqual((await getGuildModule(G, 'afk')).config.ignoreChannels, []);
});

test('a settings undo validates every setting before it writes the first', async () => {
  const S = guild.id;
  await setBotMasterRoles(S, []);
  await setModlogChannel(S, null);
  await setEmbedColor(S, 0x445566);
  const GONE = '100000000000000555';
  const change = {
    before: { botMasterRoleIds: [ROLE.member], modlogChannelId: GONE, embedColor: '#112233' },
    after: { botMasterRoleIds: [], modlogChannelId: '', embedColor: '#445566' },
  };
  const info = await describeUndo(guild, { kind: 'settings' }, change);
  assert.equal(info.available, true);
  await assert.rejects(
    undoSettings({}, guild, change),
    (err) => err instanceof UndoError && /no longer exists/.test(err.message)
  );
  assert.deepEqual(await getBotMasterRoles(S), [], 'the bot master roles were not written before the check');
  assert.equal((await getGuildSettings(S)).embed_color, 0x445566);
  // without the channel it is restored, all of it
  const ok = {
    before: { botMasterRoleIds: [ROLE.member], embedColor: '#112233' },
    after: { botMasterRoleIds: [], embedColor: '#445566' },
  };
  await undoSettings({}, guild, ok);
  assert.deepEqual(await getBotMasterRoles(S), [ROLE.member]);
  assert.equal((await getGuildSettings(S)).embed_color, 0x112233);
});

test('which audit entries are about settings, and which modules have no undo', () => {
  assert.deepEqual(targetOf('settings:server'), { kind: 'settings' });
  assert.deepEqual(targetOf('module:afk'), { kind: 'module', id: 'afk' });
  assert.equal(targetOf('module:bulk'), null);
  assert.equal(targetOf('privacy:member-data'), null);
  assert.equal(undoRefusal({ kind: 'module', id: 'afk' }), null);
  assert.equal(undoRefusal({ kind: 'settings' }), null);
  assert.match(undoRefusal({ kind: 'module', id: 'roles' }), /cannot be undone/);
  assert.ok(undoRefusal(null));
});

test('channel and role ids in a change get their names, and nothing else does', () => {
  const names = namesFor(guild, {
    channelId: CH.general,
    list: [ROLE.member, '123456789012345678'],
    text: 'general',
  });
  assert.deepEqual(names, { [CH.general]: '#general', [ROLE.member]: '@Member' });
});
