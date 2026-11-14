// The modules that "Undo this change" can restore (src/web/lib/configUndo.js): each one goes through the same
// normaliser as its save route, so what an undo saves is always a config the module would have saved.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CH, ROLE, fakeGuild } from './helpers/fakeGuild.js';
import { UNDOABLE, namesFor, restoreModule, targetOf, undoRefusal } from '../src/web/lib/configUndo.js';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import { getAuditEntry, listAuditPage, recordAudit } from '../src/db/audit.js';
import { runWithCapture } from '../src/db/auditCapture.js';
import { getModule } from '../src/modules/registry.js';
import { LOG_EVENTS } from '../src/modules/logging.js';
import { undoState, undoTarget } from '../src/lib/configSnapshot.js';

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
    await restoreModule(guild, id, undoTarget(current, entry.change));
    assert.deepEqual((await getGuildModule(G, id)).config, earlier);
    assert.equal(undoState((await getGuildModule(G, id)).config, entry.change), 'reverted');
  });
}

test('an undo cannot save past a limit: the normaliser clamps what is restored', async () => {
  // an old entry holds a list longer than today's limit: the module's normaliser cuts it, as a save would
  const long = Array.from({ length: 500 }, (_, i) => `1000000000000${String(i).padStart(5, '0')}`);
  const { config } = await restoreModule(guild, 'afk', {
    setNickname: true,
    mentionReply: true,
    ignoreChannels: long,
  });
  assert.ok(config.ignoreChannels.length < long.length);
  assert.deepEqual((await getGuildModule(G, 'afk')).config, config);
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
