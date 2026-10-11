import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { runtime } from '../src/runtime.js';
import { setGuildModule } from '../src/db/modules.js';
import { getTicket, getTicketChannel, ticketMessages } from '../src/db/tickets.js';
import { ingestUserDM, closeTicketWithNotice } from '../src/modules/tickets.js';
import { handleDMTicketStaffMessage } from '../src/modules/dmTicketChannels.js';

let next = 820000000000000000n;
async function environment(extra = {}) {
  const gid = String(next++),
    uid = String(next++),
    role = String(next++);
  const category = { id: String(next++), type: ChannelType.GuildCategory };
  const logs = {
    id: String(next++),
    sent: [],
    isTextBased: () => true,
    send: async (payload) => {
      logs.sent.push(payload);
    },
  };
  const cache = new Map([
    [category.id, category],
    [logs.id, logs],
  ]);
  const created = [],
    dms = [];
  const guild = {
    id: gid,
    name: 'Serwer',
    roles: { cache: new Map([[role, {}]]) },
    members: {
      me: { id: String(next++) },
      fetch: async () => ({
        permissions: { has: () => false },
        roles: { cache: new Map([[role, {}]]) },
      }),
    },
    channels: {
      cache,
      fetch: async (id) => cache.get(id),
      create: async (options) => {
        const channel = {
          id: String(next++),
          sent: [],
          deleted: false,
          options,
          send: async (payload) => {
            channel.sent.push(payload);
          },
          delete: async () => {
            channel.deleted = true;
            cache.delete(channel.id);
          },
        };
        cache.set(channel.id, channel);
        created.push(channel);
        return channel;
      },
    },
  };
  const user = {
    id: uid,
    tag: 'Użytkownik',
    send: async (payload) => {
      dms.push(payload);
    },
  };
  const cfg = { dmCategory: category.id, ticketLogChannel: logs.id, staffRoles: [role], ...extra };
  await setGuildModule(gid, 'tickets', { enabled: true, config: cfg });
  runtime.client = { guilds: { cache: new Map([[gid, guild]]) }, users: { fetch: async () => user } };
  return { guild, user, cfg, created, dms, logs, role };
}

test('concurrent DMs share a private workspace with persistent routing and no user access', async () => {
  const env = await environment();
  const tickets = await Promise.all(
    ['pierwsza', 'druga'].map((content) => ingestUserDM(env.guild, env.user, { content, attachments: [] }))
  );
  assert.equal(tickets[0].id, tickets[1].id);
  assert.equal(env.created.length, 1);
  const channel = env.created[0];
  assert.equal(channel.options.parent, env.cfg.dmCategory);
  assert.deepEqual(channel.options.permissionOverwrites[0], {
    id: env.guild.id,
    deny: [PermissionFlagsBits.ViewChannel],
  });
  assert.equal(
    channel.options.permissionOverwrites.some((o) => o.id === env.user.id),
    false
  );
  assert.equal(
    channel.options.permissionOverwrites.some((o) => o.id === env.role),
    true
  );
  const mapping = await getTicketChannel(tickets[0].id);
  assert.equal(mapping.channel_id, channel.id);
  assert.equal(channel.sent.filter((p) => p.embeds).length, 2);
  await ingestUserDM(env.guild, env.user, {
    content: 'trzecia',
    attachments: ['https://cdn.discordapp.com/test.png'],
  });
  assert.equal(env.created.length, 1);
  assert.match(channel.sent.at(-1).embeds[0].toJSON().description, /trzecia.*test.png/s);
});

test('staff replies and attachment-only messages reach DMs and are recorded', async () => {
  const env = await environment();
  const ticket = await ingestUserDM(env.guild, env.user, { content: 'pomocy' });
  const channel = env.created[0],
    reactions = [];
  const message = {
    guild: env.guild,
    channelId: channel.id,
    author: { id: 'staff', bot: false },
    content: '',
    attachments: new Map([['a', { url: 'https://cdn.discordapp.com/file.png' }]]),
    react: async (value) => reactions.push(value),
    reply: async () => assert.fail('unexpected error'),
  };
  await handleDMTicketStaffMessage(message);
  assert.match(env.dms.at(-1).embeds[0].toJSON().description, /file.png/);
  assert.deepEqual(reactions, ['✅']);
  const rows = await ticketMessages(ticket.id);
  assert.equal(rows.at(-1).author_kind, 'staff');
  assert.deepEqual(rows.at(-1).attachments, ['https://cdn.discordapp.com/file.png']);
  await ingestUserDM(env.guild, env.user, { content: 'dziękuję' });
  assert.equal(channel.sent.filter((p) => p.embeds).length, 2); // no duplicate staff echo
});

test('unauthorized members, bots and webhooks cannot relay staff responses', async () => {
  const env = await environment();
  await ingestUserDM(env.guild, env.user, { content: 'pomocy' });
  env.guild.members.fetch = async () => ({ permissions: { has: () => false }, roles: { cache: new Map() } });
  const count = env.dms.length;
  const message = {
    guild: env.guild,
    channelId: env.created[0].id,
    author: { id: 'outsider', bot: false },
    content: 'sekret',
    attachments: new Map(),
  };
  await handleDMTicketStaffMessage(message);
  await handleDMTicketStaffMessage({ ...message, webhookId: 'webhook' });
  await handleDMTicketStaffMessage({ ...message, author: { bot: true } });
  assert.equal(env.dms.length, count);
});

test('archive failure preserves open ticket; retry archives, closes, DMs and deletes', async () => {
  const env = await environment();
  const ticket = await ingestUserDM(env.guild, env.user, { content: 'ważna rozmowa' });
  const channel = env.created[0],
    send = env.logs.send;
  env.logs.send = async () => {
    throw new Error('missing permissions');
  };
  await assert.rejects(closeTicketWithNotice(ticket, 'staff'), /missing permissions/);
  assert.equal((await getTicket(ticket.id)).status, 'open');
  assert.equal(channel.deleted, false);
  env.logs.send = send;
  await closeTicketWithNotice(ticket, 'staff');
  assert.equal((await getTicket(ticket.id)).status, 'closed');
  assert.equal(channel.deleted, true);
  assert.match(env.logs.sent[0].files[0].attachment.toString(), /ważna rozmowa/);
  assert.match(env.dms.at(-1).embeds[0].toJSON().description, /zamknięte/);
  await closeTicketWithNotice(ticket, 'staff');
  assert.equal(env.logs.sent.length, 1); // stale clicks do not send duplicate notices or logs
});

test('destination can use the existing panel category without a new setting', async () => {
  const env = await environment();
  const panel = { id: String(next++), parentId: env.cfg.dmCategory };
  env.guild.channels.cache.set(panel.id, panel);
  await setGuildModule(env.guild.id, 'tickets', {
    enabled: true,
    config: { ...env.cfg, dmCategory: '', panelChannel: panel.id },
  });
  await ingestUserDM(env.guild, env.user, { content: 'pomocy' });
  assert.equal(env.created[0].options.parent, panel.parentId);
});
