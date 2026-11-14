// A feed URL can carry a token, so below Edit it is shown as its origin everywhere: the RSS page
// (already), the stored before/after copies of the change history, and the permission health report
// (which names a feed by its name or host, because that report is cached and shared by every level).
import './helpers/trustLoopbackProxy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { setDashboardAccessRoles } = await import('../src/db/guildSettings.js');
const { recordAudit } = await import('../src/db/audit.js');
const { NEEDS } = await import('../src/web/lib/permissionHealth.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const VIEW = '700000000000000951';
const SECRET_URL = 'https://feeds.example.com/private/u7Hq2pXk9Lm3/episodes.rss?p=fd83k2';

async function person({ view }) {
  setProfiles();
  if (view) profiles.discord.guilds = [{ id: D_GUILD, owner: false, permissions: '0' }];
  const b = browser();
  await signIn(b, 'discord');
  const id = profiles.discord.id;
  const cache = new Map(view ? [[VIEW, { id: VIEW }]] : []);
  cache.hasAny = (...ids) => ids.some((r) => cache.has(r));
  cache.some = (fn) => [...cache.values()].some(fn);
  guild.members.cache.set(id, { id, permissions: { has: () => false }, roles: { highest: { position: 1 }, cache } });
  return (path) => b.get(`/api/v2/guilds/${D_GUILD}${path}`, { headers: { accept: 'application/json' } });
}

let entryId;
test.before(async () => {
  await setDashboardAccessRoles(D_GUILD, { inbox: [], view: [VIEW] });
  await recordAudit(D_GUILD, {
    actor: 'Ann',
    action: 'module:rss',
    detail: 'settings saved',
    change: {
      before: { feeds: [] },
      after: { feeds: [{ id: 'a1', type: 'url', ref: SECRET_URL, url: SECRET_URL, channelId: '1', roleId: '', template: '' }] },
    },
  });
  const { listAuditPage } = await import('../src/db/audit.js');
  entryId = (await listAuditPage(D_GUILD, { limit: 5 })).rows.find((r) => r.action === 'module:rss').id;
});
test.afterEach(() => guild.members.cache.clear());

test('the change history shows a View user only the origin of a feed', async () => {
  const get = await person({ view: true });
  const res = await get(`/audit/${entryId}/change`);
  assert.equal(res.status, 200);
  const text = JSON.stringify(await res.json());
  assert.ok(!text.includes('u7Hq2pXk9Lm3'), 'no path');
  assert.ok(!text.includes('fd83k2'), 'no query');
  assert.ok(text.includes('https://feeds.example.com/…'), 'the origin is kept');
});

test('an Edit user still sees the whole feed address in the change history', async () => {
  const get = await person({ view: false });
  const text = JSON.stringify(await (await get(`/audit/${entryId}/change`)).json());
  assert.ok(text.includes('u7Hq2pXk9Lm3'));
});

test('the permission health report names a feed by its host, never its address', () => {
  const needs = NEEDS.rss({
    feeds: [{ url: `${SECRET_URL}`, type: 'url', ref: SECRET_URL, channelId: '100000000000000001', roleId: '100000000000000002' }],
  });
  const text = JSON.stringify(needs);
  assert.ok(text.includes('feeds.example.com'));
  assert.ok(!text.includes('u7Hq2pXk9Lm3') && !text.includes('fd83k2'));
  const named = JSON.stringify(NEEDS.rss({ feeds: [{ name: 'Podcast', url: SECRET_URL, channelId: '100000000000000001' }] }));
  assert.ok(named.includes('Podcast') && !named.includes('fd83k2'));
});
