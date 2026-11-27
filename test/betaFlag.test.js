// The Beta mark of the Bridge module and the Mirror page comes from one place (src/modules/registry.js) and
// reaches the dashboard and the Sylo app through the API answers.
import './helpers/tmpDb.js';
import test from 'node:test';
import { PermissionsBitField } from 'discord.js';
import assert from 'node:assert/strict';
import { BETA_PAGES, MODULES, getModule, isBeta } from '../src/modules/registry.js';
import { buildOverview } from '../src/web/lib/overviewSummary.js';

test('Bridge is a beta module and Mirror a beta page; a stable module is neither', () => {
  assert.equal(getModule('bridge').beta, true);
  assert.equal(isBeta('bridge'), true);
  assert.deepEqual([...BETA_PAGES], ['mirror']);
  assert.equal(isBeta('mirror'), true);
  assert.equal(isBeta('moderation'), false);
  assert.equal(isBeta('no-such-thing'), false);
});

test('a beta page id is never also a module id, so one flag decides each', () => {
  for (const id of BETA_PAGES) assert.equal(getModule(id), null, id);
  assert.ok(MODULES.every((m) => m.beta === undefined || typeof m.beta === 'boolean'));
});

test("the Bridge card in the overview carries the module's beta flag", async () => {
  const guild = {
    id: '700000000000000002',
    members: { me: { permissions: new PermissionsBitField(PermissionsBitField.Flags.KickMembers) } },
    channels: { cache: { get: () => undefined } },
  };
  const { groups } = await buildOverview(guild);
  const cards = groups.flatMap((g) => g.cards);
  assert.equal(cards.find((c) => c.id === 'bridge').beta, true);
  assert.equal(cards.find((c) => c.id === 'moderation').beta, false);
});
