// Who a dashboard action is attributed to: the person's id on the platform of the server it
// happened in, not their primary (Discord) id.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { actingUserId } from '../src/web/middleware/auth.js';

const both = {
  account: {
    identities: [
      { platform: 'discord', platformUserId: '111111111111111111' },
      { platform: 'fluxer', platformUserId: '555555555555555555' },
    ],
  },
};

test('actingUserId: the id on the platform of the guild being acted in', () => {
  assert.equal(actingUserId(both, '900000000000000001'), '111111111111111111');
  assert.equal(actingUserId(both, 'fluxer:900000000000000002'), '555555555555555555');
});

test('actingUserId: falls back when the account has no identity on that platform', () => {
  const discordOnly = { account: { identities: [both.account.identities[0]] } };
  assert.equal(actingUserId(discordOnly, 'fluxer:900000000000000002'), 'web');
  assert.equal(actingUserId({}, '900000000000000001', 'x'), 'x');
});
