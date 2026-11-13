// Proves the driver shim's Postgres branch for the Welcome claim table: the bootstrap creates it, the
// claim is won by exactly one of several callers (ON CONFLICT DO NOTHING reports 0 rows to the rest), a
// clear lets it be taken again, and the role-gain flow, /forget, the export and the purge work on it.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'welcome on a role against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const sent = await import('../src/db/welcomeSent.js');
    const purge = await import('../src/db/purge.js');
    const { setGuildModule } = await import('../src/db/modules.js');
    const { dispatch } = await import('../src/modules/dispatch.js');
    await import('../src/modules/welcome.js');
    const fake = await import('./helpers/fakeIntro.js');
    t.after(async () => {
      fake.dropFakeClient();
      await closePostgres();
    });

    const G = `pgtest-welcome-${Date.now()}`;
    const H = `${G}-other`;
    const U = 'user-1';
    const V = 'user-2';

    await t.test('the table is created by the bootstrap, and a claim round-trips', async () => {
      assert.equal(await sent.getWelcomeSent(G, U), null);
      assert.equal(await sent.claimWelcome(G, U, 1_700_000_000_000), true);
      const row = await sent.getWelcomeSent(G, U);
      assert.equal(row.sent_at, 1_700_000_000_000);
      assert.equal(typeof row.sent_at, 'number', 'BIGINT comes back as a number');
    });

    await t.test('exactly one of several concurrent claims wins', async () => {
      const wins = await Promise.all(Array.from({ length: 12 }, () => sent.claimWelcome(G, V)));
      assert.equal(wins.filter(Boolean).length, 1);
      assert.equal(await sent.claimWelcome(G, V), false);
      assert.equal(await sent.claimWelcome(H, V), true, 'per server');
    });

    await t.test('a clear lets the claim be taken again', async () => {
      await sent.clearWelcomeSent(G, U);
      assert.equal(await sent.getWelcomeSent(G, U), null);
      assert.equal(await sent.claimWelcome(G, U), true);
    });

    await t.test('/forget, the export and the guild purge work on the table', async () => {
      const exported = await purge.exportUserData(G, U);
      assert.equal(exported.data.welcomeSent.length, 1);
      const summary = await purge.describeUserData(G, U);
      assert.equal(summary.items.find((i) => i.key === 'welcomeSent').count, 1);
      assert.equal((await purge.forgetUser(G, U)).welcomeSent, 1);
      assert.equal(await sent.getWelcomeSent(G, U), null);
      assert.ok(await sent.getWelcomeSent(G, V), 'another member is untouched');
      await purge.purgeGuild(G);
      assert.equal(await sent.getWelcomeSent(G, V), null);
      assert.ok(await sent.getWelcomeSent(H, V), 'another server is untouched');
      await purge.purgeGuild(H);
      assert.equal(await sent.getWelcomeSent(H, V), null);
    });

    await t.test('a role gain welcomes once, and leaving clears the claim', async () => {
      const env = fake.fakeIntroGuild();
      env.guild.memberCount = 3;
      const KEY = fake.GID;
      await purge.purgeGuild(KEY);
      await setGuildModule(KEY, 'welcome', {
        enabled: true,
        config: {
          trigger: 'role',
          triggerRoleIds: [fake.ROLE.adult],
          joinChannel: fake.INTRO_CH,
          joinMessage: 'Welcome {user}, {role}',
        },
      });
      const user = '700000000000000601';
      const m = fake.fakeMember(env.guild, user, { username: 'pg' });
      m.guild = env.guild;
      m.user.tag = 'pg#0';
      m.send = async () => {};
      const before = { ...m, roles: { cache: new Map(m.roles.cache) } };
      m.roles.cache.set(fake.ROLE.adult, env.guild.roles.cache.get(fake.ROLE.adult));
      await Promise.all([
        dispatch('guildMemberUpdate', KEY, { old: before, new: m }),
        dispatch('guildMemberUpdate', KEY, { old: before, new: m }),
      ]);
      assert.equal(env.channel.log.sent.length, 1);
      assert.equal(env.channel.log.sent[0].content, `Welcome <@${user}>, 18+`);
      assert.ok(await sent.getWelcomeSent(KEY, user));
      await dispatch('guildMemberRemove', KEY, m);
      assert.equal(await sent.getWelcomeSent(KEY, user), null);
      await purge.purgeGuild(KEY);
    });
  }
);
