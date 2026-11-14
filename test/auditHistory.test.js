// The change history in the audit log (src/db/audit.js, src/db/auditCapture.js): an entry for a settings save
// keeps the settings that changed, before and after, with the secrets masked; the 500-entry cap, the purge
// and /forget cover it.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_BUDGET_CHARS,
  getAuditEntry,
  listAuditPage,
  recordAudit,
  scrubMemberFromHistory,
} from '../src/db/audit.js';
import { setBotMasterRoles, setEmbedColor, setModlogChannel } from '../src/db/guildSettings.js';
import { runWithCapture } from '../src/db/auditCapture.js';
import { setGuildModule } from '../src/db/modules.js';
import { describeUserData, exportUserData, forgetUser, purgeGuild } from '../src/db/purge.js';
import { MASK } from '../src/lib/configSnapshot.js';
import { db } from '../src/db/index.js';

const G = '910000000000000001';
const OTHER = '910000000000000002';
const MEMBER = '810000000000000123';

test('an entry for a settings save keeps what changed, and a plain entry keeps nothing', async () => {
  await recordAudit(G, {
    actor: 'Ann',
    action: 'settings:server',
    detail: 'saved',
    change: {
      before: { modlogChannelId: '1', embedColor: '#112233' },
      after: { modlogChannelId: '2', embedColor: '#112233' },
    },
  });
  await recordAudit(G, { actor: 'Ann', action: 'module:polls', detail: 'enabled' });
  const { rows } = await listAuditPage(G, { limit: 10 });
  const [plain, saved] = rows;
  assert.equal(Number(plain.has_change), 0);
  assert.equal(Number(saved.has_change), 1);
  assert.ok(!('change_json' in saved), 'a list never carries the snapshots');
  const entry = await getAuditEntry(G, saved.id);
  assert.deepEqual(entry.change, { before: { modlogChannelId: '1' }, after: { modlogChannelId: '2' } });
  assert.equal(entry.revertsId, null);
  assert.equal((await getAuditEntry(G, plain.id)).change, null);
});

test('an entry is found only in its own server, and only by a sane id', async () => {
  const { rows } = await listAuditPage(G, { limit: 10 });
  const id = rows.find((r) => Number(r.has_change) === 1).id;
  assert.ok(await getAuditEntry(G, id));
  assert.equal(await getAuditEntry(OTHER, id), null, 'never another server');
  for (const bad of [0, -1, 1.5, NaN, 2 ** 40, 'x', null]) assert.equal(await getAuditEntry(G, bad), null);
});

test('a module save inside a dashboard request is kept as the entry written for it', async () => {
  await setGuildModule(G, 'afk', { config: { setNickname: false, mentionReply: false, ignoreChannels: [] } });
  await runWithCapture(async () => {
    await setGuildModule(G, 'afk', {
      config: { setNickname: true, mentionReply: false, ignoreChannels: ['1'] },
    });
    await recordAudit(G, { actor: 'Ann', action: 'module:afk', detail: 'settings saved' });
  });
  const entry = await getAuditEntry(G, (await listAuditPage(G, { limit: 1 })).rows[0].id);
  assert.deepEqual(entry.change, {
    before: { setNickname: false, ignoreChannels: [] },
    after: { setNickname: true, ignoreChannels: ['1'] },
  });
});

test('a route that saves a module twice is one change: the first before, the last after', async () => {
  await runWithCapture(async () => {
    await setGuildModule(G, 'afk', {
      config: { setNickname: false, mentionReply: true, ignoreChannels: [] },
    });
    await setGuildModule(G, 'afk', {
      config: { setNickname: false, mentionReply: false, ignoreChannels: [] },
    });
    await recordAudit(G, { actor: 'Ann', action: 'module:afk', detail: 'settings saved' });
  });
  const entry = await getAuditEntry(G, (await listAuditPage(G, { limit: 1 })).rows[0].id);
  // before the request: {true,false,['1']}; after: {false,false,[]}
  assert.deepEqual(entry.change.after, { setNickname: false, ignoreChannels: [] });
  assert.deepEqual(entry.change.before, { setNickname: true, ignoreChannels: ['1'] });
});

test('a write with no request, an entry about another module and an unchanged save keep nothing', async () => {
  await setGuildModule(G, 'afk', { config: { setNickname: true, mentionReply: true, ignoreChannels: [] } });
  await recordAudit(G, { actor: 'Ann', action: 'module:afk', detail: 'no request' });
  await runWithCapture(async () => {
    await setGuildModule(G, 'afk', {
      config: { setNickname: false, mentionReply: true, ignoreChannels: [] },
    });
    await recordAudit(G, { actor: 'Ann', action: 'module:polls', detail: 'other module' });
    // the afk change is still waiting for its own entry: an entry for a different module does not take it
    await recordAudit(G, { actor: 'Ann', action: 'module:afk', detail: 'now' });
    await setGuildModule(G, 'afk', {
      config: { setNickname: false, mentionReply: true, ignoreChannels: [] },
    });
    await recordAudit(G, { actor: 'Ann', action: 'module:afk', detail: 'same again' });
  });
  const rows = (await listAuditPage(G, { limit: 5 })).rows;
  const byDetail = Object.fromEntries(rows.map((r) => [r.detail, Number(r.has_change)]));
  assert.equal(byDetail['no request'], 0);
  assert.equal(byDetail['other module'], 0);
  assert.equal(byDetail.now, 1);
  assert.equal(byDetail['same again'], 0, 'a save that changed nothing keeps no copy');
});

test('a secret is never stored in clear', async () => {
  await runWithCapture(async () => {
    await setGuildModule(G, 'rss', {
      config: {
        feeds: [{ id: 'aaaaaaaa', url: 'https://example.com/feed?token=abc123', channelId: '1' }],
        apiKey: 'k-old',
      },
    });
    await setGuildModule(G, 'rss', {
      config: {
        feeds: [{ id: 'aaaaaaaa', url: 'https://example.com/feed?token=zzz999', channelId: '2' }],
        apiKey: 'k-new',
      },
    });
    await recordAudit(G, { actor: 'Ann', action: 'module:rss', detail: 'settings saved' });
  });
  const row = db
    .prepare('SELECT change_json FROM config_audit WHERE guild_id = ? ORDER BY id DESC LIMIT 1')
    .get(G);
  assert.doesNotMatch(row.change_json, /abc123|zzz999|k-old|k-new/);
  assert.match(row.change_json, new RegExp(MASK));
});

test('a copy that is too large is not kept, and the entry says so', async () => {
  await recordAudit(G, {
    actor: 'Ann',
    action: 'module:autoresponder',
    detail: 'big',
    change: { before: { responders: 'x'.repeat(100_000) }, after: { responders: 'y' } },
  });
  const entry = await getAuditEntry(G, (await listAuditPage(G, { limit: 1 })).rows[0].id);
  assert.deepEqual(entry.change, { tooLarge: true });
});

test('an undo entry says which entry it undoes', async () => {
  await recordAudit(G, { actor: 'Ann', action: 'module:afk', detail: 'undid', revertsId: 7 });
  const row = (await listAuditPage(G, { limit: 1 })).rows[0];
  assert.equal(Number(row.reverts_id), 7);
});

test('the history is capped at 500 entries a server, copies included', async () => {
  const P = '910000000000000003';
  for (let i = 0; i < 520; i += 1) {
    await recordAudit(P, {
      actor: 'x',
      action: 'module:afk',
      detail: String(i),
      change: { before: { n: i }, after: { n: i + 1 } },
    });
  }
  const n = db.prepare('SELECT COUNT(*) AS n FROM config_audit WHERE guild_id = ?').get(P).n;
  assert.equal(n, 500);
  const withCopy = db
    .prepare('SELECT COUNT(*) AS n FROM config_audit WHERE guild_id = ? AND change_json IS NOT NULL')
    .get(P).n;
  assert.equal(withCopy, 500, 'the newest 500 keep their copies');
});

test('forgetting a member takes their id out of the saved changes, and /mydata lists them first', async () => {
  const F = '910000000000000004';
  await recordAudit(F, {
    actor: 'Ann',
    action: 'module:auto-react',
    detail: 'settings saved',
    change: {
      before: {
        rules: [{ targetUsers: [MEMBER, '810000000000000999'], emojis: ['a'] }],
        note: `hi <@${MEMBER}>`,
      },
      after: { rules: [{ targetUsers: ['810000000000000999'], emojis: ['a'] }], note: 'hi' },
    },
  });
  await recordAudit(F, {
    actor: 'Ann',
    action: 'module:afk',
    detail: 'unrelated',
    change: { before: { a: 1 }, after: { a: 2 } },
  });

  const seen = await describeUserData(F, MEMBER);
  assert.equal(seen.items.find((i) => i.key === 'configHistory').count, 1);
  assert.equal(seen.erasable >= 1, true);
  const dump = await exportUserData(F, MEMBER);
  assert.equal(dump.data.configHistory.length, 1);
  assert.doesNotMatch(
    JSON.stringify(dump.data.configHistory),
    /targetUsers|810000000000000999/,
    'ids, not values'
  );

  const result = await forgetUser(F, MEMBER);
  assert.equal(result.configHistory, 1);
  const text = db
    .prepare('SELECT change_json FROM config_audit WHERE guild_id = ? AND action = ?')
    .get(F, 'module:auto-react').change_json;
  assert.ok(!text.includes(MEMBER), 'the id is gone');
  assert.ok(text.includes('810000000000000999'), 'someone else stays');
  assert.equal((await describeUserData(F, MEMBER)).items.find((i) => i.key === 'configHistory').count, 0);
  // the entry itself and the other one are still there
  assert.equal((await listAuditPage(F, { limit: 10 })).rows.length, 2);
  assert.equal(await scrubMemberFromHistory(F, MEMBER), 0, 'nothing left to take out');
  assert.equal(await scrubMemberFromHistory(F, 'not an id'), 0);
});

test('the history goes with the server when it is purged', async () => {
  const Z = '910000000000000005';
  await recordAudit(Z, {
    actor: 'Ann',
    action: 'module:afk',
    detail: 'x',
    change: { before: { a: 1 }, after: { a: 2 } },
  });
  await purgeGuild(Z);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM config_audit WHERE guild_id = ?').get(Z).n, 0);
});

test('server settings written in a request are kept as the change of its "settings" entry', async () => {
  const S = '910000000000000006';
  await runWithCapture(async () => {
    await setModlogChannel(S, '100000000000000001');
    await setEmbedColor(S, 0x112233);
    await setBotMasterRoles(S, ['200000000000000001']);
    await setModlogChannel(S, '100000000000000002');
    await recordAudit(S, { actor: 'Ann', action: 'settings:server', detail: 'saved' });
    // another kind of settings entry (the setup wizard writes "settings") takes them too
    await setEmbedColor(S, 0x445566);
    await recordAudit(S, { actor: 'Ann', action: 'settings', detail: 'wizard' });
  });
  const [wizard, saved] = (await listAuditPage(S, { limit: 2 })).rows;
  const first = await getAuditEntry(S, saved.id);
  assert.deepEqual(first.change.before, { modlogChannelId: '', embedColor: '', botMasterRoleIds: [] });
  assert.deepEqual(first.change.after, {
    modlogChannelId: '100000000000000002',
    embedColor: '#112233',
    botMasterRoleIds: ['200000000000000001'],
  });
  const second = await getAuditEntry(S, wizard.id);
  assert.deepEqual(second.change, { before: { embedColor: '#112233' }, after: { embedColor: '#445566' } });
  // outside a request nothing is noted
  await setEmbedColor(S, 0x000001);
  await recordAudit(S, { actor: 'Ann', action: 'settings:server', detail: 'no request' });
  assert.equal(Number((await listAuditPage(S, { limit: 1 })).rows[0].has_change), 0);
});

test('an entry that is not a "module:" one takes the config of the only module the request wrote', async () => {
  const Q = '910000000000000007';
  await setGuildModule(Q, 'leveling', { config: { publicLeaderboard: false } });
  await runWithCapture(async () => {
    await setGuildModule(Q, 'leveling', { config: { publicLeaderboard: true } });
    await recordAudit(Q, { actor: 'Ann', action: 'leveling:leaderboard', detail: 'made public' });
    // two modules: it is not clear which one an unrelated entry is about, so it takes neither
    await setGuildModule(Q, 'afk', { config: { setNickname: true } });
    await setGuildModule(Q, 'polls', { config: { voteRoleMode: 'deny' } });
    await recordAudit(Q, { actor: 'Ann', action: 'economy:adjust', detail: 'x' });
  });
  const [unrelated, board] = (await listAuditPage(Q, { limit: 2 })).rows;
  assert.deepEqual((await getAuditEntry(Q, board.id)).change, {
    before: { publicLeaderboard: false },
    after: { publicLeaderboard: true },
  });
  assert.equal(Number(unrelated.has_change), 0);
});

test('the notes of a request are kept apart by server: the same module in two servers is two changes', async () => {
  const A = '910000000000000008';
  const B = '910000000000000009';
  await runWithCapture(async () => {
    await setGuildModule(A, 'afk', { config: { setNickname: true } });
    await setGuildModule(B, 'afk', { config: { setNickname: false } });
    await recordAudit(B, { actor: 'Ann', action: 'module:afk', detail: 'b' });
    await recordAudit(A, { actor: 'Ann', action: 'module:afk', detail: 'a' });
  });
  const a = await getAuditEntry(A, (await listAuditPage(A, { limit: 1 })).rows[0].id);
  const b = await getAuditEntry(B, (await listAuditPage(B, { limit: 1 })).rows[0].id);
  assert.deepEqual(a.change.after, { setNickname: true });
  assert.deepEqual(b.change.after, { setNickname: false });
});

test('two requests at once keep their own changes', async () => {
  const P1 = '910000000000000010';
  const P2 = '910000000000000011';
  const request = (guild, module, value) =>
    runWithCapture(async () => {
      await setGuildModule(guild, module, { config: { v: value } });
      await new Promise((r) => setTimeout(r, 5));
      await recordAudit(guild, { actor: 'x', action: `module:${module}`, detail: String(value) });
    });
  await Promise.all([request(P1, 'afk', 1), request(P2, 'polls', 2), request(P1, 'sticky', 3)]);
  const rows = (await listAuditPage(P1, { limit: 5 })).rows;
  const byDetail = {};
  for (const r of rows) byDetail[r.detail] = (await getAuditEntry(P1, r.id)).change.after;
  assert.deepEqual(byDetail, { 1: { v: 1 }, 3: { v: 3 } });
  const other = await getAuditEntry(P2, (await listAuditPage(P2, { limit: 1 })).rows[0].id);
  assert.deepEqual(other.change.after, { v: 2 });
});

test('the copies of a server are kept within a budget: the oldest copies go, the entries stay', async () => {
  const W = '910000000000000012';
  const big = JSON.stringify({ before: { text: 'x'.repeat(30_000) }, after: { text: 'y' } });
  const insert = db.prepare(
    "INSERT INTO config_audit (guild_id, actor, action, detail, created_at, change_json) VALUES (?, 'x', 'module:afk', ?, ?, ?)"
  );
  for (let i = 0; i < 199; i += 1) insert.run(W, String(i), i, big);
  // the next real save pushes the copies over the budget (199 x 30,000 is about 6 million characters)
  await recordAudit(W, {
    actor: 'x',
    action: 'module:afk',
    detail: 'newest',
    change: { before: { text: 'a' }, after: { text: 'b' } },
  });
  const total = db
    .prepare('SELECT SUM(LENGTH(change_json)) AS n FROM config_audit WHERE guild_id = ?')
    .get(W).n;
  assert.ok(total <= HISTORY_BUDGET_CHARS, `copies hold ${total} characters`);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM config_audit WHERE guild_id = ?').get(W).n,
    200,
    'no entry was lost'
  );
  const has = (order) =>
    db
      .prepare(
        `SELECT change_json IS NOT NULL AS has FROM config_audit WHERE guild_id = ? ORDER BY id ${order} LIMIT 1`
      )
      .get(W).has;
  assert.equal(has('DESC'), 1, 'the newest still has its copy');
  assert.equal(has('ASC'), 0, 'the oldest lost it');
});

test('forgetting a member takes out the whole id only, never a piece of a longer one, and clears entry text', async () => {
  const Y = '910000000000000013';
  const short = '810000000000000123'; // 18 digits
  const longer = `${short}9`; // a 19-digit id that contains it
  await recordAudit(Y, {
    actor: 'Ann',
    action: 'module:auto-react',
    detail: 'x',
    change: {
      before: { targets: [short, longer], where: longer },
      after: { targets: [longer], where: '' },
    },
  });
  await recordAudit(Y, { actor: 'Ann', action: 'economy:adjust', detail: `add 5 for ${short}` });
  await recordAudit(Y, { actor: 'Ann', action: 'economy:adjust', detail: `add 5 for ${longer}` });

  const seen = await describeUserData(Y, short);
  assert.equal(
    seen.items.find((i) => i.key === 'configHistory').count,
    2,
    'the copy and the text, not the longer id'
  );
  await scrubMemberFromHistory(Y, short);
  const entries = (await listAuditPage(Y, { limit: 5 })).rows;
  const copy = entries.find((r) => r.action === 'module:auto-react');
  const change = (await getAuditEntry(Y, copy.id)).change;
  assert.deepEqual(change.before, { targets: [longer], where: longer }, 'the longer id is untouched');
  const details = entries
    .filter((r) => r.action === 'economy:adjust')
    .map((r) => r.detail)
    .sort();
  assert.deepEqual(details, [`add 5 for ${longer}`, 'add 5 for a former member'].sort());
});
