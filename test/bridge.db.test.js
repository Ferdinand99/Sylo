// Bridge storage: the three tables (migration 83), one-time codes (only the hash is stored, they expire
// and are used up by the first claim), links (a channel is in at most one), the message map (a lookup
// from either side, swept after 30 days by the retention job) and the guild-leave purge.
import './helpers/tmpDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, MIGRATIONS, SCHEMA_VERSION } from '../src/db/index.js';
import {
  CODE_TTL_MS,
  MESSAGE_MAP_TTL_MS,
  cancelCode,
  claimCode,
  createCode,
  createLink,
  deleteLink,
  deleteMapping,
  getLink,
  linkCount,
  linkForChannel,
  linkForHook,
  linksOfGuild,
  looksLikeCode,
  mappingOf,
  newCode,
  normaliseCode,
  peekCode,
  pendingCodeCount,
  pendingCodes,
  purgeBridgeGuild,
  saveMapping,
  setLinkHook,
  setLinkOptions,
  setLinkStatus,
  sweepCodes,
  sweepMappings,
} from '../src/db/bridge.js';
import { GUILD_TABLES, purgeGuild } from '../src/db/purge.js';
import { sweepRetention } from '../src/db/retention.js';

const D = '710000000000000001';
const F = 'fluxer:710000000000000002';
const D2 = '710000000000000003';
const CH = {
  d1: '720000000000000001',
  f1: '720000000000000002',
  d2: '720000000000000003',
  f2: '720000000000000004',
};

const link = (over = {}) => ({
  guildA: D,
  channelA: CH.d1,
  guildB: F,
  channelB: CH.f1,
  hookA: { id: 'hook-a', token: 'secret-a' },
  hookB: { id: 'hook-b', token: 'secret-b' },
  requestedBy: 'Alice (dashboard)',
  acceptedBy: 'Bob (dashboard)',
  ...over,
});

beforeEach(async () => {
  for (const g of [D, F, D2]) await purgeGuild(g);
  db.prepare('DELETE FROM bridge_codes').run();
});

test('migration 83 creates the three tables, the unique channel indexes and the 30-day index', () => {
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 83, 'the Bridge keeps version 83 (81 and 82 belong to other changes)');
  const names = (t) =>
    db
      .prepare(`PRAGMA table_info(${t})`)
      .all()
      .map((c) => c.name);
  assert.deepEqual(names('bridge_links'), [
    'id',
    'guild_a',
    'channel_a',
    'guild_b',
    'channel_b',
    'status',
    'paused_side',
    'fail_reason',
    'failure_count',
    'options_a',
    'options_b',
    'hook_a_id',
    'hook_a_token',
    'hook_b_id',
    'hook_b_token',
    'requested_by_name',
    'accepted_by_name',
    'owner_a',
    'owner_b',
    'created_at',
    'updated_at',
  ]);
  assert.deepEqual(names('bridge_codes'), [
    'id',
    'guild_id',
    'channel_id',
    'code_hash',
    'options',
    'requested_by_name',
    'guild_owner',
    'expires_at',
    'created_at',
  ]);
  assert.deepEqual(names('bridge_messages'), [
    'link_id',
    'origin',
    'a_message_id',
    'b_message_id',
    'copy_hook_id',
    'content_hash',
    'extra',
    'created_at',
  ]);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_bridge_%'")
    .all()
    .map((r) => r.name);
  for (const name of [
    'idx_bridge_links_a',
    'idx_bridge_links_b',
    'idx_bridge_codes_hash',
    'idx_bridge_messages_b',
    'idx_bridge_messages_created',
  ]) {
    assert.ok(indexes.includes(name), name);
  }
  // 81 and 82 are placeholders until their own changes land: they must not have made any table of theirs here.
  assert.equal(typeof MIGRATIONS[80], 'function');
  assert.equal(typeof MIGRATIONS[81], 'function');
});

test('bridge_codes is in GUILD_TABLES; the links go through purgeBridgeGuild (they name two servers)', () => {
  assert.ok(GUILD_TABLES.includes('bridge_codes'));
  assert.ok(!GUILD_TABLES.includes('bridge_links'));
});

test('the table columns hold names, not user ids (so /forget has nothing to find)', () => {
  const columns = db
    .prepare('PRAGMA table_info(bridge_links)')
    .all()
    .map((c) => c.name);
  assert.ok(columns.includes('requested_by_name') && columns.includes('accepted_by_name'));
  assert.ok(
    !columns.some((c) => /(user|author|owner|decided|moderator|actor)_(id|by)$|^created_by$/.test(c))
  );
});

// --- codes ---------------------------------------------------------------------------------------------

test('a code is 12 characters of an unambiguous alphabet, shown as XXXX-XXXX-XXXX', () => {
  for (let i = 0; i < 50; i += 1) {
    const code = newCode();
    assert.match(code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    assert.ok(looksLikeCode(code));
    assert.ok(looksLikeCode(code.toLowerCase().replace(/-/g, ' ')), 'typed in lower case, with spaces');
  }
  assert.equal(normaliseCode(' ab-cd ef '), 'ABCDEF');
  assert.ok(!looksLikeCode('0123-4567-89AB'), '0, 1, O, I and L are not in the alphabet');
  assert.ok(!looksLikeCode(''));
  assert.ok(!looksLikeCode(null));
});

test('only the hash of a code is stored, and it is used up by the first claim', async () => {
  const made = await createCode({
    guildId: D,
    channelId: CH.d1,
    options: { bots: true },
    requestedBy: 'Alice',
  });
  const stored = JSON.stringify(db.prepare('SELECT * FROM bridge_codes').all());
  assert.ok(!stored.includes(made.code), 'the code is not stored');
  assert.ok(!stored.includes(normaliseCode(made.code)), 'nor its plain form');
  assert.equal(db.prepare('SELECT code_hash FROM bridge_codes').get().code_hash.length, 64);

  assert.equal((await peekCode(made.code)).guildId, D, 'peek reads without using it up');
  assert.equal(await pendingCodeCount(D), 1);
  const claimed = await claimCode(made.code.toLowerCase());
  assert.deepEqual(
    {
      guildId: claimed.guildId,
      channelId: claimed.channelId,
      options: claimed.options,
      by: claimed.requestedBy,
    },
    { guildId: D, channelId: CH.d1, options: { bots: true }, by: 'Alice' }
  );
  assert.equal(await claimCode(made.code), null, 'a second server cannot use it');
  assert.equal(await peekCode(made.code), null);
});

test('a code expires after its time, and a wrong or malformed code finds nothing', async () => {
  const made = await createCode({ guildId: D, channelId: CH.d1 });
  assert.equal(made.expiresAt - Date.now() <= CODE_TTL_MS, true);
  assert.equal(await claimCode('ABCD-EFGH-JKMN'), null);
  assert.equal(await claimCode('not a code'), null);
  assert.equal(await claimCode(made.code, made.expiresAt + 1), null, 'past its time');
  assert.ok(await claimCode(made.code, made.expiresAt - 1), 'still inside its time');

  const old = await createCode({ guildId: D, channelId: CH.d2, ttlMs: -1000 });
  assert.equal(await pendingCodeCount(D), 0, 'an expired request is not pending');
  assert.equal(await sweepCodes(), 1);
  assert.equal(await claimCode(old.code), null);
});

test('pending requests list without their codes, and only the server that made one can cancel it', async () => {
  const a = await createCode({ guildId: D, channelId: CH.d1, requestedBy: 'Alice' });
  await createCode({ guildId: D2, channelId: CH.d2 });
  const list = await pendingCodes(D);
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['channelId', 'createdAt', 'expiresAt', 'id', 'requestedBy']);
  assert.equal(await cancelCode(D2, a.id), false, 'another server cannot cancel it');
  assert.equal(await cancelCode(D, a.id), true);
  assert.equal(await pendingCodeCount(D), 0);
  assert.equal(await claimCode(a.code), null);
});

// --- links ---------------------------------------------------------------------------------------------

test('create, read and find a link from either side, from the channel or from a webhook', async () => {
  const id = await createLink(link());
  assert.ok(id > 0);
  const row = await getLink(id);
  assert.equal(row.status, 'active');
  assert.equal(row.guildA, D);
  assert.equal(row.channelB, CH.f1);
  assert.deepEqual(row.optionsA, {});
  assert.equal(row.requestedBy, 'Alice (dashboard)');
  assert.equal((await linkForChannel(D, CH.d1)).side, 'a');
  assert.equal((await linkForChannel(F, CH.f1)).side, 'b');
  assert.equal(await linkForChannel(D, CH.f1), null, 'a channel id of another server is not a match');
  assert.equal((await linkForHook('hook-b')).id, id);
  assert.equal(await linkForHook('nope'), null);
  assert.equal(await linkForHook(''), null);
  assert.deepEqual(
    (await linksOfGuild(F)).map((l) => l.id),
    [id]
  );
  assert.equal(await linkCount(D), 1);
  assert.equal(await linkCount(D2), 0);
});

test('a channel is in at most one link, from either side', async () => {
  assert.ok(await createLink(link()));
  assert.equal(await createLink(link({ channelB: CH.f2 })), null, 'the same channel a second time');
  assert.equal(await createLink(link({ channelA: CH.d2 })), null, 'the same channel b second time');
  assert.ok(await createLink(link({ channelA: CH.d2, channelB: CH.f2 })), 'other channels are free');
});

test('status, options and the webhook of a side change independently', async () => {
  const id = await createLink(link());
  await setLinkStatus(id, { status: 'paused', pausedSide: 'b' });
  let row = await getLink(id);
  assert.deepEqual([row.status, row.pausedSide], ['paused', 'b']);
  await setLinkStatus(id, { status: 'failed', pausedSide: 'a', reason: 'permissions', failures: 5 });
  row = await getLink(id);
  assert.deepEqual(
    [row.status, row.pausedSide, row.failReason, row.failureCount],
    ['failed', '', 'permissions', 5]
  );
  await setLinkStatus(id, { status: 'active' });
  row = await getLink(id);
  assert.deepEqual([row.status, row.failReason, row.failureCount], ['active', '', 0]);

  await setLinkOptions(id, 'b', { bots: true });
  row = await getLink(id);
  assert.deepEqual([row.optionsA, row.optionsB], [{}, { bots: true }]);

  await setLinkHook(id, 'a', { id: 'hook-new', token: 'tok-new' });
  row = await getLink(id);
  assert.deepEqual([row.hookAId, row.hookAToken, row.hookBId], ['hook-new', 'tok-new', 'hook-b']);
  assert.equal(await linkForHook('hook-a'), null, 'the old webhook no longer belongs to the link');
});

// --- the message map -------------------------------------------------------------------------------------

test('the map finds a message from either side, with the counterpart and who was the original', async () => {
  const id = await createLink(link());
  await saveMapping(id, 'a', {
    sourceId: 'src-1',
    copyId: 'copy-1',
    hookId: 'hook-b',
    hash: 'h1',
    extra: { head: '> hi' },
  });
  await saveMapping(id, 'b', { sourceId: 'src-2', copyId: 'copy-2', hookId: 'hook-a' });

  const fromA = await mappingOf(id, 'a', 'src-1');
  assert.deepEqual(
    [fromA.counterpartId, fromA.isOriginal, fromA.copyHookId, fromA.contentHash, fromA.extra],
    ['copy-1', true, 'hook-b', 'h1', { head: '> hi' }]
  );
  const fromB = await mappingOf(id, 'b', 'copy-1');
  assert.deepEqual(
    [fromB.counterpartId, fromB.isOriginal],
    ['src-1', false],
    'the copy points back to the original'
  );
  const second = await mappingOf(id, 'b', 'src-2');
  assert.deepEqual([second.counterpartId, second.isOriginal], ['copy-2', true]);
  assert.equal(await mappingOf(id, 'a', 'nope'), null);
  assert.equal(await mappingOf(id, 'b', 'src-1'), null, 'an id is looked up on its own side only');

  await deleteMapping(id, 'a', 'src-1');
  assert.equal(await mappingOf(id, 'a', 'src-1'), null);
  assert.equal(await mappingOf(id, 'b', 'copy-1'), null);
});

test('saving a mapping again for the same message replaces it, and the map is per link', async () => {
  const one = await createLink(link());
  const two = await createLink(
    link({ channelA: CH.d2, channelB: CH.f2, hookA: { id: 'x', token: 'x' }, hookB: { id: 'y', token: 'y' } })
  );
  await saveMapping(one, 'a', { sourceId: 'm', copyId: 'c1' });
  await saveMapping(one, 'a', { sourceId: 'm', copyId: 'c2', hash: 'new' });
  assert.equal((await mappingOf(one, 'a', 'm')).counterpartId, 'c2');
  assert.equal(await mappingOf(two, 'a', 'm'), null, 'another link has its own map');
});

test('a mapping expires after 30 days: the sweep, and the daily retention job, remove it', async () => {
  const id = await createLink(link());
  const day = 86_400_000;
  await saveMapping(id, 'a', { sourceId: 'old', copyId: 'old-copy' });
  await saveMapping(id, 'a', { sourceId: 'new', copyId: 'new-copy' });
  db.prepare('UPDATE bridge_messages SET created_at = ? WHERE a_message_id = ?').run(
    Date.now() - 31 * day,
    'old'
  );
  assert.equal(MESSAGE_MAP_TTL_MS, 30 * day);
  assert.equal(await sweepMappings(), 1);
  assert.equal(await mappingOf(id, 'a', 'old'), null);
  assert.ok(await mappingOf(id, 'a', 'new'));

  db.prepare('UPDATE bridge_messages SET created_at = ? WHERE a_message_id = ?').run(
    Date.now() - 40 * day,
    'new'
  );
  await createCode({ guildId: D, channelId: CH.d1, ttlMs: -1 });
  await sweepRetention();
  assert.equal(await mappingOf(id, 'a', 'new'), null, 'the retention job sweeps the map');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_codes').get().n, 0, 'and the expired requests');
});

// --- purge -----------------------------------------------------------------------------------------------

test('deleting a link removes its map; a server leaving removes every link it is in, on either side', async () => {
  const one = await createLink(link());
  const two = await createLink(
    link({
      guildA: D2,
      channelA: CH.d2,
      channelB: CH.f2,
      hookA: { id: 'p', token: 'p' },
      hookB: { id: 'q', token: 'q' },
    })
  );
  await saveMapping(one, 'a', { sourceId: 'm1', copyId: 'c1' });
  await saveMapping(two, 'a', { sourceId: 'm2', copyId: 'c2' });
  await createCode({ guildId: F, channelId: CH.f1 });

  assert.equal(await deleteLink(one), 1);
  assert.equal(await mappingOf(one, 'a', 'm1'), null);
  assert.ok(await mappingOf(two, 'a', 'm2'), 'the other link keeps its map');

  const one2 = await createLink(link());
  await saveMapping(one2, 'a', { sourceId: 'm3', copyId: 'c3' });
  assert.equal(await purgeBridgeGuild(F), 2, 'F is on the b side of both links');
  assert.equal(await getLink(one2), null);
  assert.equal(await getLink(two), null);
  assert.equal(await mappingOf(one2, 'a', 'm3'), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_messages').get().n, 0);

  // purgeGuild does the same, and clears the unaccepted requests of the server too
  const three = await createLink(link());
  await purgeGuild(D);
  assert.equal(await getLink(three), null);
  await createCode({ guildId: D, channelId: CH.d1 });
  await purgeGuild(D);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_codes WHERE guild_id = ?').get(D).n, 0);
});

test('a webhook token is stored sealed and read back whole; a legacy plain value and an unreadable one are handled', async () => {
  const { seal } = await import('../src/lib/seal.js');
  const id = await createLink(link());
  const row = db.prepare('SELECT hook_a_token, hook_b_token FROM bridge_links WHERE id = ?').get(id);
  for (const [stored, token] of [
    [row.hook_a_token, 'secret-a'],
    [row.hook_b_token, 'secret-b'],
  ]) {
    assert.ok(stored.startsWith('v1.'));
    assert.ok(!stored.includes(token), 'the plain token is not in the column');
  }
  const read = await getLink(id);
  assert.deepEqual([read.hookAToken, read.hookBToken], ['secret-a', 'secret-b']);

  await setLinkHook(id, 'a', { id: 'hook-new', token: 'rotated' });
  assert.ok(
    db.prepare('SELECT hook_a_token FROM bridge_links WHERE id = ?').get(id).hook_a_token.startsWith('v1.')
  );
  assert.equal((await getLink(id)).hookAToken, 'rotated');

  db.prepare('UPDATE bridge_links SET hook_a_token = ? WHERE id = ?').run('legacy-plain-token', id);
  assert.equal(
    (await getLink(id)).hookAToken,
    'legacy-plain-token',
    'a value from before sealing reads as it is'
  );
  assert.ok(
    db.prepare('SELECT hook_a_token FROM bridge_links WHERE id = ?').get(id).hook_a_token.startsWith('v1.'),
    'and is sealed in place by that first read'
  );
  assert.equal((await getLink(id)).hookAToken, 'legacy-plain-token', 'and still reads whole once sealed');
  db.prepare('UPDATE bridge_links SET hook_a_token = ? WHERE id = ?').run(
    seal('some other secret', 'bridge-webhook', 'x'),
    id
  );
  assert.equal((await getLink(id)).hookAToken, '', 'sealed with another secret: empty, not a crash');
  db.prepare('UPDATE bridge_links SET hook_a_token = ? WHERE id = ?').run(
    seal(process.env.SESSION_SECRET ?? 'x', 'pigeon-credential', 'x'),
    id
  );
  assert.equal((await getLink(id)).hookAToken, '', 'another purpose never opens it');
});

test('the shared seal helper keeps the Pigeon credential format (v1.iv.tag.data) and rejects damage', async () => {
  const { seal, open, isSealed } = await import('../src/lib/seal.js');
  const sealed = seal('secret', 'pigeon-credential', 'credential');
  assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(isSealed(sealed) && !isSealed('plain') && !isSealed(null));
  assert.equal(open('secret', 'pigeon-credential', sealed), 'credential');
  assert.equal(open('other', 'pigeon-credential', sealed), null);
  assert.equal(open('secret', 'bridge-webhook', sealed), null);
  assert.equal(open('secret', 'pigeon-credential', `${sealed}x`), null);
  assert.equal(open('secret', 'pigeon-credential', 'v1.a.b'), null);
});

test('plain tokens are sealed on first read through every way a link is read', async () => {
  const id = await createLink(link());
  const plain = (column, value) =>
    db.prepare(`UPDATE bridge_links SET ${column} = ? WHERE id = ?`).run(value, id);
  const stored = (column) => db.prepare(`SELECT ${column} AS v FROM bridge_links WHERE id = ?`).get(id).v;
  plain('hook_a_token', 'plain-a');
  plain('hook_b_token', 'plain-b');
  const [found] = await linksOfGuild(D);
  assert.deepEqual([found.hookAToken, found.hookBToken], ['plain-a', 'plain-b']);
  assert.ok(stored('hook_a_token').startsWith('v1.') && stored('hook_b_token').startsWith('v1.'));
  plain('hook_a_token', 'plain-again');
  assert.equal((await linkForChannel(D, CH.d1)).link.hookAToken, 'plain-again');
  assert.ok(stored('hook_a_token').startsWith('v1.'));
  plain('hook_b_token', 'plain-hook');
  assert.equal((await linkForHook('hook-b')).hookBToken, 'plain-hook');
  assert.ok(stored('hook_b_token').startsWith('v1.'));
});

test('the owners of both servers are recorded with the link, and a code remembers who asked', async () => {
  const { setLinkOwner } = await import('../src/db/bridge.js');
  const id = await createLink(link({ ownerA: 'owner-1', ownerB: 'owner-2' }));
  let row = await getLink(id);
  assert.deepEqual([row.ownerA, row.ownerB], ['owner-1', 'owner-2']);
  await setLinkOwner(id, 'b', 'owner-3');
  row = await getLink(id);
  assert.deepEqual([row.ownerA, row.ownerB], ['owner-1', 'owner-3']);
  const made = await createCode({ guildId: D, channelId: CH.d2, guildOwner: 'owner-1' });
  assert.equal((await peekCode(made.code)).guildOwner, 'owner-1');
  assert.equal((await claimCode(made.code)).guildOwner, 'owner-1');
});
