// Off-site database backups: after every local snapshot, ship a gzipped copy to
// a remote destination so a lost disk or a wiped appdata folder isn't the end of
// it. Best-effort — a failure is logged and never blocks the local backup.
//
// Destinations (set any, both, or neither via env — see .env.example):
//   - WebDAV (BACKUP_WEBDAV_URL [+ _USER / _PASS]) — e.g. a Nextcloud folder.
//     The file is PUT to <url>/<name>.db.gz.
//   - Discord webhook (BACKUP_WEBHOOK_URL) — uploaded as an attachment; skipped
//     when the gzipped file is over the ~8 MiB webhook limit.
import { readFile } from 'node:fs/promises';
import { gzip as gzipCb } from 'node:zlib';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { isIP } from 'node:net';
import { config } from '../config.js';
import { log } from '../lib/log.js';
import { encryptBackup } from '../lib/backupCrypto.js';
import { isLocalName, isPrivateAddress } from '../lib/safeFetch.js';

const gzip = promisify(gzipCb);
const DISCORD_ATTACH_MAX = 8 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

/**
 * May a WebDAV upload go to this URL? Basic auth over plain http sends the password in clear,
 * so with credentials it must be https, unless the server is on this machine or the LAN (an
 * address in a private range, or a name without dots such as a container name).
 */
export function webdavTransportOk(url, hasCredentials) {
  if (!hasCredentials) return true;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return isLocalName(host) || (isIP(host) !== 0 && isPrivateAddress(host));
}

/** True when at least one off-site destination is configured. */
export function offsiteBackupConfigured() {
  return Boolean(config.backupWebdavUrl || config.backupWebhookUrl);
}

/** Short label of the configured destinations for the Health page, or null. */
export function offsiteBackupStatus() {
  const to = [];
  if (config.backupWebdavUrl) to.push('WebDAV');
  if (config.backupWebhookUrl) to.push('Discord webhook');
  return to.length ? to.join(' + ') : null;
}

/**
 * Gzip `filePath` and push it to every configured off-site destination.
 * Resolves after all attempts; logs each result; never throws.
 * @param {string} filePath  absolute path to a local .db snapshot
 */
export async function shipOffsiteBackup(filePath) {
  if (!offsiteBackupConfigured()) return;
  const encrypt = Boolean(config.backupEncryptionKey);
  const name = `${basename(filePath)}.gz${encrypt ? '.enc' : ''}`;

  let body;
  try {
    body = await gzip(await readFile(filePath));
    if (encrypt) body = encryptBackup(body, config.backupEncryptionKey);
  } catch (err) {
    log.error('db', `Off-site backup: could not prepare ${basename(filePath)}: ${err.message}`);
    return;
  }

  const jobs = [];
  if (config.backupWebdavUrl) jobs.push(toWebdav(name, body));
  if (config.backupWebhookUrl) jobs.push(toDiscord(name, body));
  await Promise.allSettled(jobs);
}

async function toWebdav(name, body) {
  const url = `${config.backupWebdavUrl.replace(/\/+$/, '')}/${name}`;
  if (!webdavTransportOk(url, Boolean(config.backupWebdavUser))) {
    log.error(
      'db',
      'Off-site backup → WebDAV skipped: a password over plain http; use an https BACKUP_WEBDAV_URL'
    );
    return;
  }
  const headers = { 'content-type': 'application/gzip' };
  if (config.backupWebdavUser) {
    const auth = Buffer.from(`${config.backupWebdavUser}:${config.backupWebdavPass ?? ''}`).toString(
      'base64'
    );
    headers.authorization = `Basic ${auth}`;
  }
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log.info('db', `Off-site backup → WebDAV ${name} (${Math.round(body.length / 1024)} KiB)`);
  } catch (err) {
    log.error('db', `Off-site backup → WebDAV failed: ${err.message}`);
  }
}

async function toDiscord(name, body) {
  if (body.length > DISCORD_ATTACH_MAX) {
    log.warn(
      'db',
      `Off-site backup → Discord skipped: ${name} is ${(body.length / 1024 / 1024).toFixed(1)} MiB ` +
        `(over the ${DISCORD_ATTACH_MAX / 1024 / 1024} MiB webhook limit) — use WebDAV for a database this size`
    );
    return;
  }
  try {
    const form = new FormData();
    form.append(
      'payload_json',
      JSON.stringify({ content: `\`${name}\` · ${Math.round(body.length / 1024)} KiB` })
    );
    form.append('files[0]', new Blob([body], { type: 'application/gzip' }), name);
    const res = await fetch(config.backupWebhookUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log.info('db', `Off-site backup → Discord ${name} (${Math.round(body.length / 1024)} KiB)`);
  } catch (err) {
    log.error('db', `Off-site backup → Discord failed: ${err.message}`);
  }
}
