// The welcome image preview served to both dashboards: a PNG of the welcome card with a sample
// member and the saved background. Shared by the classic route and the /api/v2 one so the two
// cannot drift apart.
import { primaryClient } from '../../platform/platformOf.js';
import { getGuildModule } from '../../db/modules.js';
import { guildEmbedColor } from '../../db/guildSettings.js';
import { renderWelcomeCard } from '../../bot/lib/welcomeCard.js';

/** Render the preview and send it. `guild` is the already-loaded `req.guild`. */
export async function sendWelcomeCardPreview(guild, res) {
  const cfg = (await getGuildModule(guild.id, 'welcome')).config || {};
  const png = await renderWelcomeCard({
    name: 'New Member',
    avatarUrl: primaryClient()?.user?.displayAvatarURL({ extension: 'png', size: 256 }),
    memberCount: guild.memberCount || 0,
    accent: await guildEmbedColor(guild.id),
    backgroundUrl: cfg.cardBackground || undefined,
  });
  if (!png) return res.status(204).end(); // canvas unavailable on this host
  res.set('Cache-Control', 'private, max-age=60').type('png').send(png);
}
