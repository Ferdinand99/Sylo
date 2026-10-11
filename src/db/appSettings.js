// Bot-wide key/value settings (not per guild).
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  );
`);

const getStmt = prepare('SELECT value FROM app_settings WHERE key = ?');
const setStmt = prepare(`
  INSERT INTO app_settings (key, value, updated_at) VALUES (@key, @value, @updatedAt)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

export async function getAppSetting(key) {
  return (await getStmt.get(key))?.value ?? null;
}

export async function setAppSetting(key, value) {
  await setStmt.run({ key, value: String(value), updatedAt: Date.now() });
}

// --- presence / activity --------------------------------------------------

export const PRESENCE_TYPES = ['Playing', 'Listening', 'Watching', 'Competing', 'Custom'];
export const PRESENCE_STATUSES = ['online', 'idle', 'dnd', 'invisible'];

const DEFAULT_PRESENCE = { status: 'online', type: 'Listening', text: '/stats battlefield' };

/** @returns {Promise<{ status: string, type: string, text: string }>} */
export async function getPresenceConfig() {
  try {
    const raw = await getAppSetting('presence');
    if (!raw) return { ...DEFAULT_PRESENCE };
    const p = JSON.parse(raw);
    return {
      status: PRESENCE_STATUSES.includes(p.status) ? p.status : DEFAULT_PRESENCE.status,
      type: PRESENCE_TYPES.includes(p.type) ? p.type : DEFAULT_PRESENCE.type,
      text: String(p.text ?? '').slice(0, 128),
    };
  } catch {
    return { ...DEFAULT_PRESENCE };
  }
}

export async function setPresenceConfig({ status, type, text }) {
  const value = {
    status: PRESENCE_STATUSES.includes(status) ? status : 'online',
    type: PRESENCE_TYPES.includes(type) ? type : 'Custom',
    text: String(text ?? '').slice(0, 128),
  };
  await setAppSetting('presence', JSON.stringify(value));
  return value;
}

// --- announcement ------------------------------------------------------
// A single bot-wide notice shown across the dashboard (not per guild). Owner
// sets/clears it from Bot Personalizer; everyone signed in sees it. 'critical'
// has no dismiss button on the frontend — it stays until the owner clears it.

export const ANNOUNCEMENT_SEVERITIES = ['info', 'warning', 'critical'];

/**
 * @returns {Promise<{ title: string, body: string, severity: string, createdAt: number } | null>}
 */
export async function getAnnouncement() {
  try {
    const raw = await getAppSetting('announcement');
    if (!raw) return null;
    const a = JSON.parse(raw);
    if (!a.title) return null;
    return {
      title: String(a.title).slice(0, 200),
      body: String(a.body ?? '').slice(0, 2000),
      severity: ANNOUNCEMENT_SEVERITIES.includes(a.severity) ? a.severity : 'info',
      createdAt: Number.isFinite(a.createdAt) ? a.createdAt : Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * A blank title clears the announcement instead of saving an empty one.
 * `createdAt` is set fresh on every save, so it also doubles as the
 * frontend's per-announcement dismiss key — replacing a dismissed
 * announcement makes it reappear.
 * @returns {Promise<{ title: string, body: string, severity: string, createdAt: number } | null>}
 */
export async function setAnnouncement({ title, body, severity }) {
  const value = {
    title: String(title ?? '')
      .trim()
      .slice(0, 200),
    body: String(body ?? '')
      .trim()
      .slice(0, 2000),
    severity: ANNOUNCEMENT_SEVERITIES.includes(severity) ? severity : 'info',
    createdAt: Date.now(),
  };
  if (!value.title) {
    await clearAnnouncement();
    return null;
  }
  await setAppSetting('announcement', JSON.stringify(value));
  return value;
}

export async function clearAnnouncement() {
  await setAppSetting('announcement', '');
}
