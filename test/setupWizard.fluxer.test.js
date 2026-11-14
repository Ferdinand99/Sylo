// The setup wizard on a Fluxer server: the guild's id is its key ("fluxer:<id>"), the @everyone role and the
// bot are known by the platform's own ids, channels are made through createChannelCompat and roles through
// createRole, and a permission the platform cannot answer does not stop Sylo from trying.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionsBitField } from 'discord.js';
import { runtime } from '../src/runtime.js';
import { getGuildModule } from '../src/db/modules.js';
import { listAudit } from '../src/db/audit.js';
import { applySetup, suggestSetup } from '../src/web/lib/setupWizard.js';

const RAW = '900000000000000301';
const KEY = `fluxer:${RAW}`;
const client = {};
runtime.clients.fluxer = client;
test.after(() => {
  runtime.clients.fluxer = null;
});

let next = 800000000000000000n;
const made = { channels: [], roles: [] };
const channels = new Map();
const roles = new Map();
const channel = (id, name) => ({
  id,
  name,
  type: ChannelType.GuildText,
  rawPosition: 1,
  permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
});
roles.set(RAW, { id: RAW, name: '@everyone', position: 0, managed: false });

// A Fluxer guild as the web layer sees it: `id` is the key, `rawId` the platform's id. Fluxer has no
// permission set on the bot member, so botHas() cannot answer.
const guild = {
  id: KEY,
  rawId: RAW,
  client,
  name: 'Fluxer test',
  memberCount: 5,
  channels: { cache: channels },
  roles: { cache: roles, everyone: roles.get(RAW) },
  members: { me: { id: '900000000000000999', roles: { highest: { position: 10 } } } },
  async createChannelCompat(opts) {
    const id = String(next++);
    channels.set(id, channel(id, opts.name));
    made.channels.push({ id, ...opts });
    return { id };
  },
  async createRole(opts) {
    const id = String(next++);
    roles.set(id, { id, name: opts.name, position: 1, managed: false });
    made.roles.push({ id, ...opts });
    return { id };
  },
};

test('suggest on Fluxer reports the platform and cannot answer what it cannot know', async () => {
  const body = await suggestSetup(guild);
  assert.equal(body.platform, 'fluxer');
  assert.deepEqual(body.botCan, { createChannels: null, createRoles: null });
  assert.equal(body.items.find((i) => i.id === 'welcome').blocked.length, 0, 'Fluxer has no intents to lack');
});

test('apply on Fluxer creates through the platform calls, with the raw @everyone id, and saves under the key', async () => {
  const results = await applySetup({
    guild,
    actor: 'Dashboard',
    selections: [
      { id: 'welcome', fields: { joinChannel: { create: true } } },
      { id: 'verification', fields: { channelId: { create: true }, verifiedRoleId: { create: true } } },
      { id: 'modlog', fields: { channelId: { create: true } } },
    ],
  });
  for (const r of results) assert.equal(r.status, 'applied', `${r.id}: ${r.message}`);

  const modlog = made.channels.find((c) => c.name === 'mod-log');
  const everyone = modlog.permissionOverwrites.find((o) => o.id === RAW);
  assert.ok(everyone, 'the @everyone overwrite uses the platform id, not the key');
  assert.ok(everyone.deny.includes(PermissionsBitField.Flags.ViewChannel));
  assert.deepEqual(
    made.roles.map((r) => r.name),
    ['Verified']
  );

  const welcome = await getGuildModule(KEY, 'welcome');
  assert.equal(welcome.enabled, true);
  assert.equal(welcome.config.joinChannel, made.channels[0].id);
  assert.equal((await getGuildModule(KEY, 'verification')).config.verifiedRoleId, made.roles[0].id);
  assert.equal((await listAudit(KEY, 20)).length, 7, 'three items, and the four things the wizard made');
  assert.equal((await listAudit(RAW, 20)).length, 0, 'nothing is filed under the bare id');
});
