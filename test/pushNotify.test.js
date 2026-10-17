// Ticket notifications (internal/push-notifications-plan.md, tasks 4–5): what a notification
// says, who it goes to (devices with push on, not muted, whose account may see the server's
// tickets), that a member's DM triggers it and staff replies never do, the limits that keep it
// from fanning out or flooding (cached access checks, bounded concurrency, coalescing, a cap per
// device), and the sender in relay mode (against the real relay router) and direct mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { D_GUILD, startOAuthApp, uid } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { signInIdentity } = await import('../src/db/accounts.js');
const { createApiToken, apiTokenPush, setApiTokenPush, setApiTokenPushMuted } =
  await import('../src/db/apiTokens.js');
const { setBotMasterRoles } = await import('../src/db/guildSettings.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { findRelayRegistration } = await import('../src/db/pushRelay.js');
const push = await import('../src/lib/push.js');
const { ingestUserDM, relayStaffReply } = await import('../src/modules/tickets.js');
const { getTicket } = await import('../src/db/tickets.js');
const { createPushRelayRouter } = await import('../src/web/routes/pushRelay.js');

const {
  configurePush,
  resetPushState,
  notifyTicketActivity,
  ticketBody,
  ticketNotification,
  ticketRecipients,
  registerDevice,
} = push;
const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const ORIGIN = 'https://sylo.example.com';
const STAFF_ROLE = '700000000000000555';
const MASTER_ROLE = '700000000000000556';
const MINUTE = 60_000;

let deviceSeq = 0;
const device = () => (++deviceSeq).toString(16).padStart(64, 'e');
let clock = Date.now();

/** A member of the fake server with these permissions and roles (not put in the cache). */
function memberObject(id, { perms = [], roles = [] } = {}) {
  return {
    id,
    permissions: { has: (p) => perms.includes(p) },
    roles: {
      cache: {
        hasAny: (...ids) => ids.some((r) => roles.includes(r)),
        some: (fn) => roles.map((r) => ({ id: r })).some(fn),
      },
    },
  };
}
const member = (id, opts) => guild.members.cache.set(id, memberObject(id, opts));

/** Someone signed in to the app (their sign-in snapshot lists D_GUILD), with push on. */
async function staffDevice({ perms = [], roles = [], pushOn = true, cached = true } = {}) {
  const id = uid('3333333333');
  const { accountId } = await signInIdentity({
    platform: 'discord',
    platformUserId: id,
    guildIds: [D_GUILD],
  });
  const { id: tokenId } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 });
  if (pushOn) {
    await setApiTokenPush(tokenId, { deviceToken: device(), environment: 'production', origin: ORIGIN });
  }
  if (cached) member(id, { perms, roles });
  return { id, tokenId };
}

// Members' fetch() finds the cached ones, plus `fetchable` ones the bot has not cached; every
// call is counted.
const fetchable = new Map();
let fetches = [];
const realFetch = guild.members.fetch;
guild.members.fetch = async (uid) => {
  fetches.push(uid);
  const m = guild.members.cache.get(uid) ?? fetchable.get(uid);
  if (!m) throw new Error('Unknown Member');
  return m;
};

// What was delivered, to whom. `waitFor(n)` resolves once n deliveries happened.
const delivered = [];
let waiters = [];
const fakeDeliver = async (recipient, notification) => {
  delivered.push({ recipient, notification });
  waiters = waiters.filter((w) => (delivered.length >= w.n ? (w.resolve(), false) : true));
  return 'ok';
};
const waitFor = (n) =>
  delivered.length >= n ? Promise.resolve() : new Promise((resolve) => waiters.push({ n, resolve }));

test.beforeEach(async () => {
  delivered.length = 0;
  fetches = [];
  fetchable.clear();
  // Only the tokens of the current test count as recipients: earlier ones lose their rights.
  for (const m of guild.members.cache.keys()) guild.members.cache.delete(m);
  resetPushState();
  configurePush({ relayUrl: 'http://relay.invalid', apns: null, deliver: fakeDeliver, now: () => clock });
  await setBotMasterRoles(D_GUILD, []);
  await setGuildModule(D_GUILD, 'tickets', { enabled: true, config: { staffRoles: [STAFF_ROLE] } });
});
test.after(() => {
  guild.members.fetch = realFetch;
  resetPushState();
  configurePush({ relayUrl: null, apns: undefined, deliver: null, now: Date.now });
});

// --- what it says ------------------------------------------------------------------------

test('the body is "<member>: <preview>", one line, at most 180 code points ending in "…"', () => {
  assert.equal(ticketBody('ferdi', 'my  order\nnever\tarrived'), 'ferdi: my order never arrived');
  const long = ticketBody('ferdi', 'x'.repeat(500));
  assert.equal([...long].length, 180);
  assert.ok(long.endsWith('…'));
  assert.ok(long.startsWith('ferdi: xxx'));
  const emoji = ticketBody('ferdi', '😀'.repeat(500));
  assert.equal([...emoji].length, 180);
  assert.ok(emoji.isWellFormed(), 'never half an emoji');
  assert.equal(ticketBody('ferdi', 'x'.repeat(173)).length, 180, 'exactly 180 is not cut');
  assert.ok(!ticketBody('ferdi', 'x'.repeat(173)).endsWith('…'));
});

test('format characters, separators and lone surrogates never reach the lock screen', () => {
  assert.equal(ticketBody('fer​di', 'evil ‮override'), 'ferdi: evil override');
  assert.equal(ticketBody('ferdi', 'one two three'), 'ferdi: one two three');
  const broken = ticketBody('ferdi', 'half \ud800 a pair');
  assert.ok(broken.isWellFormed());
  assert.doesNotMatch(broken, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
});

test('no text: "<member> sent an attachment"', () => {
  assert.equal(ticketBody('ferdi', ''), 'ferdi sent an attachment');
  assert.equal(ticketBody('ferdi', '  \n '), 'ferdi sent an attachment');
  assert.equal(ticketBody('', 'hi'), 'A member: hi');
});

test('the notification: server name as title, "New ticket" only for the first message', () => {
  const first = ticketNotification({
    guildName: 'My server',
    guildId: 'fluxer:900000000000000202',
    ticketId: 9,
    member: 'ferdi',
    content: 'hello',
    isNew: true,
  });
  assert.deepEqual(first, {
    title: 'My server',
    subtitle: 'New ticket',
    body: 'ferdi: hello',
    threadId: 'fluxer:900000000000000202:9',
    data: { kind: 'ticket', guildId: 'fluxer:900000000000000202', ticketId: 9 },
  });
  const reply = ticketNotification({
    guildName: 'x'.repeat(150),
    guildId: D_GUILD,
    ticketId: 9,
    member: 'f',
    content: 'a',
    isNew: false,
  });
  assert.equal(reply.subtitle, undefined);
  assert.equal([...reply.title].length, 100);
});

// --- who it goes to ----------------------------------------------------------------------

test('recipients: Manage Server, owner, bot master or a staff role; not muted; push on', async () => {
  const manager = await staffDevice({ perms: ['ManageGuild'] });
  const admin = await staffDevice({ perms: ['Administrator'] });
  const staff = await staffDevice({ roles: [STAFF_ROLE] });
  const master = await staffDevice({ roles: [MASTER_ROLE] });
  const owner = await staffDevice();
  guild.ownerId = owner.id;
  const nobody = await staffDevice(); // in the snapshot, but no right in the server now
  const muted = await staffDevice({ perms: ['ManageGuild'] });
  await setApiTokenPushMuted(muted.tokenId, D_GUILD, true);
  const off = await staffDevice({ perms: ['ManageGuild'], pushOn: false });
  const mutedElsewhere = await staffDevice({ perms: ['ManageGuild'] });
  await setApiTokenPushMuted(mutedElsewhere.tokenId, 'fluxer:900000000000000202', true);

  await setBotMasterRoles(D_GUILD, [MASTER_ROLE]);
  try {
    const ids = new Set((await ticketRecipients(D_GUILD)).map((r) => r.id));
    for (const yes of [manager, admin, staff, master, owner, mutedElsewhere]) assert.ok(ids.has(yes.tokenId));
    for (const no of [nobody, muted, off]) assert.ok(!ids.has(no.tokenId));
  } finally {
    guild.ownerId = 'x';
  }
});

test('an access check is reused for 2 minutes, so a lost right counts within that', async () => {
  const staff = await staffDevice({ roles: [STAFF_ROLE] });
  const has = async () => (await ticketRecipients(D_GUILD)).some((r) => r.id === staff.tokenId);
  assert.ok(await has());
  await setGuildModule(D_GUILD, 'tickets', { enabled: true, config: { staffRoles: [] } });
  clock += MINUTE;
  assert.ok(await has(), 'still cached');
  clock += MINUTE + 1;
  assert.ok(!(await has()), 'checked again after 2 minutes');
});

test('a member the bot cannot find is not looked up again for 10 minutes', async () => {
  const gone = await staffDevice({ roles: [STAFF_ROLE], cached: false });
  await ticketRecipients(D_GUILD);
  const lookups = () => fetches.filter((id) => id === gone.id).length;
  assert.equal(lookups(), 1, 'one lookup, however many checks need the member');

  clock += 3 * MINUTE; // the access result expired, the miss did not
  await ticketRecipients(D_GUILD);
  assert.equal(lookups(), 1);

  clock += 8 * MINUTE;
  fetchable.set(gone.id, memberObject(gone.id, { roles: [STAFF_ROLE] }));
  assert.ok((await ticketRecipients(D_GUILD)).some((r) => r.id === gone.tokenId));
  assert.equal(lookups(), 2);
});

test('access checks run at most 5 at a time', async () => {
  for (let i = 0; i < 12; i += 1) {
    const d = await staffDevice({ cached: false });
    fetchable.set(d.id, memberObject(d.id, { perms: ['ManageGuild'] }));
  }
  let inFlight = 0;
  let peak = 0;
  const counting = guild.members.fetch;
  guild.members.fetch = async (id) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    inFlight -= 1;
    return counting(id);
  };
  try {
    assert.equal((await ticketRecipients(D_GUILD)).length, 12);
  } finally {
    guild.members.fetch = counting;
  }
  assert.ok(peak <= 5, `peak ${peak}`);
  assert.ok(peak > 1, 'but not one by one');
});

// --- the trigger -------------------------------------------------------------------------

let userSeq = 0;
const ticketUser = () => ({
  id: `3100000000000${String(++userSeq).padStart(5, '0')}`,
  tag: 'member#0001',
  send: async () => {},
});

test("a member's DM notifies: a new ticket with the subtitle, a reply without", async () => {
  const manager = await staffDevice({ perms: ['ManageGuild'] });
  const user = ticketUser();
  const ticket = await ingestUserDM(guild, user, { content: 'my order\nis late', attachments: [] });
  await waitFor(1);
  const mine = () => delivered.filter((d) => d.recipient.id === manager.tokenId);
  assert.equal(mine().length, 1);
  assert.deepEqual(mine()[0].notification, {
    title: 'D-main',
    subtitle: 'New ticket',
    body: 'member#0001: my order is late',
    threadId: `${D_GUILD}:${ticket.id}`,
    data: { kind: 'ticket', guildId: D_GUILD, ticketId: ticket.id, server: ORIGIN },
  });

  clock += 31_000; // past the coalescing window
  await ingestUserDM(guild, user, { content: '', attachments: ['https://cdn.example/a.png'] });
  await waitFor(2);
  assert.equal(mine().length, 2);
  assert.equal(mine()[1].notification.subtitle, undefined);
  assert.equal(mine()[1].notification.body, 'member#0001 sent an attachment');
  assert.equal(mine()[1].notification.data.ticketId, ticket.id);

  // A staff reply is never a notification.
  await relayStaffReply(await getTicket(ticket.id), manager.id, 'on it');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(mine().length, 2);
});

test('replies in one ticket coalesce: one notification per device per 30 seconds', async () => {
  const manager = await staffDevice({ perms: ['ManageGuild'] });
  const notify = (ticketId, isNew = false) =>
    notifyTicketActivity({ guild, ticketId, member: 'm', content: 'x', isNew });
  assert.equal((await notify(70)).sent, 1);
  clock += 10_000;
  assert.equal((await notify(70)).sent, 0, 'a burst of replies is one notification');
  assert.equal((await notify(71)).sent, 1, 'another ticket is its own');
  clock += 21_000;
  assert.equal((await notify(70)).sent, 1);
  // The first message of a new ticket always goes.
  assert.equal((await notify(72, true)).sent, 1);
  assert.equal((await notify(72, true)).sent, 1);
  assert.equal(delivered.filter((d) => d.recipient.id === manager.tokenId).length, 5);
});

test('a failing send or a broken lookup never reaches the DM relay', async () => {
  await staffDevice({ perms: ['ManageGuild'] });
  configurePush({
    deliver: async () => {
      throw new Error('relay down');
    },
  });
  const ticket = await ingestUserDM(guild, ticketUser(), { content: 'hi', attachments: [] });
  assert.ok(ticket.id);
  // (The DM's own notification may still be on its way: a first message is never coalesced.)
  const result = await notifyTicketActivity({
    guild,
    ticketId: ticket.id,
    member: 'm',
    content: 'hi',
    isNew: true,
  });
  assert.equal(result.sent, 0);
  assert.equal(result.recipients.length, 1);

  // Not even a guild that cannot be keyed throws.
  assert.deepEqual(
    await notifyTicketActivity({ guild: null, ticketId: 1, member: 'm', content: 'x', isNew: true }),
    {
      sent: 0,
      recipients: [],
    }
  );
});

test('nothing is looked up or sent when the instance cannot push', async () => {
  await staffDevice({ perms: ['ManageGuild'] });
  configurePush({ relayUrl: null, apns: null });
  const result = await notifyTicketActivity({ guild, ticketId: 1, member: 'm', content: 'x', isNew: true });
  assert.deepEqual(result, { sent: 0, recipients: [] });
  assert.equal(delivered.length, 0);
});

// --- the sender --------------------------------------------------------------------------

test('relay mode: the app registers, the notification goes through the relay, a gone device is cleared', async () => {
  const apnsCalls = [];
  let answer = { status: 'ok' };
  const relayApp = express();
  relayApp.use(express.json());
  relayApp.use(
    '/api/push-relay/v1',
    createPushRelayRouter({
      apns: {
        send: async (msg) => {
          apnsCalls.push(msg);
          return answer;
        },
      },
    })
  );
  const server = await new Promise((resolve) => {
    const s = relayApp.listen(0, () => resolve(s));
  });
  try {
    const relayUrl = `http://127.0.0.1:${server.address().port}`;
    configurePush({ relayUrl, apns: null, deliver: null });
    const manager = await staffDevice({ perms: ['ManageGuild'], pushOn: false });
    // The app registers its device token at the relay, for the address it knows this server by.
    const deviceToken = device();
    const appKnows = 'https://tickets.example.org';
    const res = await fetch(`${relayUrl}/api/push-relay/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceToken, environment: 'development', instance: appKnows }),
    });
    const { relayToken } = await res.json();
    await registerDevice(manager.tokenId, { relayToken, environment: 'development', origin: ORIGIN });

    const result = await notifyTicketActivity({
      guild,
      ticketId: 42,
      member: 'ferdi',
      content: 'hello',
      isNew: true,
    });
    assert.equal(result.sent, 1);
    assert.equal(apnsCalls.length, 1);
    assert.deepEqual(apnsCalls[0], {
      deviceToken,
      environment: 'development',
      payload: {
        aps: {
          alert: { title: 'D-main', subtitle: 'New ticket', body: 'ferdi: hello' },
          sound: 'default',
          'thread-id': `${D_GUILD}:42`,
        },
        // The address the app registered with, so the app can route the tap.
        sylo: { kind: 'ticket', server: appKnows, guildId: D_GUILD, ticketId: 42 },
      },
    });

    answer = { status: 'gone', reason: 'Unregistered' };
    await notifyTicketActivity({ guild, ticketId: 42, member: 'ferdi', content: 'again', isNew: true });
    assert.equal(await findRelayRegistration(relayToken), null, 'the relay forgot it');
    assert.equal((await apiTokenPush(manager.tokenId)).enabled, false, 'and so did the instance');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('direct mode: Apple is called with the device token; "gone" clears it', async () => {
  const calls = [];
  let answer = { status: 'ok' };
  configurePush({
    apns: {
      send: async (msg) => {
        calls.push(msg);
        return answer;
      },
    },
    deliver: null,
  });
  const manager = await staffDevice({ perms: ['ManageGuild'] });
  const { deviceToken } = await apiTokenPush(manager.tokenId);
  assert.equal(
    (await notifyTicketActivity({ guild, ticketId: 5, member: 'm', content: 'x', isNew: false })).sent,
    1
  );
  assert.equal(calls.at(-1).deviceToken, deviceToken);
  assert.equal(calls.at(-1).payload.sylo.server, ORIGIN);
  assert.equal(calls.at(-1).payload.aps.alert.subtitle, undefined);

  answer = { status: 'gone', reason: 'BadDeviceToken' };
  await notifyTicketActivity({ guild, ticketId: 5, member: 'm', content: 'x', isNew: true });
  assert.equal((await apiTokenPush(manager.tokenId)).enabled, false);
});

test('direct mode: at most 60 notifications per device per rolling hour', async () => {
  const calls = [];
  configurePush({
    apns: {
      send: async (msg) => {
        calls.push(msg);
        return { status: 'ok' };
      },
    },
    deliver: null,
  });
  await staffDevice({ perms: ['ManageGuild'] });
  const notify = (ticketId) =>
    notifyTicketActivity({ guild, ticketId, member: 'm', content: 'x', isNew: true });
  for (let i = 0; i < 61; i += 1) await notify(1000 + i);
  assert.equal(calls.length, 60);
  clock += 61 * MINUTE;
  assert.equal((await notify(2000)).sent, 1);
});
