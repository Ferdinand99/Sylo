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

const rotations = new WeakMap();

/** Read the stored presence config and push it to Discord. Never throws. */
export async function applyPresence(client, { force = true, now = Date.now(), random = Math.random } = {}) {
  if (!client?.user) return;
  try {
    const cfg = await getPresenceConfig();
    const signature = JSON.stringify(cfg);
    const previous = rotations.get(client);
    if (!force && previous?.signature === signature && now < previous.nextAt) return;
    const choices = cfg.texts.length ? cfg.texts : [cfg.text];
    const poolSignature = JSON.stringify(choices);
    // Drawing without replacement is a shuffled cycle. Keep the remaining
    // pool across status/interval changes, resetting only when texts change.
    const remaining =
      previous?.poolSignature === poolSignature && previous.remaining.length
        ? [...previous.remaining]
        : [...choices];
    // At the boundary between cycles, do not repeat the last displayed line.
    const candidates = remaining.length > 1 ? remaining.filter((text) => text !== previous?.text) : remaining;
    const chosen = candidates[Math.floor(random() * candidates.length)];
    remaining.splice(remaining.indexOf(chosen), 1);
    const type = TYPE_MAP[cfg.type] ?? ActivityType.Custom;
    const text = fillPresenceText(chosen, client).trim().slice(0, 128);

    const activities = text
      ? [type === ActivityType.Custom ? { name: 'custom', type, state: text } : { name: text, type }]
      : [];

    client.user.setPresence({ status: cfg.status, activities });
    rotations.set(client, {
      signature,
      poolSignature,
      remaining,
      text: chosen,
      nextAt: now + cfg.rotationSeconds * 1000,
    });
  } catch (err) {
    log.error('bot', 'Failed to apply presence:', err.message);
  }
}
