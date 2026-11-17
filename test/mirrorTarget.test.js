// The Fluxer adapter (src/mirror/target.js) against a double with the SDK's method names: what it passes to the
// SDK (bigint permissions, data URIs, the overwrites) and how a thing that is gone shows up (a 404).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFluxerTarget, rolesAbove, toDataUri } from '../src/mirror/target.js';
import { classifyError, isNotFound } from '../src/mirror/errors.js';
import { snapshotFluxerGuild } from '../src/mirror/snapshot.js';

function sdkGuild({ perms = [], admin = false, top = 7 } = {}) {
  const log = [];
  const entity = (kind, data) => ({
    ...data,
    edit: async (body) => log.push([`${kind}.edit`, data.id, body]),
    delete: async (arg) => log.push([`${kind}.delete`, data.id, arg]),
  });
  const guild = {
    id: '800000000000000050',
    name: 'Target',
    channels: new Map(),
    roles: new Map(),
    emojis: new Map(),
    stickers: new Map(),
    members: {
      me: {
        permissions: { has: (p) => admin || perms.includes(p) },
        roles: { highest: { id: '810000000000000000', position: top } },
      },
    },
    client: { channels: { fetch: async () => null } },
    createRole: async (body) => {
      log.push(['createRole', body]);
      const role = entity('role', { id: '810000000000000001', name: body.name, type: 'role' });
      guild.roles.set(role.id, role);
      return role;
    },
    createChannel: async (body) => {
      log.push(['createChannel', body]);
      const ch = entity('channel', { id: '820000000000000001', name: body.name, type: body.type });
      guild.channels.set(ch.id, ch);
      return ch;
    },
    createEmoji: async (body) => (
      log.push(['createEmoji', body]),
      entity('emoji', { id: '830000000000000001' })
    ),
    createSticker: async (body) => (
      log.push(['createSticker', body]),
      entity('sticker', { id: '840000000000000001' })
    ),
    setRolePositions: async (u) => log.push(['setRolePositions', u]),
    setChannelPositions: async (u) => log.push(['setChannelPositions', u]),
    edit: async (b) => log.push(['guild.edit', b]),
    fetchRole: async () => {
      throw Object.assign(new Error('Unknown Role'), { statusCode: 404 });
    },
    fetchEmoji: async () => {
      throw Object.assign(new Error('Unknown Emoji'), { code: 'EMOJI_NOT_FOUND' });
    },
  };
  return { guild, log };
}

test("Sylo's rank is compared with the roles on the server: position first, then the older id", () => {
  const { guild } = sdkGuild({ top: 1 });
  const add = (id, name, position) => guild.roles.set(id, { id, name, position });
  add('810000000000000000', 'Sylo', 1);
  add('810000000000000007', 'Newer', 1); // the same position but a newer id: ranks below Sylo
  add('800000000000000001', 'Older', 1); // the same position and older: ranks above
  add('820000000000000002', 'High', 4);
  const target = createFluxerTarget(guild);
  assert.deepEqual(
    target.rolesAboveSylo().map((r) => r.name),
    ['High', 'Older']
  );
  assert.deepEqual(
    target.rolesAboveSylo(['820000000000000002']).map((r) => r.name),
    ['Older'],
    "the mirror's own roles are ignored"
  );
  assert.deepEqual(rolesAbove({ id: '5', position: 3 }, [{ id: '9', name: 'x', position: 2 }]), []);
  delete guild.members.me.roles.highest;
  assert.equal(target.rolesAboveSylo(), null, "unknown when Sylo's own role cannot be read");
  assert.equal(createFluxerTarget({ id: '1' }).rolesAboveSylo(), null);
});

test('what Sylo needs on the Fluxer server: Administrator covers it, otherwise the four permissions', () => {
  assert.deepEqual(createFluxerTarget(sdkGuild({ admin: true }).guild).missingPermissions(), []);
  assert.deepEqual(
    createFluxerTarget(sdkGuild({ perms: ['ManageChannels', 'ManageGuild'] }).guild).missingPermissions(),
    ['ManageRoles', 'ManageExpressions']
  );
  assert.deepEqual(
    createFluxerTarget({ id: '1' }).missingPermissions(),
    [],
    'unknown rights are not a blocker'
  );
});

test('a role is made with bigint permissions; hoist and mentionable are set in a second call', async () => {
  const { guild, log } = sdkGuild();
  const target = createFluxerTarget(guild);
  const id = await target.createRole({
    name: 'Mod',
    color: 5,
    hoist: true,
    mentionable: false,
    permissions: '2048',
  });
  assert.equal(id, '810000000000000001');
  assert.deepEqual(log[0], ['createRole', { name: 'Mod', permissions: 2048n, color: 5 }]);
  assert.deepEqual(log[1], ['role.edit', id, { hoist: true, mentionable: false }]);
  await target.editRole(id, {
    name: 'Moderators',
    color: 6,
    hoist: false,
    mentionable: true,
    permissions: '1024',
  });
  assert.deepEqual(log.at(-1), [
    'role.edit',
    id,
    { permissions: 1024n, name: 'Moderators', color: 6, hoist: false, mentionable: true },
  ]);
  await target.editRole(id, { permissions: '8' });
  assert.deepEqual(log.at(-1), ['role.edit', id, { permissions: 8n }], '@everyone: permissions only');
  await target.deleteRole(id);
  assert.equal(log.at(-1)[0], 'role.delete');
  await assert.rejects(
    target.editRole('810000000000000099', { permissions: '1' }),
    (e) => classifyError(e).kind === 'gone'
  );
  await assert.rejects(target.deleteRole('810000000000000099'), (e) => classifyError(e).kind === 'gone');
});

test('a channel keeps its overwrites as bigint allow and deny; only text and announcement change type', async () => {
  const { guild, log } = sdkGuild();
  const target = createFluxerTarget(guild);
  const id = await target.createChannel({
    name: 'rules',
    type: 0,
    parentId: '820000000000000009',
    topic: 'Read these',
    permissionOverwrites: [{ id: '810000000000000001', type: 0, allow: '1024', deny: '2048' }],
  });
  assert.deepEqual(log[0][1].permissionOverwrites, [
    { id: '810000000000000001', type: 0, allow: 1024n, deny: 2048n },
  ]);
  assert.equal(log[0][1].parentId, '820000000000000009');
  await target.editChannel(id, { name: 'news', type: 5, topic: null, permissionOverwrites: [] });
  assert.deepEqual(log.at(-1), [
    'channel.edit',
    id,
    { type: 5, name: 'news', topic: null, permissionOverwrites: [] },
  ]);
  guild.channels.get(id).type = 2;
  await target.editChannel(id, { name: 'lounge', type: 2, userLimit: 3 });
  assert.deepEqual(
    log.at(-1),
    ['channel.edit', id, { name: 'lounge', userLimit: 3 }],
    'a voice channel never gets a type change'
  );
  await target.deleteChannel(id);
  assert.deepEqual(log.at(-1), ['channel.delete', id, { reason: 'Mirrored from the Discord server' }]);
  await assert.rejects(target.deleteChannel('820000000000000099'), (e) => classifyError(e).kind === 'gone');
  await target.setChannelPositions([{ id, position: 1, parentId: null }]);
  assert.equal(log.at(-1)[0], 'setChannelPositions');
});

test('emoji, stickers, positions and the server itself go through the SDK with data URIs', async () => {
  const { guild, log } = sdkGuild();
  const target = createFluxerTarget(guild);
  const image = { mime: 'image/png', bytes: Buffer.from([1, 2, 3]) };
  assert.equal(toDataUri(image), 'data:image/png;base64,AQID');
  assert.equal(await target.createEmoji({ name: 'party', image }), '830000000000000001');
  assert.deepEqual(log.at(-1), ['createEmoji', { name: 'party', image: 'data:image/png;base64,AQID' }]);
  assert.equal(
    await target.createSticker({ name: 'hi', description: 'Hello', tags: ['a'], image }),
    '840000000000000001'
  );
  assert.deepEqual(log.at(-1), [
    'createSticker',
    { name: 'hi', description: 'Hello', tags: ['a'], image: 'data:image/png;base64,AQID' },
  ]);
  await target.setRolePositions([{ id: '1', position: 2 }]);
  assert.deepEqual(log.at(-1), ['setRolePositions', [{ id: '1', position: 2 }]]);
  await target.editGuild({ name: 'New', icon: 'data:image/png;base64,AQID' });
  assert.deepEqual(log.at(-1), ['guild.edit', { name: 'New', icon: 'data:image/png;base64,AQID' }]);
  await assert.rejects(
    target.editEmoji('830000000000000099', { name: 'x' }),
    (e) => classifyError(e).kind === 'gone'
  );
});

test('the Fluxer server is read as plain data: its own @everyone and what is already there', () => {
  const { guild } = sdkGuild();
  guild.channels.set('1', { id: '1', name: 'general', type: 0, parentId: null, position: 0 });
  guild.roles.set(guild.id, {
    id: guild.id,
    name: '@everyone',
    position: 0,
    _permissions: String(1n << 53n),
  });
  guild.roles.set('2', { id: '2', name: 'Mod', position: 1, _permissions: '8', managed: false });
  const snap = snapshotFluxerGuild(guild);
  assert.deepEqual(
    snap.channels.map((c) => c.name),
    ['general']
  );
  assert.deepEqual(
    snap.roles.map((r) => [r.name, r.isEveryone, r.permissions]),
    [
      ['@everyone', true, 1n << 53n],
      ['Mod', false, 8n],
    ]
  );
  const target = createFluxerTarget(guild);
  assert.deepEqual(
    target.listChannels().map((c) => c.name),
    ['general']
  );
});

test('errors are told apart by what to do about them', () => {
  const kind = (err) => classifyError(err).kind;
  assert.equal(kind(Object.assign(new Error('x'), { statusCode: 429, retryAfter: 2.5 })), 'rate-limit');
  assert.equal(
    classifyError(Object.assign(new Error('x'), { statusCode: 429, retryAfter: 2.5 })).retryAfterMs,
    2500
  );
  assert.equal(
    classifyError(Object.assign(new Error('x'), { statusCode: 429, retryAfter: 0 })).retryAfterMs,
    1000,
    'never less than a second'
  );
  assert.equal(kind(Object.assign(new Error('x'), { statusCode: 403 })), 'permission');
  assert.equal(kind(Object.assign(new Error('x'), { statusCode: 401 })), 'permission');
  assert.equal(kind(Object.assign(new Error('x'), { statusCode: 404 })), 'gone');
  assert.equal(kind(Object.assign(new Error('x'), { statusCode: 503 })), 'transient');
  assert.equal(
    kind(Object.assign(new Error('Maximum number of roles reached'), { statusCode: 400 })),
    'limit'
  );
  assert.equal(kind(Object.assign(new Error('Invalid Form Body'), { statusCode: 400 })), 'item');
  assert.equal(kind(Object.assign(new Error('boom'), { code: 'ECONNRESET' })), 'transient');
  assert.equal(kind(Object.assign(new Error('x'), { cause: { code: 'UND_ERR_SOCKET' } })), 'transient');
  assert.equal(kind(new Error('fetch failed')), 'transient');
  assert.equal(kind(new Error('a bug')), 'item');
});

test('only a real not-found answer is "gone": a failed look-up is thrown, so nothing is made twice', async () => {
  const { guild } = sdkGuild();
  const target = createFluxerTarget(guild);
  const down = Object.assign(new Error('unavailable'), { statusCode: 503 });
  guild.fetchRole = async () => {
    throw down;
  };
  guild.client.channels.fetch = async () => {
    throw Object.assign(new Error('slow down'), { statusCode: 429, retryAfter: 1 });
  };
  guild.fetchEmoji = async () => {
    throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
  };
  await assert.rejects(target.editRole('810000000000000099', { permissions: '1' }), (e) => e === down);
  await assert.rejects(target.deleteRole('810000000000000099'), (e) => e === down);
  await assert.rejects(
    target.editChannel('820000000000000099', { name: 'x', type: 0 }),
    (e) => e.statusCode === 429
  );
  await assert.rejects(
    target.deleteChannel('820000000000000099'),
    (e) => classifyError(e).kind === 'rate-limit'
  );
  await assert.rejects(
    target.editEmoji('830000000000000099', { name: 'x' }),
    (e) => classifyError(e).kind === 'transient'
  );
});

test('a look-up with nothing to look up with is an error, not "gone"', async () => {
  const { guild } = sdkGuild();
  delete guild.fetchRole;
  const target = createFluxerTarget(guild);
  await assert.rejects(
    target.editRole('810000000000000099', { permissions: '1' }),
    (e) => classifyError(e).kind === 'item'
  );
});

test('a role whose second call fails is reported with its id, so it can be tracked', async () => {
  const { guild } = sdkGuild();
  const real = guild.createRole;
  guild.createRole = async (body) => {
    const role = await real(body);
    role.edit = async () => {
      throw Object.assign(new Error('unavailable'), { statusCode: 503 });
    };
    return role;
  };
  const target = createFluxerTarget(guild);
  await assert.rejects(
    target.createRole({ name: 'Mod', color: 0, hoist: true, mentionable: false, permissions: '0' }),
    (e) => e.createdId === '810000000000000001' && classifyError(e).kind === 'transient'
  );
});

test("the SDK's own codes: not-found codes are gone, Fluxer's limit codes are limits", () => {
  const kind = (err) => classifyError(err).kind;
  for (const code of ['ROLE_NOT_FOUND', 'CHANNEL_NOT_FOUND', 'EMOJI_NOT_FOUND', 'STICKER_NOT_FOUND']) {
    assert.equal(kind(Object.assign(new Error('x'), { code })), 'gone', code);
  }
  for (const code of ['MAX_EMOJIS', 'MAX_STICKERS', 'MAX_GUILD_ROLES', 'MAX_GUILD_CHANNELS']) {
    assert.equal(kind(Object.assign(new Error('refused'), { code, statusCode: 400 })), 'limit', code);
  }
  assert.equal(
    kind(Object.assign(new Error('x'), { statusCode: 429, code: 'ROLE_NOT_FOUND' })),
    'rate-limit'
  );
  assert.equal(isNotFound(Object.assign(new Error('x'), { cause: { statusCode: 404 } })), true);
  assert.equal(isNotFound(Object.assign(new Error('x'), { statusCode: 503 })), false);
});

test('a 5xx that only the SDK wrapper error carries in its cause is still retried, not failed', () => {
  const wrapped = Object.assign(new Error('Failed to fetch role'), { cause: { statusCode: 503 } });
  assert.equal(classifyError(wrapped).kind, 'transient');
  const limited = Object.assign(new Error('x'), { cause: { statusCode: 429 }, retryAfter: 2 });
  assert.equal(classifyError(limited).kind, 'rate-limit');
  assert.equal(
    classifyError(Object.assign(new Error('x'), { cause: { statusCode: 403 } })).kind,
    'permission'
  );
});
