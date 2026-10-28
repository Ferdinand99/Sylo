import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { setGuildModule } from '../src/db/modules.js';
import { buildOverview } from '../src/web/lib/overviewSummary.js';

const G = '700000000000000001';

function stubGuild(id) {
  const channels = new Map([['111', { id: '111', name: 'general' }]]);
  return {
    id,
    members: { me: { permissions: new PermissionsBitField(PermissionsBitField.Flags.KickMembers) } },
    channels: { cache: { get: (cid) => channels.get(cid) } },
  };
}

test('buildOverview returns health + grouped cards covering every module', async () => {
  await setGuildModule(G, 'automod', { enabled: true, config: { rules: { invites: { enabled: true } } } });

  const ov = await buildOverview(stubGuild(G));

  assert.ok(ov.health.perms.missing.includes('Ban Members'), 'missing perms detected');
  assert.ok(ov.groups.length >= 4);

  const ids = ov.groups.flatMap((g) => g.cards.map((c) => c.id));
  for (const m of [
    'moderation',
    'automod',
    'logging',
    'welcome',
    'roles',
    'counting',
    'leveling',
    'sticky',
    'tickets',
    'custom-commands',
    'reminders',
  ]) {
    assert.ok(ids.includes(m), `overview should include a card for ${m}`);
  }

  const automod = ov.groups.flatMap((g) => g.cards).find((c) => c.id === 'automod');
  assert.equal(automod.status, 'on');
  assert.ok(automod.lines.some((l) => l.label === 'Active filters'));
});

test('card links are classic pages by default and new-dashboard pages with { v2: true }', async () => {
  const hrefs = async (opts) =>
    Object.fromEntries(
      (await buildOverview(stubGuild(G), opts)).groups.flatMap((g) => g.cards.map((c) => [c.id, c.href]))
    );
  const classic = await hrefs();
  assert.equal(classic.general, `/guilds/${G}/settings`);
  assert.equal(classic.welcome, `/guilds/${G}/m/welcome`);
  assert.equal(classic.insights, `/guilds/${G}/insights`);

  const v2 = await hrefs({ v2: true });
  assert.deepEqual(
    [v2.general, v2.commands, v2.messages, v2.insights, v2.welcome, v2.moderation],
    [
      `/v2/guilds/${G}/settings`,
      `/v2/guilds/${G}/moderation/commands`,
      `/v2/guilds/${G}/messages`,
      `/v2/guilds/${G}/insights`,
      `/v2/guilds/${G}/m/welcome`,
      `/v2/guilds/${G}/m/moderation`,
    ]
  );
});
