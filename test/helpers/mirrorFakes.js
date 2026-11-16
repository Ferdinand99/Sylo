// Doubles for the server mirror tests: a Discord server in the shape of discord.js (read by snapshot.js), and a
// Fluxer server with the adapter the engine writes through (target.js), which records every call it gets.
import { createEngine } from '../../src/mirror/engine.js';
import { rolesAbove } from '../../src/mirror/target.js';

export const SRC = '900000000000000301';
export const DST_RAW = '800000000000000001';
export const DST = `fluxer:${DST_RAW}`;
/** Sylo's own role on a fake Fluxer server: older than anything the mirror makes. */
export const SYLO_ROLE = '810000000000000000';

let seq = 700000000000000000n;
export const nextId = () => String(++seq);

const flag = (n) => 1n << BigInt(n);
export const BIT = {
  ViewChannel: flag(10),
  SendMessages: flag(11),
  ManageMessages: flag(13),
  ManageEvents: flag(33),
  ManageRoles: flag(28),
  Administrator: flag(3),
  CreatePublicThreads: flag(35),
};

/** A Discord channel as discord.js shapes it. */
export function dChannel(over) {
  const id = over.id ?? nextId();
  const overwrites = new Map(
    (over.overwrites ?? []).map((o) => [
      o.id,
      { ...o, allow: { bitfield: o.allow ?? 0n }, deny: { bitfield: o.deny ?? 0n } },
    ])
  );
  const rest = { ...over };
  delete rest.overwrites;
  return {
    id,
    name: 'channel',
    type: 0,
    parentId: null,
    rawPosition: 0,
    topic: null,
    nsfw: false,
    rateLimitPerUser: 0,
    isThread: () => false,
    permissionOverwrites: { cache: overwrites },
    ...rest,
  };
}

export const dRole = (over) => ({
  id: over.id ?? nextId(),
  name: 'role',
  color: 0,
  rawPosition: 1,
  hoist: false,
  mentionable: false,
  managed: false,
  permissions: { bitfield: 0n },
  ...over,
  ...(over.permissions !== undefined ? { permissions: { bitfield: over.permissions } } : {}),
});

/** A Discord server. `channels`, `roles`, `emojis` and `stickers` are plain arrays of the shapes above. */
export function fakeDiscord({
  ownerId = 'discord-owner',
  id = SRC,
  name = 'Source',
  channels = [],
  roles = [],
  emojis = [],
  stickers = [],
  // What @everyone can do server-wide: by default what a new Discord server gives it.
  everyonePermissions = flag(10) | flag(11) | flag(16),
} = {}) {
  const everyone = dRole({ id, name: '@everyone', rawPosition: 0, permissions: everyonePermissions });
  const guild = {
    id,
    name,
    ownerId,
    icon: null,
    banner: null,
    iconURL: () => guild._icon ?? null,
    bannerURL: () => guild._banner ?? null,
    roles: { cache: new Map([everyone, ...roles].map((r) => [r.id, r])), everyone },
    channels: { cache: new Map(channels.map((c) => [c.id, c])) },
    emojis: { cache: new Map(emojis.map((e) => [e.id, e])) },
    stickers: { cache: new Map(stickers.map((s) => [s.id, s])) },
  };
  return guild;
}

/**
 * A Fluxer server and the adapter for it. The adapter keeps the state in the guild's maps and records each
 * call in `calls` as { op, ... }. `failOn(op, errorOrFn)` makes the next call of an operation fail.
 */
export function fakeFluxer({
  id = DST_RAW,
  name = 'Target',
  existingChannels = [],
  missing = [],
  // The roles that already exist on the server, as Fluxer numbers them: { id, name, position }. A new server has only
  // Sylo's own role, at position 1 (every role starts at position 1 on Fluxer; positions change only when reordered).
  extraRoles = [],
  syloPosition = 1,
  emojiLimit = null,
  ownerId = 'fluxer-owner',
  clock = null,
} = {}) {
  const calls = [];
  const afterFailures = new Map();
  // Fluxer ids carry their creation time, like the real ones (the engine adopts only what was made recently).
  let minted = 0n;
  const mint = () => (clock ? String(((BigInt(clock.now) - 1420070400000n) << 22n) + ++minted) : nextId());
  const failures = new Map();
  const guild = {
    id,
    name,
    ownerId,
    channels: new Map(existingChannels.map((c) => [c.id, c])),
    roles: new Map([
      [id, { id, name: '@everyone', position: 0, _permissions: String(flag(53) | flag(10)), managed: false }],
      [SYLO_ROLE, { id: SYLO_ROLE, name: 'Sylo', position: syloPosition, _permissions: '8', managed: true }],
      ...extraRoles.map((r) => [r.id, { _permissions: '0', managed: false, ...r }]),
    ]),
    emojis: new Map(),
    stickers: new Map(),
  };
  const fail = (op) => {
    const f = failures.get(op) ?? failures.get('*');
    if (!f) return;
    const err = typeof f.error === 'function' ? f.error(calls) : f.error;
    if (f.times != null) {
      f.times -= 1;
      if (f.times <= 0) failures.delete(failures.has(op) ? op : '*');
    }
    if (err) throw err;
  };
  const attempted = [];
  // A call counts when it succeeds: `begin` is where a failure injected with failOn() is thrown.
  const begin = (op) => {
    attempted.push(op);
    fail(op);
  };
  const done = (op, data = {}) => calls.push({ op, ...data });
  const gone = (what) => Object.assign(new Error(`Unknown ${what}`), { statusCode: 404 });
  const target = {
    id,
    name,
    limits: () => ({
      emoji: emojiLimit ?? 50,
      stickers: 50,
      emojiBytes: 512 * 1024,
      stickerBytes: 512 * 1024,
      channelName: 100,
      roleName: 100,
      topic: 1024,
      bitrateMin: 8000,
      bitrateMax: 96000,
    }),
    missingPermissions: () => missing,
    // The roles that rank above Sylo's own (Fluxer's order: position, then the older id), like the real adapter.
    rolesAboveSylo: (ignore = []) =>
      rolesAbove(guild.roles.get(SYLO_ROLE), [...guild.roles.values()], new Set([id, ...ignore])),
    listChannels: () =>
      [...guild.channels.values()].map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        parentId: c.parentId ?? null,
      })),
    listRoles: () =>
      [...guild.roles.values()].map((r) => ({
        id: r.id,
        name: r.name,
        managed: Boolean(r.managed),
        position: r.position,
      })),
    listEmojis: () => [...guild.emojis.values()],
    listStickers: () => [...guild.stickers.values()],
    async editGuild(body) {
      begin('editGuild');
      if (body.name) guild.name = body.name;
      done('editGuild', { body });
    },
    async createRole(spec) {
      begin('createRole');
      const rid = mint();
      guild.roles.set(rid, { id: rid, name: spec.name, position: 1, _permissions: spec.permissions });
      done('createRole', { spec, id: rid });
      const after = afterFailures.get('createRole');
      if (after) {
        afterFailures.delete('createRole');
        throw Object.assign(after, { createdId: rid });
      }
      return rid;
    },
    async editRole(rid, spec) {
      begin('editRole');
      const r = guild.roles.get(rid);
      if (!r) throw gone('role');
      Object.assign(r, { _permissions: spec.permissions, ...(spec.name ? { name: spec.name } : {}) });
      done('editRole', { id: rid, spec });
    },
    async deleteRole(rid) {
      begin('deleteRole');
      if (!guild.roles.delete(rid)) throw gone('role');
      done('deleteRole', { id: rid });
    },
    // Like Fluxer: only the roles below Sylo's own are rearranged, into the slots they already hold, by the positions
    // sent (ties keep their order); then every role is renumbered. Sylo's role never moves.
    async setRolePositions(updates) {
      begin('setRolePositions');
      const older = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1);
      const current = [...guild.roles.values()]
        .filter((r) => r.id !== id)
        .sort((a, b) => b.position - a.position || older(a, b));
      const sylo = current.findIndex((r) => r.id === SYLO_ROLE);
      const explicit = new Map(updates.map((u) => [u.id, u.position]));
      const slots = current.map((_, i) => i).filter((i) => i > sylo);
      const movable = slots
        .map((i) => ({ role: current[i], i }))
        .sort(
          (a, b) =>
            (explicit.get(b.role.id) ?? b.role.position) - (explicit.get(a.role.id) ?? a.role.position) ||
            a.i - b.i
        );
      const order = [...current];
      slots.forEach((slot, k) => {
        order[slot] = movable[k].role;
      });
      order.forEach((r, i) => {
        r.position = order.length - i;
      });
      done('setRolePositions', { updates });
    },
    async createChannel(spec) {
      begin('createChannel');
      const cid = mint();
      guild.channels.set(cid, {
        id: cid,
        name: spec.name,
        type: spec.type,
        parentId: spec.parentId ?? null,
        position: 0,
      });
      done('createChannel', { spec, id: cid });
      return cid;
    },
    async editChannel(cid, spec) {
      begin('editChannel');
      const c = guild.channels.get(cid);
      if (!c) throw gone('channel');
      Object.assign(c, { name: spec.name, parentId: spec.parentId ?? null });
      done('editChannel', { id: cid, spec });
    },
    async deleteChannel(cid) {
      begin('deleteChannel');
      if (!guild.channels.delete(cid)) throw gone('channel');
      done('deleteChannel', { id: cid });
    },
    async setChannelPositions(updates) {
      begin('setChannelPositions');
      done('setChannelPositions', { updates });
    },
    async createEmoji({ name, image }) {
      begin('createEmoji');
      const eid = mint();
      guild.emojis.set(eid, { id: eid, name });
      done('createEmoji', { name, bytes: image.bytes.length, id: eid });
      return eid;
    },
    async editEmoji(eid, { name }) {
      begin('editEmoji');
      guild.emojis.get(eid).name = name;
      done('editEmoji', { id: eid, name });
    },
    async deleteEmoji(eid) {
      begin('deleteEmoji');
      guild.emojis.delete(eid);
      done('deleteEmoji', { id: eid });
    },
    async createSticker(spec) {
      begin('createSticker');
      const sid = mint();
      guild.stickers.set(sid, { id: sid, name: spec.name });
      done('createSticker', { name: spec.name, id: sid });
      return sid;
    },
    async editSticker(sid, spec) {
      begin('editSticker');
      done('editSticker', { id: sid, name: spec.name });
    },
    async deleteSticker(sid) {
      begin('deleteSticker');
      guild.stickers.delete(sid);
      done('deleteSticker', { id: sid });
    },
  };
  return {
    guild,
    target,
    calls,
    attempted,
    failOn: (op, error, times = 1) => failures.set(op, { error, times }),
    clearFailures: () => failures.clear(),
    // The next create succeeds on Fluxer and then fails (a second call after the create), carrying the new id.
    failAfterCreate: (op, error) => afterFailures.set(op, error),
    ops: (op) => calls.filter((c) => c.op === op),
  };
}

/** A fake clock and a sleep that moves it, so spacing and backoff are checked without waiting. */
export function fakeClock(start = 1_800_000_000_000) {
  const clock = { now: start, slept: [] };
  clock.fn = () => clock.now;
  clock.sleep = async (ms) => {
    clock.slept.push(ms);
    clock.now += ms;
  };
  return clock;
}

/** An engine wired to the fakes. */
export function engineFor({ discord, fluxer, clock = fakeClock(), images = true, ...rest }) {
  const fetched = [];
  const engine = createEngine({
    now: clock.fn,
    sleep: clock.sleep,
    minIntervalMs: 10,
    backoffBaseMs: 100,
    sourceGuild: (key) => (key === discord.id ? discord : undefined),
    targetGuild: (key) => (key === `fluxer:${fluxer.guild.id}` ? fluxer.guild : undefined),
    makeTarget: () => fluxer.target,
    clientsReady: () => true,
    enforceOwnership: () => false,
    fetchImage: async (url, { maxBytes }) => {
      fetched.push(url);
      if (!images) throw new Error('no network in tests');
      const size = /big/.test(url) ? maxBytes + 1 : 64;
      if (size > maxBytes) throw new Error(`Response too large (over ${maxBytes} bytes)`);
      return { bytes: Buffer.alloc(size, 1), mime: 'image/png' };
    },
    ...rest,
  });
  return { engine, fetched, clock };
}
