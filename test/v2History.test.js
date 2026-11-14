// The change history in the new dashboard (routes/v2GuildData.js): a settings save keeps what it changed,
// the audit log shows it as a diff, "Undo this change" puts the earlier values back through the module's own
// normaliser and writes an entry of its own. Secrets are masked and never restored; a change that was
// changed again needs a confirmation; every route is for this server's admins only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  D_GUILD,
  OTHER_D_GUILD,
  browser,
  profiles,
  setProfiles,
  signIn,
  startOAuthApp,
} from './helpers/oauthApp.js';

await startOAuthApp();

const { recordAudit } = await import('../src/db/audit.js');
const { getGuildModule, setGuildModule } = await import('../src/db/modules.js');
const { getGuildSettings, setEmbedColor, setModlogChannel } = await import('../src/db/guildSettings.js');
const { runtime } = await import('../src/runtime.js');

const OPERATOR_ID = '111111111111111111'; // OWNER_IDS in helpers/oauthApp.js

/** Signed in to Discord. `both`: an admin of the other server too (for the cross-server checks). */
const sessions = new Map();
// A sign-in is rate limited, so a session is made once per kind and kept (`tag` makes a separate account, so
// the undo limit of one account is not shared by every test).
function session(opts = {}) {
  const key = `${opts.discordId ?? ''}|${opts.both ? 'both' : ''}|${opts.tag ?? ''}`;
  if (!sessions.has(key)) sessions.set(key, makeSession(opts));
  return sessions.get(key);
}
async function makeSession({ discordId, both = false } = {}) {
  setProfiles({ discordId });
  if (both) {
    profiles.discord.guilds = [
      { id: D_GUILD, owner: true },
      { id: OTHER_D_GUILD, owner: true },
    ];
  }
  const b = browser();
  await signIn(b, 'discord');
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  const post = (path, body) =>
    b.get(path, {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const json = async (res) => ({ status: res.status, body: await res.json() });
  return {
    get: async (path) => json(await b.get(path)),
    post: async (path, body) => json(await post(path, body)),
  };
}

const guildPath = (path, guild = D_GUILD) => `/api/v2/guilds/${guild}${path}`;
const AFK = '/modules/afk/config';
const afk = (setNickname, ignoreChannels = []) => ({ setNickname, mentionReply: true, ignoreChannels });

async function newestEntry(s, action) {
  const { body } = await s.get(guildPath(`/audit?limit=100${action ? `&action=${action}` : ''}`));
  return body.entries[0];
}

test('a settings save keeps what it changed, and the audit log says which entries have a copy', async () => {
  const s = await session();
  assert.equal((await s.post(guildPath(AFK), afk(false))).status, 200);
  assert.equal((await s.post(guildPath(AFK), afk(true, ['900000000000000301']))).status, 200);

  const entry = await newestEntry(s, 'module:afk');
  assert.equal(entry.hasChange, true);
  assert.equal(entry.revertsId, null);
  const res = await s.get(guildPath(`/audit/${entry.id}/change`));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.before, { setNickname: false, ignoreChannels: [] });
  assert.deepEqual(res.body.after, { setNickname: true, ignoreChannels: ['900000000000000301'] });
  assert.equal(res.body.undo.available, true);
  assert.equal(res.body.undo.state, 'clean');
  assert.equal(res.body.entry.action, 'module:afk');
});

test('an entry that kept nothing has no change to show', async () => {
  const s = await session();
  await recordAudit(D_GUILD, { actor: 'Ann', action: 'module:polls', detail: 'enabled' });
  const entry = await newestEntry(s, 'module:polls');
  assert.equal(entry.hasChange, false);
  const res = await s.get(guildPath(`/audit/${entry.id}/change`));
  assert.equal(res.status, 404);
});

test('an undo restores the earlier settings, writes its own entry, and cannot be repeated', async () => {
  const s = await session({ tag: 'undo' });
  await s.post(guildPath(AFK), afk(false));
  await s.post(guildPath(AFK), afk(true, ['900000000000000302']));
  const entry = await newestEntry(s, 'module:afk');

  const undone = await s.post(guildPath(`/audit/${entry.id}/undo`), {});
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.deepEqual(undone.body, { ok: true, adjusted: [], notRestored: [] });
  assert.deepEqual((await getGuildModule(D_GUILD, 'afk')).config, {
    setNickname: false,
    mentionReply: true,
    ignoreChannels: [],
  });

  const own = await newestEntry(s, 'module:afk');
  assert.notEqual(own.id, entry.id);
  assert.equal(own.revertsId, entry.id);
  assert.match(own.detail, new RegExp(`undid change #${entry.id}`));
  assert.equal(own.hasChange, true, 'the undo kept its own before and after');
  const mine = (await s.get(guildPath(`/audit/${own.id}/change`))).body;
  assert.deepEqual(mine.before, { setNickname: true, ignoreChannels: ['900000000000000302'] });
  assert.deepEqual(mine.after, { setNickname: false, ignoreChannels: [] });

  // the entry now reads as already put back: not offered, and refused if sent anyway
  const again = await s.get(guildPath(`/audit/${entry.id}/change`));
  assert.equal(again.body.undo.available, false);
  assert.equal(again.body.undo.state, 'reverted');
  assert.equal((await s.post(guildPath(`/audit/${entry.id}/undo`), {})).status, 409);
  // and the undo itself can be undone
  assert.equal((await s.post(guildPath(`/audit/${own.id}/undo`), {})).status, 200);
  assert.equal((await getGuildModule(D_GUILD, 'afk')).config.setNickname, true);
});

test('settings changed again since need a confirmation, and without it nothing is restored', async () => {
  const s = await session({ tag: 'later' });
  await s.post(guildPath(AFK), afk(false));
  await s.post(guildPath(AFK), afk(true));
  const first = await newestEntry(s, 'module:afk');
  await s.post(guildPath(AFK), afk(true, ['900000000000000303']));

  const view = (await s.get(guildPath(`/audit/${first.id}/change`))).body;
  assert.equal(view.undo.state, 'clean', 'setNickname still has the value this entry gave it');
  // an entry whose own setting was changed again
  await s.post(guildPath(AFK), afk(false, ['900000000000000303']));
  const moved = (await s.get(guildPath(`/audit/${first.id}/change`))).body;
  assert.equal(moved.undo.state, 'reverted', 'it happens to have the earlier value again');

  await s.post(guildPath(AFK), afk(true));
  const second = await newestEntry(s, 'module:afk');
  await s.post(guildPath(AFK), afk(false));
  const warned = (await s.get(guildPath(`/audit/${second.id}/change`))).body;
  assert.equal(warned.undo.state, 'changed');
  assert.deepEqual(warned.undo.laterChanges, ['setNickname']);

  const before = (await getGuildModule(D_GUILD, 'afk')).config;
  const refused = await s.post(guildPath(`/audit/${second.id}/undo`), {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'changed-since');
  assert.deepEqual(refused.body.laterChanges, ['setNickname']);
  assert.deepEqual((await getGuildModule(D_GUILD, 'afk')).config, before, 'nothing was restored');

  // a yes alone is not enough: it has to be for the state the page showed (the token)
  const blank = await s.post(guildPath(`/audit/${second.id}/undo`), { confirm: true });
  assert.equal(blank.status, 409);
  assert.equal(blank.body.token, refused.body.token);
  assert.equal(warned.undo.token, refused.body.token, 'the entry view gave the same one');
  const stale = await s.post(guildPath(`/audit/${second.id}/undo`), { confirm: true, token: 'stale' });
  assert.equal(stale.status, 409);
  const confirmed = await s.post(guildPath(`/audit/${second.id}/undo`), {
    confirm: true,
    token: refused.body.token,
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal((await getGuildModule(D_GUILD, 'afk')).config.setNickname, false);
});

test('a secret is masked in the history and an undo keeps the one that is saved now', async () => {
  const s = await session();
  const feed = (url, channelId, id) => ({
    feeds: [{ type: 'url', ref: url, channelId, ...(id ? { id } : {}) }],
  });
  const saved = await s.post(
    guildPath('/modules/rss/config'),
    feed('https://example.com/a.xml?token=SECRET-ONE', '900000000000000311')
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const id = saved.body.config.feeds[0].id;
  assert.equal(
    (
      await s.post(
        guildPath('/modules/rss/config'),
        feed('https://example.com/a.xml?token=SECRET-TWO', '900000000000000312', id)
      )
    ).status,
    200
  );
  const entry = await newestEntry(s, 'module:rss');
  const view = await s.get(guildPath(`/audit/${entry.id}/change`));
  assert.doesNotMatch(JSON.stringify(view.body), /SECRET-ONE|SECRET-TWO/, 'never in clear');
  assert.match(JSON.stringify(view.body), /••••••/);

  const undone = await s.post(guildPath(`/audit/${entry.id}/undo`), {});
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  const feeds = (await getGuildModule(D_GUILD, 'rss')).config.feeds;
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].channelId, '900000000000000311', 'the channel went back');
  assert.match(feeds[0].url, /SECRET-TWO/, 'the secret that was saved stays, the mask is never written');
  assert.doesNotMatch(JSON.stringify(feeds), /••••••/);
  const own = await newestEntry(s, 'module:rss');
  assert.doesNotMatch(JSON.stringify((await s.get(guildPath(`/audit/${own.id}/change`))).body), /SECRET/);
});

test('server settings are kept and undone with the checks of their own save', async () => {
  const s = await session();
  const save = (embedColor) => s.post(guildPath('/settings'), { modlogChannelId: '', embedColor });
  assert.equal((await save('#112233')).status, 200);
  assert.equal((await save('#445566')).status, 200);
  const entry = await newestEntry(s, 'settings:server');
  assert.equal(entry.hasChange, true);
  const view = (await s.get(guildPath(`/audit/${entry.id}/change`))).body;
  assert.deepEqual(view.before, { embedColor: '#112233' });
  assert.deepEqual(view.after, { embedColor: '#445566' });

  const undone = await s.post(guildPath(`/audit/${entry.id}/undo`), {});
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.equal((await getGuildSettings(D_GUILD)).embed_color, 0x112233);
  assert.equal((await newestEntry(s, 'settings:server')).revertsId, entry.id);
});

test('a module whose save does more than store has no undo, only the difference', async () => {
  const s = await session();
  await recordAudit(D_GUILD, {
    actor: 'Ann',
    action: 'module:custom-commands',
    detail: 'saved',
    change: { before: { commands: [] }, after: { commands: [{ id: 'x', name: 'hi' }] } },
  });
  const entry = await newestEntry(s, 'module:custom-commands');
  const view = (await s.get(guildPath(`/audit/${entry.id}/change`))).body;
  assert.equal(view.undo.available, false);
  assert.match(view.undo.reason, /cannot be undone/);
  assert.deepEqual(view.after, { commands: [{ id: 'x', name: 'hi' }] });
  const res = await s.post(guildPath(`/audit/${entry.id}/undo`), {});
  assert.equal(res.status, 400);
});

test('an entry that is not a settings save, or too large to keep, cannot be undone', async () => {
  const s = await session();
  await recordAudit(D_GUILD, {
    actor: 'Ann',
    action: 'module:autoresponder',
    detail: 'big',
    change: { before: { responders: 'x'.repeat(100_000) }, after: { responders: 'y' } },
  });
  const entry = await newestEntry(s, 'module:autoresponder');
  const view = (await s.get(guildPath(`/audit/${entry.id}/change`))).body;
  assert.equal(view.tooLarge, true);
  assert.equal(view.undo.available, false);
  assert.equal((await s.post(guildPath(`/audit/${entry.id}/undo`), {})).status, 400);
});

test("only an admin of the server reads or undoes its history, and never another server's entry", async () => {
  // a member without Manage Server
  const member = await session();
  const entry = await newestEntry(member, 'module:afk');
  for (const [method, path] of [
    ['get', `/audit/${entry.id}/change`],
    ['post', `/audit/${entry.id}/undo`],
  ]) {
    const res =
      method === 'get'
        ? await member.get(guildPath(path, OTHER_D_GUILD))
        : await member.post(guildPath(path, OTHER_D_GUILD), {});
    assert.equal(res.status, 403, `${method} ${path}`);
  }

  // an admin of both servers: an id from one server is not found through the other
  const both = await session({ both: true });
  const before = (await getGuildModule(D_GUILD, 'afk')).config;
  const got = await both.get(guildPath(`/audit/${entry.id}/change`, OTHER_D_GUILD));
  assert.equal(got.status, 404);
  const undo = await both.post(guildPath(`/audit/${entry.id}/undo`, OTHER_D_GUILD), { confirm: true });
  assert.equal(undo.status, 404);
  assert.deepEqual((await getGuildModule(D_GUILD, 'afk')).config, before, 'nothing of this server changed');
  assert.deepEqual(
    (await both.get(guildPath('/audit', OTHER_D_GUILD))).body.entries.filter((e) => e.id === entry.id),
    []
  );
  for (const bad of ['0', '-1', 'x', '99999999999']) {
    assert.equal((await both.get(guildPath(`/audit/${bad}/change`))).status, 404, bad);
  }
});

test('the history of an operator-only module is for operators', async () => {
  await setGuildModule(D_GUILD, 'apple-connect', { config: { channelId: '' } });
  await recordAudit(D_GUILD, {
    actor: 'Ann',
    action: 'module:apple-connect',
    detail: 'saved',
    change: { before: { channelId: '1' }, after: { channelId: '2' } },
  });
  const admin = await session();
  const listed = await newestEntry(admin, 'module:apple-connect');
  assert.equal(listed.hasChange, false);
  assert.equal((await admin.get(guildPath(`/audit/${listed.id}/change`))).status, 404);
  assert.equal((await admin.post(guildPath(`/audit/${listed.id}/undo`), {})).status, 404);

  const operator = await session({ discordId: OPERATOR_ID });
  const seen = await newestEntry(operator, 'module:apple-connect');
  assert.equal(seen.hasChange, true);
  const view = await operator.get(guildPath(`/audit/${seen.id}/change`));
  assert.equal(view.status, 200);
  assert.equal(view.body.undo.available, false, 'not restorable from here');
});

test('a settings undo that cannot restore one setting changes nothing and writes no entry', async () => {
  const s = await session({ tag: 'settings' });
  // now: colour #445566, no mod-log channel. The entry: the colour was #112233 and a mod-log channel was set.
  await setEmbedColor(D_GUILD, 0x445566);
  await setModlogChannel(D_GUILD, null);
  const GONE = '100000000000000555'; // a channel this server no longer has
  await recordAudit(D_GUILD, {
    actor: 'Ann',
    action: 'settings:server',
    detail: 'saved',
    change: {
      before: { modlogChannelId: GONE, embedColor: '#112233' },
      after: { modlogChannelId: '', embedColor: '#445566' },
    },
  });
  const entry = await newestEntry(s, 'settings:server');
  const count = async () => (await s.get(guildPath('/audit?limit=100'))).body.entries.length;
  const before = await count();
  const res = await s.post(guildPath(`/audit/${entry.id}/undo`), {});
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /no longer exists/);
  assert.equal((await getGuildSettings(D_GUILD)).embed_color, 0x445566, 'the colour was not written');
  assert.equal((await getGuildSettings(D_GUILD)).modlog_channel_id, null);
  assert.equal(await count(), before, 'and nothing was written to the audit log');
});

test('an undo cannot hand out a role the person could not hand out in the form', async () => {
  const s = await session({ tag: 'grant' });
  const ROLE = '200000000000000777';
  runtime.clients.discord.guilds.cache.get(D_GUILD).roles.cache.set(ROLE, {
    id: ROLE,
    name: 'Staff',
    position: 5,
    permissions: { has: () => false },
  });
  await setGuildModule(D_GUILD, 'birthdays', { config: { roleId: '' } });
  await recordAudit(D_GUILD, {
    actor: 'Ann',
    action: 'module:birthdays',
    detail: 'saved',
    change: { before: { roleId: ROLE }, after: { roleId: '' } },
  });
  const entry = await newestEntry(s, 'module:birthdays');
  const res = await s.post(guildPath(`/audit/${entry.id}/undo`), {});
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal((await getGuildModule(D_GUILD, 'birthdays')).config.roleId, '', 'the role was not handed out');
});

test('an undo asked twice at once is done once', async () => {
  const s = await session({ tag: 'twice' });
  await s.post(guildPath(AFK), afk(false));
  await s.post(guildPath(AFK), afk(true));
  const entry = await newestEntry(s, 'module:afk');
  const [one, two] = await Promise.all([
    s.post(guildPath(`/audit/${entry.id}/undo`), {}),
    s.post(guildPath(`/audit/${entry.id}/undo`), {}),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  const { body } = await s.get(guildPath('/audit?limit=100&action=module:afk'));
  assert.equal(body.entries.filter((e) => e.revertsId === entry.id).length, 1);
});

test('the leaderboard switch keeps its change and shows it without an undo', async () => {
  const s = await session({ tag: 'board' });
  assert.equal((await s.post(guildPath('/leaderboard/public'), { publicLeaderboard: true })).status, 200);
  assert.equal((await s.post(guildPath('/leaderboard/public'), { publicLeaderboard: false })).status, 200);
  const entry = await newestEntry(s, 'leveling:leaderboard');
  assert.equal(entry.hasChange, true);
  const view = (await s.get(guildPath(`/audit/${entry.id}/change`))).body;
  assert.deepEqual(view.after, { publicLeaderboard: false });
  assert.equal(view.undo.available, false);
  assert.equal(view.kind, null);
});
