// Birthday storage: one (month, day, optional year) per member per guild.
// The birthdays module reads `birthdaysToday` on its daily tick.
import { db } from './index.js';

const s = {
  upsert: db.prepare(`
    INSERT INTO birthdays (guild_id, user_id, month, day, year, created_at)
    VALUES (@guildId, @userId, @month, @day, @year, @createdAt)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      month = excluded.month, day = excluded.day, year = excluded.year
  `),
  get: db.prepare('SELECT * FROM birthdays WHERE guild_id = ? AND user_id = ?'),
  del: db.prepare('DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?'),
  listGuild: db.prepare('SELECT * FROM birthdays WHERE guild_id = ? ORDER BY month, day'),
  onDay: db.prepare('SELECT * FROM birthdays WHERE guild_id = ? AND month = ? AND day = ?'),
  delGuild: db.prepare('DELETE FROM birthdays WHERE guild_id = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM birthdays WHERE guild_id = ? AND user_id = ?'),
};

/** @param {{guildId:string,userId:string,month:number,day:number,year?:number|null}} b */
export function setBirthday(b) {
  s.upsert.run({
    guildId: b.guildId,
    userId: b.userId,
    month: b.month,
    day: b.day,
    year: b.year ?? null,
    createdAt: Date.now(),
  });
}

export const getBirthday = (guildId, userId) => s.get.get(guildId, userId) ?? null;
export const removeBirthday = (guildId, userId) => s.del.run(guildId, userId).changes;
export const guildBirthdays = (guildId) => s.listGuild.all(guildId);
export const birthdaysOnDay = (guildId, month, day) => s.onDay.all(guildId, month, day);
export const clearGuildBirthdays = (guildId) => s.delGuild.run(guildId);
export const birthdayCount = (guildId, userId) => s.count.get(guildId, userId).n;
