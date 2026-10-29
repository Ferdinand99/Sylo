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

test('every card links to its page in the dashboard (/v2)', async () => {
  const hrefs = Object.fromEntries(
    (await buildOverview(stubGuild(G))).groups.flatMap((g) => g.cards.map((c) => [c.id, c.href]))
  );
  assert.deepEqual(
    [hrefs.general, hrefs.commands, hrefs.messages, hrefs.insights, hrefs.welcome, hrefs.moderation],
    [
      `/v2/guilds/${G}/settings`,
      `/v2/guilds/${G}/moderation/commands`,
      `/v2/guilds/${G}/messages`,
      `/v2/guilds/${G}/insights`,
      `/v2/guilds/${G}/m/welcome`,
      `/v2/guilds/${G}/m/moderation`,
    ]
  );
  for (const [id, href] of Object.entries(hrefs)) assert.ok(href.startsWith(`/v2/guilds/${G}/`), id);
});

test('the Events card counts upcoming events and names the next one', async () => {
  const { createEvent } = await import('../src/db/events.js');
  const find = async () =>
    (await buildOverview(stubGuild(G))).groups.flatMap((g) => g.cards).find((c) => c.id === 'events');
  const empty = await find();
  assert.ok(empty, 'a card for the Events module');
  assert.equal(empty.lines.find((l) => l.label === 'Upcoming events').value, '0');
  assert.equal(empty.lines.find((l) => l.label === 'Next').value, 'none');

  await createEvent({
    guildId: G,
    channelId: '111',
    title: 'Game night',
    startAt: Date.UTC(2030, 0, 2, 18, 30),
    hostId: 'h',
  });
  const card = await find();
  assert.equal(card.lines.find((l) => l.label === 'Upcoming events').value, '1');
  assert.match(card.lines.find((l) => l.label === 'Next').value, /Game night · 2030-01-02 18:30 UTC/);
});

test('the Suggestions card counts open and stored suggestions', async () => {
  const { createSuggestion, decideSuggestion } = await import('../src/db/suggestions.js');
  const find = async () =>
    (await buildOverview(stubGuild(G))).groups.flatMap((g) => g.cards).find((c) => c.id === 'suggestions');
  const empty = await find();
  assert.ok(empty, 'a card for the Suggestions module');
  assert.equal(empty.lines.find((l) => l.label === 'Open suggestions').value, '0');
  assert.equal(empty.lines.find((l) => l.label === 'Stored').value, '0');

  const a = await createSuggestion({ guildId: G, channelId: '111', authorId: 'u1', body: 'one' });
  await createSuggestion({ guildId: G, channelId: '111', authorId: 'u2', body: 'two' });
  await decideSuggestion(a.id, { status: 'approved' });
  const card = await find();
  assert.equal(card.lines.find((l) => l.label === 'Open suggestions').value, '1');
  assert.equal(card.lines.find((l) => l.label === 'Stored').value, '2');
});
