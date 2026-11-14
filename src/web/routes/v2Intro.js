// JSON API for the Introductions page of the dashboard: the module's settings, and publishing the
// pinned "Introduce yourself" message with its Create my intro button. The rules live in
// modules/introductions.js.
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set, the caller
// manages this server and the state-changing calls have passed the CSRF check.
import { accessRouter } from '../middleware/access.js';
import { currentUser } from '../middleware/auth.js';
import { platformActionLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { assignableRoles } from '../lib/guildContext.js';
import { guildTextChannels } from '../lib/discord.js';
import { recordAudit } from '../../db/audit.js';
import { getGuildModule, setGuildModule } from '../../db/modules.js';
import { introductionCount } from '../../db/introductions.js';
import {
  INTRO_PLACEHOLDERS,
  normaliseIntroductionsConfig,
  publishPrompt,
  unpublishPrompt,
} from '../../modules/introductions.js';

const router = accessRouter('/guilds/:guildId', { mergeParams: true });

const actor = (req) => (currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`);

const savedConfig = async (guildId) =>
  normaliseIntroductionsConfig((await getGuildModule(guildId, 'introductions')).config);

router.get(
  '/modules/introductions/config',
  asyncHandler(async (req, res) => {
    res.json({
      config: await savedConfig(req.guild.id),
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
      placeholders: INTRO_PLACEHOLDERS,
      introductions: await introductionCount(req.guild.id),
    });
  })
);

router.post(
  '/modules/introductions/config',
  asyncHandler(async (req, res) => {
    const prev = await savedConfig(req.guild.id);
    // Which message the prompt is published as is the server's to track, not the form's.
    const config = normaliseIntroductionsConfig({
      ...req.body,
      promptChannelId: prev.promptChannelId,
      promptMessageId: prev.promptMessageId,
    });
    await setGuildModule(req.guild.id, 'introductions', { config });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:introductions',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

// Publish (or update) the prompt message. The channel and text come from the form, so a draft can be
// published without saving first; they are saved with it.
router.post(
  '/modules/introductions/prompt/publish',
  platformActionLimit,
  asyncHandler(async (req, res) => {
    const prev = await savedConfig(req.guild.id);
    const draft = normaliseIntroductionsConfig({
      ...prev,
      channelId: req.body?.channelId ?? prev.channelId,
      promptText: req.body?.promptText ?? prev.promptText,
    });
    const result = await publishPrompt(req.guild, draft);
    if (!result.ok) return res.status(400).json({ error: result.error });
    // Published to another channel: the old prompt (and its button) must not stay behind.
    let warning = '';
    if (prev.promptMessageId && prev.promptChannelId !== result.channelId) {
      const removed = await unpublishPrompt(req.guild, prev);
      if (!removed.ok)
        warning = `The new prompt is published, but the old one was not removed. ${removed.error}`;
    }
    const config = { ...draft, promptChannelId: result.channelId, promptMessageId: result.messageId };
    await setGuildModule(req.guild.id, 'introductions', { config });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:introductions',
      detail: 'published the prompt message',
    });
    res.json({ config, ...(warning && { warning }) });
  })
);

router.post(
  '/modules/introductions/prompt/unpublish',
  asyncHandler(async (req, res) => {
    const prev = await savedConfig(req.guild.id);
    // The stored id stays when the message could not be deleted, so it can be tried again.
    const removed = await unpublishPrompt(req.guild, prev);
    if (!removed.ok) return res.status(502).json({ error: removed.error });
    const config = { ...prev, promptChannelId: '', promptMessageId: '' };
    await setGuildModule(req.guild.id, 'introductions', { config });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:introductions',
      detail: 'removed the prompt message',
    });
    res.json({ config });
  })
);

export default router;
