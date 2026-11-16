// What the mirror sends for each thing (src/mirror/spec.js): channels with their permission overwrites, roles, the
// settings remap, and the placeholders that keep a spec free of Fluxer ids until the moment it is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlags } from '@fluxerjs/core';
import { snapshotDiscordGuild } from '../src/mirror/snapshot.js';
import {
  buildChannelSpec,
  buildRoleSpec,
  buildStickerSpec,
  emojiName,
  normaliseOptions,
  placeholderConfig,
  refsIn,
  resolveSpec,
  specHash,
} from '../src/mirror/spec.js';
import { BIT, SRC, dChannel, dRole, fakeDiscord } from './helpers/mirrorFakes.js';

const MEMBER_ROLE = '710000000000000001';
const BOT_ROLE = '710000000000000002';
const CAT = '710000000000000010';
const TEXT = '710000000000000011';
const VOICE = '710000000000000012';

function server() {
  return fakeDiscord({
    roles: [
      dRole({
        id: MEMBER_ROLE,
        name: 'Member',
        rawPosition: 1,
        permissions: BIT.ViewChannel | BIT.SendMessages | BIT.ManageEvents,
      }),
      dRole({ id: BOT_ROLE, name: 'Some bot', rawPosition: 2, managed: true }),
    ],
    channels: [
      dChannel({ id: CAT, name: 'Info', type: 4, rawPosition: 0 }),
      dChannel({
        id: TEXT,
        name: 'rules',
        type: 0,
        parentId: CAT,
        rawPosition: 1,
        topic: 'Read these',
        nsfw: true,
        rateLimitPerUser: 30,
        overwrites: [
          { id: SRC, type: 0, deny: BIT.SendMessages | BIT.ManageEvents },
          { id: MEMBER_ROLE, type: 0, allow: BIT.ViewChannel },
          { id: BOT_ROLE, type: 0, allow: BIT.ViewChannel },
          { id: '720000000000000001', type: 1, allow: BIT.ViewChannel },
        ],
      }),
      dChannel({ id: VOICE, name: 'Lounge', type: 2, bitrate: 1_000_000, userLimit: 5 }),
    ],
  });
}

const snap = () => snapshotDiscordGuild(server());
const ctxOf = (source) => ({ source, copiedRoles: new Set([MEMBER_ROLE]) });

test('a text channel keeps every property and its overwrites, with ids as placeholders', () => {
  const source = snap();
  const { spec, notes } = buildChannelSpec(
    source.channels.find((c) => c.id === TEXT),
    ctxOf(source)
  );
  const { permissionOverwrites, ...rest } = spec;
  assert.deepEqual(rest, {
    name: 'rules',
    type: 0,
    parentId: `$channel:${CAT}`,
    topic: 'Read these',
    nsfw: true,
    rateLimitPerUser: 30,
  });
  assert.deepEqual(permissionOverwrites, [
    { id: `$role:${MEMBER_ROLE}`, type: 0, allow: String(PermissionFlags.ViewChannel), deny: '0' },
    { id: '$role:everyone', type: 0, allow: '0', deny: String(PermissionFlags.SendMessages) },
  ]);
  const codes = notes.map((n) => n.code).sort();
  assert.deepEqual(codes, ['member-overwrite-dropped', 'overwrite-role-not-copied', 'permissions-dropped']);
  assert.match(notes.find((n) => n.code === 'permissions-dropped').message, /Manage Events/);
});

test('voice and category channels carry what they have; a bitrate stays inside Fluxer limits', () => {
  const source = snap();
  const voice = buildChannelSpec(
    source.channels.find((c) => c.id === VOICE),
    ctxOf(source)
  ).spec;
  assert.deepEqual([voice.type, voice.bitrate, voice.userLimit, voice.parentId], [2, 96000, 5, null]);
  const cat = buildChannelSpec(
    source.channels.find((c) => c.id === CAT),
    ctxOf(source)
  ).spec;
  assert.deepEqual(cat, { name: 'Info', type: 4, parentId: null, permissionOverwrites: [] });
});

test('a stage channel becomes voice with a note; a channel type Fluxer lacks is not copied', () => {
  const source = snapshotDiscordGuild(
    fakeDiscord({
      channels: [
        dChannel({ id: '710000000000000020', name: 'Stage', type: 13 }),
        dChannel({ id: '710000000000000021', name: 'Dir', type: 14 }),
      ],
    })
  );
  const stage = buildChannelSpec(source.channels[0], { source, copiedRoles: new Set() });
  assert.equal(stage.spec.type, 2);
  assert.deepEqual(
    stage.notes.map((n) => n.code),
    ['stage-as-voice']
  );
  const dir = buildChannelSpec(source.channels[1], { source, copiedRoles: new Set() });
  assert.equal(dir.spec, null);
  assert.deepEqual(
    dir.notes.map((n) => n.code),
    ['channel-type-unsupported']
  );
});

test('a channel @everyone cannot see on Discord is hidden from @everyone on Fluxer, whatever else is copied', () => {
  const hidden = fakeDiscord({
    everyonePermissions: 0n,
    roles: [dRole({ id: MEMBER_ROLE, name: 'Member', rawPosition: 1, permissions: BIT.ViewChannel })],
    channels: [
      dChannel({
        id: TEXT,
        name: 'staff',
        overwrites: [{ id: MEMBER_ROLE, type: 0, allow: BIT.ViewChannel }],
      }),
      dChannel({ id: VOICE, name: 'staff-voice', type: 2 }),
      dChannel({
        id: CAT,
        name: 'open',
        type: 0,
        overwrites: [{ id: SRC, type: 0, allow: BIT.ViewChannel }],
      }),
    ],
  });
  const source = snapshotDiscordGuild(hidden);
  const byId = (id) => source.channels.find((c) => c.id === id);
  assert.deepEqual([byId(TEXT).everyoneCanView, byId(CAT).everyoneCanView], [false, true]);
  for (const copied of [new Set([MEMBER_ROLE]), new Set()]) {
    // with roles copied, and with roles off: the private channel is private either way
    const staff = buildChannelSpec(byId(TEXT), { source, copiedRoles: copied }).spec;
    const own = staff.permissionOverwrites.find((o) => o.id === '$role:everyone');
    assert.equal(BigInt(own.deny) & (1n << 10n), 1n << 10n, 'View Channel is denied to @everyone');
    const voice = buildChannelSpec(byId(VOICE), { source, copiedRoles: copied }).spec;
    const vown = voice.permissionOverwrites.find((o) => o.id === '$role:everyone');
    assert.equal(BigInt(vown.deny), (1n << 10n) | (1n << 20n), 'and Connect, for a voice channel');
    const open = buildChannelSpec(byId(CAT), { source, copiedRoles: copied }).spec;
    const openOwn = open.permissionOverwrites.find((o) => o.id === '$role:everyone');
    assert.equal(BigInt(openOwn.deny) & (1n << 10n), 0n, 'an open channel stays open');
  }
});

test('an explicit @everyone overwrite keeps its other bits when the channel is hidden', () => {
  const source = snapshotDiscordGuild(
    fakeDiscord({
      everyonePermissions: 0n,
      channels: [
        dChannel({ id: TEXT, name: 'x', overwrites: [{ id: SRC, type: 0, allow: BIT.SendMessages }] }),
      ],
    })
  );
  const { spec } = buildChannelSpec(source.channels[0], { source, copiedRoles: new Set() });
  const own = spec.permissionOverwrites.find((o) => o.id === '$role:everyone');
  assert.equal(BigInt(own.deny), 1n << 10n);
  assert.equal(BigInt(own.allow), BIT.SendMessages);
});

test('Administrator on @everyone sees everything; a server marked age-restricted gives its channels the flag', () => {
  const open = snapshotDiscordGuild(
    fakeDiscord({ everyonePermissions: BIT.Administrator, channels: [dChannel({ id: TEXT, name: 'a' })] })
  );
  assert.equal(open.channels[0].everyoneCanView, true);
  const g = fakeDiscord({
    channels: [dChannel({ id: TEXT, name: 'a' }), dChannel({ id: VOICE, name: 'v', type: 2 })],
  });
  g.nsfwLevel = 3;
  const source = snapshotDiscordGuild(g);
  assert.equal(source.ageRestricted, true);
  assert.equal(buildChannelSpec(source.channels[0], { source, copiedRoles: new Set() }).spec.nsfw, true);
});

test('@everyone never receives powerful permissions on Fluxer', () => {
  const source = snapshotDiscordGuild(
    fakeDiscord({ everyonePermissions: BIT.Administrator | BIT.ViewChannel })
  );
  const everyone = source.roles.find((r) => r.isEveryone);
  const { spec, notes } = buildRoleSpec(everyone);
  assert.equal(BigInt(spec.permissions), PermissionFlags.ViewChannel);
  assert.ok(notes.some((n) => n.code === 'everyone-elevated-stripped'));
});

test('a thread permission deny is carried to Fluxer', () => {
  const source = snapshotDiscordGuild(
    fakeDiscord({
      channels: [
        dChannel({ id: TEXT, name: 'a', overwrites: [{ id: SRC, type: 0, deny: BIT.CreatePublicThreads }] }),
      ],
    })
  );
  const { spec, notes } = buildChannelSpec(source.channels[0], { source, copiedRoles: new Set() });
  assert.equal(BigInt(spec.permissionOverwrites[0].deny), 1n << 35n);
  assert.equal(
    notes.some((n) => n.code === 'permissions-dropped'),
    false
  );
});

test('a sticker without a description sends none, as Fluxer wants 1 to 500 characters or nothing', () => {
  const { spec } = buildStickerSpec({ id: '1', name: 'plain', format: 1, tags: [], description: '' });
  assert.equal(spec.description, null);
});

test('threads are not read from the server', () => {
  const g = server();
  const id = '710000000000000030';
  g.channels.cache.set(id, dChannel({ id, name: 'a thread', type: 11, isThread: () => true }));
  assert.equal(snapshotDiscordGuild(g).channels.length, 3);
});

test('a role maps its permissions and reports what Fluxer lacks; Administrator is flagged', () => {
  const source = snap();
  const { spec, notes } = buildRoleSpec(source.roles.find((r) => r.id === MEMBER_ROLE));
  assert.equal(spec.permissions, String(PermissionFlags.ViewChannel | PermissionFlags.SendMessages));
  assert.deepEqual(
    notes.map((n) => n.code),
    ['permissions-dropped']
  );
  const admin = buildRoleSpec({ ...source.roles[1], id: '1', name: 'Admin', permissions: BIT.Administrator });
  assert.deepEqual(
    admin.notes.map((n) => n.code),
    ['administrator-role']
  );
});

test('@everyone only sets permissions, and keeps the Fluxer-only bits it already has', () => {
  const source = snap();
  const everyone = source.roles.find((r) => r.isEveryone);
  const { spec } = buildRoleSpec(
    { ...everyone, permissions: BIT.ViewChannel },
    { keep: PermissionFlags.UpdateRtcRegion }
  );
  assert.deepEqual(Object.keys(spec), ['permissions']);
  assert.equal(spec.permissions, String(PermissionFlags.ViewChannel | PermissionFlags.UpdateRtcRegion));
});

test('options: only known switches, only booleans, the rest on', () => {
  assert.deepEqual(normaliseOptions({ roles: false, emoji: 'no', bogus: true }), {
    name: true,
    icon: true,
    banner: true,
    roles: false,
    channels: true,
    emoji: true,
    stickers: true,
    modules: true,
    continuous: true,
    mirrorDeletes: false,
    mirrorDeletesRequested: false,
  });
  assert.equal(normaliseOptions(null).continuous, true);
});

test('emoji names are cleaned to what Fluxer takes; a Lottie sticker is not copied', () => {
  assert.equal(emojiName('party-time!'), 'party_time_');
  assert.equal(emojiName('a'), 'a_');
  assert.equal(emojiName('ok'), 'ok');
  assert.equal(buildStickerSpec({ id: '1', name: 'x', format: 3, tags: [], description: '' }).spec, null);
  assert.deepEqual(
    buildStickerSpec({ id: '1', name: 'wave', format: 1, tags: ['hi'], description: 'hello' }).spec,
    {
      name: 'wave',
      description: 'hello',
      tags: ['hi'],
    }
  );
});

test('the fingerprint ignores key order and changes with content', () => {
  assert.equal(specHash({ a: 1, b: [1, { c: 2, d: 3 }] }), specHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(specHash({ a: 1 }), specHash({ a: 2 }));
});

test('settings remap: copied ids become placeholders, dropped ones go, message ids are cleared', () => {
  const ids = {
    channels: new Set(['910000000000000001']),
    roles: new Set(['910000000000000002']),
    skippedChannels: new Set(['910000000000000003']),
    skippedRoles: new Set(['910000000000000004']),
  };
  const config = {
    channel: '910000000000000001',
    lost: '910000000000000003',
    roles: ['910000000000000002', '910000000000000004'],
    user: '123456789012345678',
    panelMessageId: '999999999999999999',
    text: 'see <#910000000000000001> and <@&910000000000000002> or <#910000000000000003>',
    nested: { deep: [{ channelId: '910000000000000001' }] },
    count: 5,
  };
  const out = placeholderConfig(config, ids);
  assert.equal(out.config.channel, '$channel:910000000000000001');
  assert.equal(out.config.lost, '');
  assert.deepEqual(out.config.roles, ['$role:910000000000000002']);
  assert.equal(out.config.user, '', 'an id of a person means nothing on Fluxer');
  assert.equal(out.config.panelMessageId, '');
  assert.equal(out.config.text, 'see <#$channel:910000000000000001> and <@&$role:910000000000000002> or ');
  assert.equal(out.config.nested.deep[0].channelId, '$channel:910000000000000001');
  assert.equal(out.config.count, 5);
  assert.deepEqual([out.remapped, out.dropped, out.cleared], [5, 3, 2]);
});

test('placeholders resolve to Fluxer ids; what cannot be resolved is dropped, and reported', () => {
  const spec = {
    parentId: '$channel:910000000000000001',
    permissionOverwrites: [
      { id: '$role:910000000000000002', type: 0 },
      { id: '$role:910000000000000009', type: 0 },
      { id: '$role:everyone', type: 0 },
    ],
    text: 'x <#$channel:910000000000000001> y',
    roles: ['$role:910000000000000002', '$role:910000000000000009'],
  };
  assert.deepEqual(refsIn(spec).sort(), [
    'channel:910000000000000001',
    'role:910000000000000002',
    'role:910000000000000009',
  ]);
  const ids = { 'channel:910000000000000001': 'F1', 'role:910000000000000002': 'F2', 'role:everyone': 'F0' };
  const { value, unresolved } = resolveSpec(spec, (kind, id) => ids[`${kind}:${id}`] ?? null);
  assert.equal(value.parentId, 'F1');
  assert.deepEqual(
    value.permissionOverwrites.map((o) => o.id),
    ['F2', null, 'F0']
  );
  assert.equal(value.text, 'x <#F1> y');
  assert.deepEqual(value.roles, ['F2']);
  assert.deepEqual(unresolved, ['role:910000000000000009', 'role:910000000000000009']);
});
