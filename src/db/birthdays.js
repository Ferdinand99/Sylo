// Birthday storage: one (month, day, optional year) per member per guild.
// The birthdays module reads `birthdaysToday` on its daily tick.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS birthdays (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    month      INTEGER NOT NULL,
    day        INTEGER NOT NULL,
    year       INTEGER,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_birthdays_md ON birthdays (month, day);
`);

const s = {
  upsert: prepare(`
    INSERT INTO birthdays (guild_id, user_id, month, day, year, created_at)
    VALUES (@guildId, @userId, @month, @day, @year, @createdAt)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      month = excluded.month, day = excluded.day, year = excluded.year
  `),
  get: prepare('SELECT * FROM birthdays WHERE guild_id = ? AND user_id = ?'),
  del: prepare('DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?'),
  listGuild: prepare('SELECT * FROM birthdays WHERE guild_id = ? ORDER BY month, day'),
  onDay: prepare('SELECT * FROM birthdays WHERE guild_id = ? AND month = ? AND day = ?'),
  delGuild: prepare('DELETE FROM birthdays WHERE guild_id = ?'),
  count: prepare('SELECT COUNT(*) AS n FROM birthdays WHERE guild_id = ? AND user_id = ?'),
};

/** @param {{guildId:string,userId:string,month:number,day:number,year?:number|null}} b */
export async function setBirthday(b) {
  await s.upsert.run({
    guildId: b.guildId,
    userId: b.userId,
    month: b.month,
    day: b.day,
    year: b.year ?? null,
    createdAt: Date.now(),
  });
}

export const getBirthday = async (guildId, userId) => (await s.get.get(guildId, userId)) ?? null;
export const removeBirthday = async (guildId, userId) => (await s.del.run(guildId, userId)).changes;
export const guildBirthdays = async (guildId) => s.listGuild.all(guildId);
export const birthdaysOnDay = async (guildId, month, day) => s.onDay.all(guildId, month, day);
export const clearGuildBirthdays = async (guildId) => s.delGuild.run(guildId);
export const birthdayCount = async (guildId, userId) => (await s.count.get(guildId, userId)).n;
