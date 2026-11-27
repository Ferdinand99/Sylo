// Without the GuildMembers intent the member caches are sparse, so real senders are found by
// capped REST fetches instead. They must still be found.
process.env.INTENT_GUILD_MEMBERS = 'false';
await import('./helpers/tmpDb.js');
const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { setGuildModule } = await import('../src/db/modules.js');
const { lookupTicketGuilds, _resetTicketLookup, LOOKUP_REUSE_MS, MEMBER_PROBES_PER_DM } =
  await import('../src/modules/tickets.js');

const SENDER = { id: '700000000000000002' };
let nextId = 810000000000000000n;

async function ticketGuild(fetches, { members = [] } = {}) {
  const guild = {
    id: String(nextId++),
    client: {},
    // A tiny server whose cache holds only the bot: with the intent off this proves nothing.
    memberCount: 2,
    members: {
      cache: new Map([['bot', {}]]),
      fetch: async (id) => {
        fetches.push(guild.id);
        if (members.includes(id)) return { id };
        throw Object.assign(new Error('Unknown Member'), { code: 10007 });
      },
    },
  };
  await setGuildModule(guild.id, 'tickets', { enabled: true });
  return guild;
}

test('intent off: a cache that looks complete is not trusted, the sender is found by fetching', async () => {
  _resetTicketLookup();
  const fetches = [];
  // memberCount 1 (only the bot) would look complete; here the sender is a second member.
  const mine = await ticketGuild(fetches, { members: [SENDER.id] });
  mine.memberCount = 1;
  mine.members.cache = new Map([['bot', {}]]);
  const r = await lookupTicketGuilds(SENDER, { guilds: { cache: new Map([[mine.id, mine]]) } });
  assert.deepEqual(
    r.guilds.map((g) => g.id),
    [mine.id]
  );
  assert.equal(fetches.length, 1);
});

test('intent off: a sender in server 13 of 14 is found within a few messages, with capped fetches', async (t) => {
  _resetTicketLookup();
  t.mock.timers.enable({ apis: ['Date'], now: 9_000_000 });
  const fetches = [];
  const guilds = [];
  for (let i = 0; i < 12; i++) guilds.push(await ticketGuild(fetches));
  const mine = await ticketGuild(fetches, { members: [SENDER.id] });
  guilds.push(mine);
  guilds.push(await ticketGuild(fetches));
  const client = { guilds: { cache: new Map(guilds.map((g) => [g.id, g])) } };

  const first = await lookupTicketGuilds(SENDER, client);
  assert.equal(fetches.length, MEMBER_PROBES_PER_DM);
  assert.equal(first.guilds.length, 0);
  assert.equal(first.incomplete, true);

  t.mock.timers.tick(LOOKUP_REUSE_MS + 1);
  const second = await lookupTicketGuilds(SENDER, client);
  assert.deepEqual(
    second.guilds.map((g) => g.id),
    [mine.id]
  );
  assert.ok(fetches.length <= MEMBER_PROBES_PER_DM * 2);
});
