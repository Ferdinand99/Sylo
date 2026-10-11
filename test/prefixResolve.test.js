import test from 'node:test';
import assert from 'node:assert/strict';
import { ParseError } from '../src/bot/framework/parser.js';
import { resolveOptions } from '../src/bot/framework/resolve.js';

const UID = '111111111111111111';
const CID = '222222222222222222';
const RID = '333333333333333333';

function fakes({ memberInGuild = true } = {}) {
  const user = { id: UID, tag: 'a#1' };
  const member = { id: UID, user };
  const channel = { id: CID, name: 'general' };
  const role = { id: RID, name: 'Mod' };
  const client = {
    users: { cache: new Map(), fetch: async (id) => (id === UID ? user : Promise.reject(new Error('no'))) },
  };
  const guild = {
    members: {
      cache: new Map(),
      fetch: async (id) => (memberInGuild && id === UID ? member : Promise.reject(new Error('no'))),
    },
    channels: { cache: new Map([[CID, channel]]) }, // no fetch(): the Fluxer SDK has none
    roles: { cache: new Map([[RID, role]]) },
  };
  return { user, member, channel, role, client, guild };
}

const v = (type, value) => ({ type, value });

test('a user mention or raw id resolves to the user and, when present, the guild member', async () => {
  const { user, member, client, guild } = fakes();
  const r = await resolveOptions(
    { a: v(6, `<@${UID}>`), b: v(6, `<@!${UID}>`), c: v(6, UID) },
    { client, guild }
  );
  for (const k of ['a', 'b', 'c']) assert.deepEqual(r[k], { user, member });
});

test('a user who is not in the guild resolves with a null member', async () => {
  const { user, client, guild } = fakes({ memberInGuild: false });
  const r = await resolveOptions({ a: v(6, UID) }, { client, guild });
  assert.deepEqual(r.a, { user, member: null });
});

test('channels and roles resolve from mention or id, using the cache when there is no fetch()', async () => {
  const { channel, role, client, guild } = fakes();
  const r = await resolveOptions(
    { c: v(7, `<#${CID}>`), c2: v(7, CID), r: v(8, `<@&${RID}>`), r2: v(8, RID) },
    { client, guild }
  );
  assert.equal(r.c, channel);
  assert.equal(r.c2, channel);
  assert.equal(r.r, role);
  assert.equal(r.r2, role);
});

test('scalar values are ignored', async () => {
  const { client, guild } = fakes();
  assert.deepEqual(await resolveOptions({ n: v(4, 5), s: v(3, 'x') }, { client, guild }), {});
});

test('an unknown or malformed reference is a ParseError naming the option', async () => {
  const { client, guild } = fakes();
  for (const bad of [
    { who: v(6, '<@999999999999999999>') },
    { who: v(6, 'bob') },
    { where: v(7, '<#999999999999999999>') },
    { what: v(8, 'Mod') },
  ]) {
    await assert.rejects(
      resolveOptions(bad, { client, guild }),
      (e) => e instanceof ParseError && /who|where|what/.test(e.message)
    );
  }
});
