// "Undo goes through the normal save path": the registry of undoable modules (src/web/lib/configUndo.js)
// mirrors each module's save route by hand, so this test runs the real route for every one of them and checks the
// registry agrees with it, so a route that gains a filter, a bot-managed field or another step shows up here.
//
//  1. What the route stored goes through the registry's normalise step unchanged (so the registry reproduces
//     every filter and every field the route keeps).
//  2. For a route that takes the stored shape as its body (all but a few that translate a form first), the
//     registry's normalise step given the same body and the same saved config gives what the route stored.
//  3. Every after-save step of the registry is a call the route makes too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { D_GUILD, startOAuthApp } from './helpers/oauthApp.js';
import { adminApi } from './helpers/v2Admin.js';

await startOAuthApp();

const { UNDOABLE } = await import('../src/web/lib/configUndo.js');
const { getGuildModule } = await import('../src/db/modules.js');
const { runtime } = await import('../src/runtime.js');
const { LOG_EVENTS } = await import('../src/modules/logging.js');

const CH = '100000000000000001';
const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);

// A body with something in it where a default would hide a difference. The rest post their defaults.
const BODIES = {
  afk: { setNickname: true, mentionReply: false, ignoreChannels: [CH] },
  logging: { channel: CH, events: { [LOG_EVENTS[0][0]]: true } },
  tickets: { greeting: 'Hello', staffRoles: [D_GUILD, '100000000000000700'], notifyChannel: CH },
  'free-games': { channelId: CH, roleId: '100000000000000700' },
  counting: { channelId: CH, react: false, allowSameUser: true },
  polls: { pollMessage: { title: 'A poll' }, voteRoleMode: 'deny', voteRoles: ['100000000000000700'] },
  rss: { feeds: [{ id: '0123abcd', type: 'url', ref: 'https://example.com/a.xml', channelId: CH }] },
  'auto-threads': {
    rules: [
      { channelId: CH, name: 'Thread' },
      { channelId: '100000000000000999', name: 'Nope' },
    ],
  },
  appeals: { questions: ['Why?'], reviewChannelId: CH, cooldownDays: 3 },
  giveaways: { ping: true, dmWinners: false },
};

// Routes that translate a form shape into the stored one before normalising: (2) does not apply to them.
const TRANSLATES = new Set(['auto-react', 'automod', 'welcome']);

const ROUTE = (id) => `/modules/${id}/config`;
const { api } = await adminApi();
const post = async (id, body) => {
  const res = await api(ROUTE(id), body);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

for (const id of Object.keys(UNDOABLE)) {
  test(`${id}: the registry agrees with the save route`, async () => {
    const body = BODIES[id] ?? UNDOABLE[id].normalise({}, { guild, prev: {} });
    const prev = (await getGuildModule(D_GUILD, id)).config ?? {};
    const res = await post(id, body);
    assert.equal(res.status, 200, `${id}: ${JSON.stringify(res.body)}`);
    const stored = (await getGuildModule(D_GUILD, id)).config;

    // (1) what the route stored is what the registry's step makes of it
    const again = await UNDOABLE[id].normalise(structuredClone(stored), { guild, prev: stored });
    assert.deepEqual(again, stored, `${id}: the registry changes what its route stored`);

    // (2) the same body, the same saved config: the same result
    if (!TRANSLATES.has(id)) {
      const mine = await UNDOABLE[id].normalise(structuredClone(body), { guild, prev });
      assert.deepEqual(mine, stored, `${id}: the registry and the route differ for the same input`);
    }
  });
}

test('every after-save step of the registry is something the route does too', () => {
  const routes = ['v2Api.js', 'v2Intro.js'].map((f) =>
    readFileSync(fileURLToPath(new URL(`../src/web/routes/${f}`, import.meta.url)), 'utf8')
  );
  const source = routes.join('\n');
  const calls = {
    automod: 'syncGuildAutomod',
    honeypot: 'ensureHoneypotMessages',
    'invite-tracker': 'primeInviteCache',
    rss: 'clearScope',
    verification: 'ensureVerifyMessage',
  };
  const withAfter = Object.keys(UNDOABLE).filter((id) => UNDOABLE[id].after);
  assert.deepEqual(withAfter.sort(), Object.keys(calls).sort(), 'a new after-save step needs its line here');
  for (const [id, call] of Object.entries(calls)) {
    assert.ok(source.includes(`${call}(`), `${id}: the route no longer calls ${call}`);
  }
});
