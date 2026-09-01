// Applies the dashboard-configured presence (status + activity) to the client.
import { ActivityType } from 'discord.js';
import { getPresenceConfig } from '../../db/appSettings.js';
import { log } from '../../lib/log.js';

const TYPE_MAP = {
  Playing: ActivityType.Playing,
  Listening: ActivityType.Listening,
  Watching: ActivityType.Watching,
  Competing: ActivityType.Competing,
  Custom: ActivityType.Custom,
};

/** Substitute {servers} / {members} in the activity text. */
export function fillPresenceText(text, client) {
  const servers = client.guilds.cache.size;
  const members = [...client.guilds.cache.values()].reduce((sum, g) => sum + (g.memberCount ?? 0), 0);
  return String(text ?? '')
    .replaceAll('{servers}', String(servers))
    .replaceAll('{members}', String(members));
}

/** Read the stored presence config and push it to Discord. Never throws. */
export function applyPresence(client) {
  if (!client?.user) return;
  try {
    const cfg = getPresenceConfig();
    const type = TYPE_MAP[cfg.type] ?? ActivityType.Custom;
    const text = fillPresenceText(cfg.text, client).trim();

    const activities = text
      ? [
          type === ActivityType.Custom
            ? { name: 'custom', type, state: text }
            : { name: text, type },
        ]
      : [];

    client.user.setPresence({ status: cfg.status, activities });
  } catch (err) {
    log.error('bot', 'Failed to apply presence:', err.message);
  }
}
