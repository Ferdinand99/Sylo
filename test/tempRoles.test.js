// Temporary roles, the pure parts: the duration parser with its limits, the settings normaliser and
// LIMITS, who counts as staff, what Sylo itself may hand out, and the list line.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULE_LIMITS } from '../src/modules/limits.js';
import { LIMITS as CEILINGS } from '../src/lib/limits.js';
import {
  DEFAULT_DURATION,
  LIMITS,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  botRefusal,
  canManageTempRoles,
  describeTempRole,
  normaliseReason,
  normaliseTempRolesConfig,
  parseTempDuration,
} from '../src/modules/tempRoles.js';

const ROLE = '100000000000000700';
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const ms = (text) => {
  const r = parseTempDuration(text);
  assert.ok(r.ok, `${text}: ${r.error}`);
  return r.ms;
};
const refused = (text) => {
  const r = parseTempDuration(text);
  assert.equal(r.ok, false, `${text} should be refused`);
  return r.error;
};

test('LIMITS are served to the dashboard and match the brief', () => {
  assert.equal(MODULE_LIMITS['temp-roles'], LIMITS);
  assert.equal(LIMITS.reason.maxLength, 500);
  assert.equal(CEILINGS.tempRoles, 2000);
  assert.equal(MIN_DURATION_MS, MIN);
  assert.equal(MAX_DURATION_MS, 365 * DAY);
});

test('durations: minutes, hours, days, weeks and combinations', () => {
  assert.equal(ms('30m'), 30 * MIN);
  assert.equal(ms('12h'), 12 * HOUR);
  assert.equal(ms('7d'), 7 * DAY);
  assert.equal(ms('2w'), 14 * DAY);
  assert.equal(ms('1d12h'), 36 * HOUR);
  assert.equal(ms('1w2d3h4m'), 9 * DAY + 3 * HOUR + 4 * MIN);
  assert.equal(ms('90m'), 90 * MIN);
});

test('durations: case, spaces and the order of the parts do not matter', () => {
  assert.equal(ms('  7D '), 7 * DAY);
  assert.equal(ms('1d 12h'), 36 * HOUR);
  assert.equal(ms('12H1D'), 36 * HOUR);
  assert.equal(ms('0d1h'), HOUR, 'a zero part is fine when the total is long enough');
});

test('durations: the limits are 1 minute and 365 days, both inclusive', () => {
  assert.equal(ms('1m'), MIN);
  assert.match(refused('0m'), /1 minute/);
  assert.match(refused('0d0h'), /1 minute/);
  assert.equal(ms('365d'), 365 * DAY);
  assert.equal(ms('8760h'), 365 * DAY);
  assert.equal(ms('525600m'), 365 * DAY);
  assert.match(refused('366d'), /365 days/);
  assert.match(refused('8761h'), /365 days/);
  assert.match(refused('525601m'), /365 days/);
  assert.match(refused('53w'), /365 days/);
  assert.equal(ms('52w1d'), 365 * DAY);
});

test('durations: junk, bare numbers, seconds, repeats and huge numbers are refused with a hint', () => {
  const junk = ['', '   ', null, undefined, 'abc', '7', '10', 'd', '7x', '1.5h', '-1d', '+1d', '30s'];
  junk.push('1d1d', '7 days', '1d,2h', '1d-2h', '1dd');
  for (const bad of junk) {
    const msg = refused(bad);
    assert.match(msg, /30m|12h|7d|each unit|Give a duration/i, `${bad}: ${msg}`);
  }
  assert.match(refused('7'), /not a duration/);
  assert.match(refused('1d1d'), /each unit once/i);
  assert.match(refused(''), /Give a duration/);
  assert.match(refused('99999999999999999999d'), /not a duration/, 'more than six digits is no duration');
  assert.match(refused('999999w'), /365 days/);
});

test('the settings default to: no DM, no staff roles, seven days', () => {
  assert.deepEqual(normaliseTempRolesConfig({}), { staffRoles: [], dmMember: false, defaultDuration: '7d' });
  assert.deepEqual(normaliseTempRolesConfig(undefined), normaliseTempRolesConfig({}));
  assert.equal(DEFAULT_DURATION, '7d');
});

test('the settings keep valid values and drop junk', () => {
  const cfg = normaliseTempRolesConfig({
    staffRoles: [ROLE, 'junk', ROLE],
    dmMember: 1,
    defaultDuration: ' 1D 12H ',
  });
  assert.deepEqual(cfg, { staffRoles: [ROLE], dmMember: true, defaultDuration: '1d12h' });
  for (const bad of ['', 'x', '0m', '400d', '30s', 12, null, 'a'.repeat(500)]) {
    assert.equal(normaliseTempRolesConfig({ defaultDuration: bad }).defaultDuration, '7d', String(bad));
  }
  assert.equal(normaliseTempRolesConfig({ defaultDuration: '365d' }).defaultDuration, '365d');
});

test('staffRoles is cut at the limit and the reason at 500 characters', () => {
  const roles = (n) => Array.from({ length: n }, (_, i) => String(100000000000000000n + BigInt(i)));
  assert.equal(normaliseTempRolesConfig({ staffRoles: roles(25) }).staffRoles.length, 25);
  assert.equal(normaliseTempRolesConfig({ staffRoles: roles(26) }).staffRoles.length, 25);
  assert.equal(normaliseReason('x'.repeat(500)).length, 500);
  assert.equal(normaliseReason('x'.repeat(501)).length, 500);
  assert.equal(normaliseReason('  why  '), 'why');
  assert.equal(normaliseReason(null), '');
});

test('staff: Manage Roles, Administrator, or a staff role; Manage Server alone is not enough', () => {
  const perms = (...have) => ({ has: (p) => have.includes(p) });
  const member = (...roles) => ({ roles: { cache: new Map(roles.map((r) => [r, {}])) } });
  const cfg = { staffRoles: [ROLE] };
  assert.equal(canManageTempRoles(member(), perms('ManageRoles'), cfg), true);
  assert.equal(canManageTempRoles(member(), perms('Administrator'), cfg), true);
  assert.equal(canManageTempRoles(member(ROLE), perms(), cfg), true);
  assert.equal(canManageTempRoles(member('other'), perms(), cfg), false);
  assert.equal(canManageTempRoles(member(), perms('ManageGuild', 'ManageEvents'), cfg), false);
  assert.equal(canManageTempRoles(null, null, cfg), false);
  assert.equal(canManageTempRoles(member(ROLE), perms(), {}), false);
  const throwing = {
    has: () => {
      throw new Error('unknown permission');
    },
  };
  assert.equal(canManageTempRoles(member(), throwing, cfg), false);
});

test('Sylo refuses roles it cannot hand out: gone, @everyone, managed, above itself, no Manage Roles', () => {
  const GUILD_ID = '900000000000000999';
  const me = (position, manage = true) => ({
    permissions: { has: (p) => manage && p === 'ManageRoles' },
    roles: { highest: { position, comparePositionTo: (r) => position - r.position } },
  });
  const guild = (m) => ({ id: GUILD_ID, members: { me: m } });
  const role = (over = {}) => ({ id: ROLE, name: 'Perk', position: 3, managed: false, ...over });

  assert.equal(botRefusal(guild(me(10)), role()), null);
  assert.match(botRefusal(guild(me(10)), undefined), /no longer exists/);
  assert.match(botRefusal(guild(me(10)), role({ id: GUILD_ID })), /everyone/);
  assert.match(botRefusal(guild(me(10)), role({ managed: true })), /managed/);
  assert.match(botRefusal(guild(me(10, false)), role()), /Manage Roles/);
  assert.match(botRefusal(guild(me(3)), role()), /above Sylo/, 'equal position is not enough');
  assert.match(botRefusal(guild(me(2)), role()), /above Sylo/);
  assert.match(botRefusal(guild(me(10)), role({ editable: false })), /above Sylo/);
  assert.match(botRefusal(guild(null), role()), /Manage Roles/);
});

test('a list line names the member, the role, the end time, who set it and why', () => {
  const line = describeTempRole({
    user_id: '100000000000000011',
    role_id: ROLE,
    expires_at: 1_900_000_000_000,
    added_by: '100000000000000012',
    reason: 'x'.repeat(100),
  });
  assert.match(
    line,
    /<@100000000000000011> · <@&100000000000000700> · ends <t:1900000000:f> \(<t:1900000000:R>\)/
  );
  assert.match(line, /by <@100000000000000012>/);
  assert.match(line, /"x{80}…"/);
  assert.equal(
    describeTempRole({ user_id: '1', role_id: '2', expires_at: 1000, added_by: null, reason: '' }),
    '<@1> · <@&2> · ends <t:1:f> (<t:1:R>)'
  );
});
