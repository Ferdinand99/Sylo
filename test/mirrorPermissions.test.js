// The Discord -> Fluxer permission table (src/mirror/permissions.js), checked bit by bit against the two
// libraries' own flag tables, so a renamed or renumbered permission cannot map silently wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { PermissionFlags } from '@fluxerjs/core';
import {
  ELEVATED_FLUXER_MASK,
  FLUXER_ONLY_BITS,
  PERMISSION_TABLE,
  describeDropped,
  fluxerBitOf,
  isElevated,
  keepFluxerOnly,
  lostSomething,
  mapPermissions,
} from '../src/mirror/permissions.js';

test('every row agrees with discord.js: the name has that bit', () => {
  for (const row of PERMISSION_TABLE) {
    assert.equal(PermissionFlagsBits[row.discord], 1n << BigInt(row.bit), `${row.discord} is bit ${row.bit}`);
  }
});

test('every Discord permission discord.js knows is in the table (a new one must be decided)', () => {
  // By bit: discord.js keeps a few old names (ManageEmojisAndStickers) for a bit that has a newer one.
  const inTable = new Set(PERMISSION_TABLE.map((r) => r.bit));
  const missing = Object.entries(PermissionFlagsBits)
    .filter(([, value]) => !inTable.has(Math.log2(Number(value))))
    .map(([name]) => name);
  assert.deepEqual(missing, [], `new Discord permissions to map or drop: ${missing.join(', ')}`);
});

// Fluxer's thread permissions (packages/constants ThreadPermissionUtils): the SDK's flag table does not list them yet.
const THREAD_BITS = {
  ManageThreads: 34n,
  CreatePublicThreads: 35n,
  CreatePrivateThreads: 36n,
  SendMessagesInThreads: 38n,
};

test('every mapped row lands on the Fluxer permission of that name and bit', () => {
  for (const row of PERMISSION_TABLE) {
    if (row.fluxer === null) continue;
    const sdk =
      PermissionFlags[row.fluxer] ?? (row.fluxer in THREAD_BITS ? 1n << THREAD_BITS[row.fluxer] : undefined);
    assert.ok(sdk !== undefined, `Fluxer has ${row.fluxer}`);
    assert.equal(sdk, 1n << BigInt(fluxerBitOf(row.fluxer)), `${row.fluxer}'s bit`);
    const { bits, dropped } = mapPermissions(1n << BigInt(row.bit));
    assert.equal(bits, sdk, `${row.discord} becomes ${row.fluxer}`);
    assert.deepEqual(dropped, []);
  }
});

test('the thread permissions are mapped, so a Discord deny of thread creation stays a deny', () => {
  for (const [name, bit] of Object.entries(THREAD_BITS)) {
    const row = PERMISSION_TABLE.find((r) => r.fluxer === name);
    assert.ok(row, name);
    assert.equal(BigInt(row.bit), bit);
    assert.equal(mapPermissions(1n << bit).bits, 1n << bit);
  }
});

test('powerful permissions are recognised, on Discord bits and on their Fluxer counterparts', () => {
  assert.ok(isElevated(1n << 3n), 'Administrator');
  assert.ok(isElevated(1n << 28n), 'Manage Roles');
  assert.ok(isElevated(1n << 34n), 'Manage Threads');
  assert.ok(!isElevated((1n << 10n) | (1n << 11n)), 'View Channel and Send Messages are not');
  assert.ok(ELEVATED_FLUXER_MASK & PermissionFlags.Administrator);
  assert.equal(ELEVATED_FLUXER_MASK & PermissionFlags.SendMessages, 0n);
  assert.equal(ELEVATED_FLUXER_MASK & FLUXER_ONLY_BITS, 0n);
});

test('a Discord permission with no Fluxer counterpart is dropped and named', () => {
  for (const row of PERMISSION_TABLE.filter((r) => r.fluxer === null)) {
    const m = mapPermissions(1n << BigInt(row.bit));
    assert.equal(m.bits, 0n, `${row.discord} maps to nothing`);
    assert.deepEqual(m.dropped, [row.label]);
  }
});

test('the Fluxer permissions the table never produces are exactly the Fluxer-only ones', () => {
  const produced = new Set(PERMISSION_TABLE.map((r) => r.fluxer).filter(Boolean));
  const unproduced = Object.keys(PermissionFlags).filter((n) => !produced.has(n));
  const only = unproduced.reduce((acc, n) => acc | PermissionFlags[n], 0n);
  assert.equal(only, FLUXER_ONLY_BITS);
});

test('a mixed bitfield maps bit by bit, and unknown high bits are reported', () => {
  const view = 1n << 10n;
  const send = 1n << 11n;
  const events = 1n << 33n; // Discord only
  const future = 1n << 60n; // not in the table
  const m = mapPermissions(view | send | events | future);
  assert.equal(m.bits, PermissionFlags.ViewChannel | PermissionFlags.SendMessages);
  assert.deepEqual(m.dropped, ['Manage Events']);
  assert.deepEqual(m.unknown, [60]);
  assert.ok(lostSomething(m));
  assert.equal(describeDropped(m), 'Manage Events, unknown permission (bit 60)');
  assert.equal(mapPermissions(0n).bits, 0n);
  assert.equal(lostSomething(mapPermissions(view)), false);
  assert.equal(mapPermissions('2048').bits, PermissionFlags.SendMessages, 'a string bitfield works too');
});

test('Administrator maps to Administrator, and Fluxer-only bits are carried over, not invented', () => {
  assert.equal(mapPermissions(1n << 3n).bits, PermissionFlags.Administrator);
  assert.equal(
    mapPermissions((1n << 53n) - 1n).bits & FLUXER_ONLY_BITS,
    0n,
    'no Discord bit turns into a Fluxer-only one'
  );
  assert.equal(
    keepFluxerOnly(PermissionFlags.UpdateRtcRegion | PermissionFlags.SendMessages),
    PermissionFlags.UpdateRtcRegion
  );
  assert.equal(keepFluxerOnly(null), 0n);
});
