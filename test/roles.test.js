import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoleComponents } from '../src/modules/roles.js';

const R = (n) => String(10n ** 17n + BigInt(n)); // valid-looking snowflakes

function fakeGuild(names = {}) {
  return {
    roles: {
      cache: {
        get: (id) => (names[id] ? { id, name: names[id] } : { id, name: 'role' }),
      },
    },
  };
}

test('buttons style: rows of ≤5 buttons with rr:<id>:<role> customIds', () => {
  const pairs = Array.from({ length: 7 }, (_, i) => ({ roleId: R(i), label: `L${i}`, btnStyle: 'primary' }));
  const rows = buildRoleComponents(fakeGuild(), { id: '42', style: 'buttons', pairs }).map((r) => r.toJSON());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].components.length, 5);
  assert.equal(rows[1].components.length, 2);
  const b = rows[0].components[0];
  assert.equal(b.custom_id, `rr:42:${R(0)}`);
  assert.equal(b.label, 'L0');
  assert.equal(b.style, 1); // Primary
});

test('button label falls back to the role name; bad btnStyle -> secondary', () => {
  const rows = buildRoleComponents(fakeGuild({ [R(1)]: 'Gamer' }), {
    id: '1',
    style: 'buttons',
    pairs: [{ roleId: R(1), btnStyle: 'chartreuse' }],
  }).map((r) => r.toJSON());
  assert.equal(rows[0].components[0].label, 'Gamer');
  assert.equal(rows[0].components[0].style, 2); // Secondary
});

test('select style: one menu, rrsel:<id>, options carry role ids', () => {
  const pairs = [
    { roleId: R(1), label: 'One' },
    { roleId: R(2), label: 'Two' },
    { roleId: R(3), label: 'Three' },
  ];
  const [row] = buildRoleComponents(fakeGuild(), { id: '9', style: 'select', pairs, placeholder: 'Choose' }).map((r) =>
    r.toJSON()
  );
  const menu = row.components[0];
  assert.equal(menu.custom_id, 'rrsel:9');
  assert.equal(menu.placeholder, 'Choose');
  assert.equal(menu.min_values, 0);
  assert.equal(menu.max_values, 3);
  assert.deepEqual(
    menu.options.map((o) => o.value),
    [R(1), R(2), R(3)]
  );
});

test('exclusive select clamps to a single pick', () => {
  const pairs = [{ roleId: R(1) }, { roleId: R(2) }];
  const [row] = buildRoleComponents(fakeGuild(), { id: '3', style: 'select', exclusive: true, pairs }).map((r) =>
    r.toJSON()
  );
  assert.equal(row.components[0].max_values, 1);
});

test('invalid role ids are dropped; no valid pairs -> no components', () => {
  assert.deepEqual(buildRoleComponents(fakeGuild(), { id: '1', style: 'buttons', pairs: [{ roleId: 'nope' }] }), []);
});
