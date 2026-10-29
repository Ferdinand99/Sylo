// YouTube WebSub subscriptions: one row per YouTube channel the hub should push for. Not a guild
// table (the hub pushes once per channel, Sylo fans out to every guild watching it); a row goes
// when no guild watches the channel any more, see unsubscribe() in src/modules/youtubeWebsub.js.
//
//   secret            32 random bytes as hex, given to the hub as hub.secret; signs every push
//   wanted            1 = we want this subscription, 0 = unsubscribe requested, awaiting the
//                     hub's verification (the row is deleted when it arrives)
//   lease_expires_at  epoch ms the hub agreed to push until; NULL = not verified yet
//   last_notified_at  epoch ms of the last signed push
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS youtube_websub (
    channel_id       TEXT PRIMARY KEY,
    secret           TEXT NOT NULL,
    wanted           INTEGER NOT NULL DEFAULT 1,
    lease_expires_at BIGINT,
    last_notified_at BIGINT
  );
  CREATE INDEX IF NOT EXISTS idx_youtube_websub_lease ON youtube_websub (lease_expires_at);
`);

const s = {
  get: prepare('SELECT * FROM youtube_websub WHERE channel_id = ?'),
  all: prepare('SELECT * FROM youtube_websub ORDER BY channel_id'),
  want: prepare(`
    INSERT INTO youtube_websub (channel_id, secret, wanted) VALUES (@channelId, @secret, 1)
    ON CONFLICT (channel_id) DO UPDATE SET wanted = 1
  `),
  unwant: prepare('UPDATE youtube_websub SET wanted = 0 WHERE channel_id = ?'),
  lease: prepare('UPDATE youtube_websub SET lease_expires_at = ? WHERE channel_id = ?'),
  notified: prepare('UPDATE youtube_websub SET last_notified_at = ? WHERE channel_id = ?'),
  del: prepare('DELETE FROM youtube_websub WHERE channel_id = ?'),
  due: prepare(`
    SELECT * FROM youtube_websub
    WHERE wanted = 1 AND (lease_expires_at IS NULL OR lease_expires_at < ?)
    ORDER BY channel_id
  `),
};

/** @typedef {{ channel_id: string, secret: string, wanted: number, lease_expires_at: number|null, last_notified_at: number|null }} WebsubRow */

const norm = (r) =>
  r && {
    ...r,
    wanted: Number(r.wanted),
    lease_expires_at: r.lease_expires_at == null ? null : Number(r.lease_expires_at),
    last_notified_at: r.last_notified_at == null ? null : Number(r.last_notified_at),
  };

/** @returns {Promise<WebsubRow|null>} */
export async function getWebsub(channelId) {
  return norm(await s.get.get(channelId)) ?? null;
}

/** @returns {Promise<WebsubRow[]>} */
export async function allWebsub() {
  return (await s.all.all()).map(norm);
}

/**
 * Start (or resume) wanting a subscription. A new row gets `secret`; an existing row keeps its
 * secret and lease, so a renewal never invalidates pushes the hub signed with the old one.
 */
export async function wantWebsub(channelId, secret) {
  await s.want.run({ channelId, secret });
}

export async function unwantWebsub(channelId) {
  await s.unwant.run(channelId);
}

export async function setWebsubLease(channelId, leaseExpiresAt) {
  await s.lease.run(leaseExpiresAt, channelId);
}

export async function touchWebsubNotified(channelId, now = Date.now()) {
  await s.notified.run(now, channelId);
}

export async function deleteWebsub(channelId) {
  await s.del.run(channelId);
}

/**
 * Wanted rows whose lease is not verified yet or ends before `before` (epoch ms): the ones to
 * (re)subscribe now.
 * @returns {Promise<WebsubRow[]>}
 */
export async function websubDueBefore(before) {
  return (await s.due.all(before)).map(norm);
}
