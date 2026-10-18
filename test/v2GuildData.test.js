// The new dashboard's server-data tools (routes/v2GuildData.js): the audit log, the config
// export and member data. Same access and semantics as V1: server admins only, owner-only
// module config is left out of a non-operator's export, and forgetting a member needs an
// explicit confirm and keeps their moderation cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, OTHER_D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { recordAudit } = await import('../src/db/audit.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { addWarning } = await import('../src/db/modCases.js');
const { addXp } = await import('../src/db/leveling.js');
const { describeUserData } = await import('../src/db/purge.js');

const OPERATOR_ID = '111111111111111111'; // OWNER_IDS in helpers/oauthApp.js
const MEMBER = '800000000000000777';

/** Signed in as an admin of D_GUILD (not an operator unless `discordId` is one). */
async function session({ discordId } = {}) {
  setProfiles({ discordId });
  const b = browser();
  await signIn(b, 'discord');
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  const post = (path, body) =>
    b.get(path, {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { get: b.get, post };
}

const count = (data, key) => data.items.find((i) => i.key === key).count;

test('an admin gets the audit log, newest first', async () => {
  await recordAudit(D_GUILD, { actor: 'ferdi (dashboard)', action: 'settings:server', detail: 'saved' });
  const s = await session();
  const res = await s.get(`/api/v2/guilds/${D_GUILD}/audit`);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.kept, 500);
  const row = body.entries.find((e) => e.action === 'settings:server');
  assert.ok(row, 'the entry is listed');
  assert.equal(row.actor, 'ferdi (dashboard)');
  assert.equal(typeof row.at, 'number');
  assert.equal(typeof row.ago, 'string');
});

test('a member without Manage Server is refused all of it', async () => {
  const s = await session();
  for (const path of ['audit', 'export', 'member-data']) {
    const res = await s.get(`/api/v2/guilds/${OTHER_D_GUILD}/${path}`);
    assert.equal(res.status, 403, path);
  }
  const res = await s.post(`/api/v2/guilds/${OTHER_D_GUILD}/member-data/forget`, {
    userId: MEMBER,
    confirm: true,
  });
  assert.equal(res.status, 403);
});

test('the export is a JSON download without owner-only modules for a non-operator', async () => {
  await setGuildModule(D_GUILD, 'apple-connect', { enabled: true, config: { appId: 'secret-app' } });
  await setGuildModule(D_GUILD, 'welcome', { enabled: true, config: { message: 'hi' } });

  const admin = await session();
  const res = await admin.get(`/api/v2/guilds/${D_GUILD}/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="sylo-.*-config\.json"/);
  const data = await res.json();
  assert.equal(data.sylo, 'guild-config-export');
  const ids = data.modules.map((m) => m.moduleId);
  assert.ok(ids.includes('welcome'));
  assert.ok(!ids.includes('apple-connect'), 'owner-only module left out');
  assert.doesNotMatch(JSON.stringify(data), /secret-app/);

  const operator = await session({ discordId: OPERATOR_ID });
  const own = await (await operator.get(`/api/v2/guilds/${D_GUILD}/export`)).json();
  assert.ok(
    own.modules.some((m) => m.moduleId === 'apple-connect'),
    'an operator gets everything'
  );
});

test('the classic export leaves owner-only modules out for a non-operator too', async () => {
  await setGuildModule(D_GUILD, 'apple-connect', { enabled: true, config: { appId: 'secret-app' } });
  const admin = await session();
  const res = await admin.get(`/guilds/${D_GUILD}/export`);
  assert.equal(res.status, 200);
  assert.doesNotMatch(await res.text(), /secret-app/);
});

test('member data: lookup, bad id, and forget needs confirm', async () => {
  const s = await session();
  const empty = await (await s.get(`/api/v2/guilds/${D_GUILD}/member-data`)).json();
  assert.equal(empty.lookup, null);
  assert.match(empty.unaffected, /Moderation cases/);

  const bad = await s.get(`/api/v2/guilds/${D_GUILD}/member-data?user=nobody`);
  assert.equal(bad.status, 400);

  await addXp(D_GUILD, MEMBER, 50);
  const res = await s.get(`/api/v2/guilds/${D_GUILD}/member-data?user=<@${MEMBER}>`);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.lookup.profile.id, MEMBER);
  assert.equal(count(body.lookup.data, 'leveling'), 1);

  for (const confirm of [undefined, false, 'on', 'true']) {
    const r = await s.post(`/api/v2/guilds/${D_GUILD}/member-data/forget`, { userId: MEMBER, confirm });
    assert.equal(r.status, 400, `confirm=${confirm}`);
  }
  assert.equal(count(await describeUserData(D_GUILD, MEMBER), 'leveling'), 1, 'nothing was deleted');

  const noUser = await s.post(`/api/v2/guilds/${D_GUILD}/member-data/forget`, { userId: 'x', confirm: true });
  assert.equal(noUser.status, 400);
});

test('forgetting a member deletes their data but keeps moderation cases', async () => {
  await addXp(D_GUILD, MEMBER, 50);
  await addWarning({ guildId: D_GUILD, userId: MEMBER, moderatorId: '700000000000000001', reason: 'spam' });

  const s = await session();
  const res = await s.post(`/api/v2/guilds/${D_GUILD}/member-data/forget`, {
    userId: MEMBER,
    reason: 'At your request.',
    confirm: true,
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.result.leveling >= 1);
  assert.ok(body.result.keptCases >= 1);
  assert.equal(body.dmDelivered, false); // the fake platform can't fetch users

  const after = await describeUserData(D_GUILD, MEMBER);
  assert.equal(count(after, 'leveling'), 0);
  assert.ok(count(after, 'warnings') >= 1, 'moderation cases are kept');

  const audit = await (await s.get(`/api/v2/guilds/${D_GUILD}/audit`)).json();
  const row = audit.entries.find((e) => e.action === 'privacy:member-data');
  assert.match(row.detail, new RegExp(`deleted data for ${MEMBER} — At your request\\. \\(DM failed\\)`));
});
