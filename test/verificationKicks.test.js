// "Kick members who don't verify" used a timer in memory per join, up to 7 days long: a restart
// forgot every pending kick. The due time is stored now, and a sweep kicks when it passes.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { setGuildModule } from '../src/db/modules.js';
import { scheduleVerificationKick, dueVerificationKicks } from '../src/db/verificationKicks.js';
import { sweepVerificationKicks } from '../src/modules/verification.js';

const G = '900000000000000971';
const VERIFIED = '900000000000000972';

function fakeGuild(members) {
  const kicked = [];
  const guild = {
    id: G,
    members: {
      fetch: async (id) => {
        const m = members[id];
        if (!m) throw new Error('Unknown Member');
        return { id, kickable: true, roles: { cache: new Set(m.roles) }, kick: async () => kicked.push(id) };
      },
    },
  };
  runtime.client = { isReady: () => true, guilds: { cache: new Map([[G, guild]]) } };
  return kicked;
}

test('a due kick happens after a restart, and only for members still unverified', async () => {
  await setGuildModule(G, 'verification', {
    enabled: true,
    config: { verifiedRoleId: VERIFIED, kickAfterMinutes: 10 },
  });
  const now = Date.now();
  await scheduleVerificationKick({ guildId: G, userId: '900000000000000981', dueAt: now - 1 });
  await scheduleVerificationKick({ guildId: G, userId: '900000000000000982', dueAt: now - 1 });
  await scheduleVerificationKick({ guildId: G, userId: '900000000000000983', dueAt: now + 60_000 });
  const kicked = fakeGuild({
    '900000000000000981': { roles: [] },
    '900000000000000982': { roles: [VERIFIED] },
    '900000000000000983': { roles: [] },
  });

  await sweepVerificationKicks(now);

  assert.deepEqual(kicked, ['900000000000000981']);
  assert.deepEqual(
    (await dueVerificationKicks(now + 120_000)).map((r) => r.user_id),
    ['900000000000000983'],
    'the not-yet-due one is still waiting; the done ones are gone'
  );
});
