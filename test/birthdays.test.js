import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseBirthdaysConfig, isValidBirthday, daysUntilBirthday } from '../src/modules/birthdays.js';
import {
  setBirthday,
  getBirthday,
  removeBirthday,
  guildBirthdays,
  birthdaysOnDay,
  clearGuildBirthdays,
} from '../src/db/birthdays.js';

const G = '900000000000000201';
const U1 = '800000000000000201';
const U2 = '800000000000000202';

test('normaliseBirthdaysConfig: defaults + id validation', () => {
  assert.deepEqual(normaliseBirthdaysConfig(), {
    channel: '',
    message: '🎂 Happy birthday {user}! 🎉',
    roleId: '',
    pingRole: false,
  });
  const c = normaliseBirthdaysConfig({
    channel: '123456789012345678',
    message: '  hi {user}  ',
    roleId: 'not-an-id',
    pingRole: 1,
  });
  assert.equal(c.channel, '123456789012345678');
  assert.equal(c.message, 'hi {user}');
  assert.equal(c.roleId, '');
  assert.equal(c.pingRole, true);
});

test('isValidBirthday: real dates only, Feb 29 allowed without a year', () => {
  assert.equal(isValidBirthday(2, 29, null), true);
  assert.equal(isValidBirthday(2, 30, null), false);
  assert.equal(isValidBirthday(4, 31, null), false);
  assert.equal(isValidBirthday(13, 1, null), false);
  assert.equal(isValidBirthday(6, 15, 1990), true);
  assert.equal(isValidBirthday(2, 29, 2001), false); // 2001 wasn't a leap year
  assert.equal(isValidBirthday(1, 1, 1899), false);
  assert.equal(isValidBirthday(1, 1, new Date().getFullYear() + 1), false);
});

test('daysUntilBirthday: 0 today, 1 tomorrow, wraps the year', () => {
  const ref = new Date(2026, 5, 15); // 15 June 2026
  assert.equal(daysUntilBirthday(6, 15, ref), 0);
  assert.equal(daysUntilBirthday(6, 16, ref), 1);
  assert.equal(daysUntilBirthday(6, 14, ref), 364); // already passed → next year
});

test('birthday storage: set, upsert, get, list order, remove', () => {
  clearGuildBirthdays(G);
  setBirthday({ guildId: G, userId: U1, month: 12, day: 25 });
  setBirthday({ guildId: G, userId: U2, month: 3, day: 4, year: 2000 });

  assert.deepEqual(getBirthday(G, U1), {
    guild_id: G,
    user_id: U1,
    month: 12,
    day: 25,
    year: null,
    created_at: getBirthday(G, U1).created_at,
  });

  // upsert — same user, new date, still one row
  setBirthday({ guildId: G, userId: U1, month: 1, day: 2 });
  const u1 = getBirthday(G, U1);
  assert.equal(u1.month, 1);
  assert.equal(u1.day, 2);

  // list is ordered by (month, day)
  assert.deepEqual(
    guildBirthdays(G).map((r) => `${r.month}/${r.day}`),
    ['1/2', '3/4']
  );

  assert.equal(removeBirthday(G, U1), 1);
  assert.equal(removeBirthday(G, U1), 0);
  assert.equal(getBirthday(G, U1), null);
});

test('birthdaysOnDay returns matches for that guild + date', () => {
  clearGuildBirthdays(G);
  setBirthday({ guildId: G, userId: U1, month: 7, day: 4 });
  setBirthday({ guildId: G, userId: U2, month: 7, day: 4, year: 1999 });
  setBirthday({ guildId: G, userId: '800000000000000203', month: 7, day: 5 });

  assert.deepEqual(
    birthdaysOnDay(G, 7, 4)
      .map((r) => r.user_id)
      .sort(),
    [U1, U2].sort()
  );
  assert.equal(birthdaysOnDay(G, 7, 5).length, 1);
  assert.equal(birthdaysOnDay('other-guild', 7, 4).length, 0);
});
