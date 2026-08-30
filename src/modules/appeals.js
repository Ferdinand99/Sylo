// Ban appeals — when a member is banned, Sylo DMs them a signed link to an
// appeal form on the dashboard. Staff accept or deny it (with a reason) from the
// Appeals tab; the bot then DMs the outcome and, on accept, lifts the ban.
//
// The link is DM'd *before* the ban is carried out (from /ban and the
// warn-threshold flow) because a bot can't DM a user it no longer shares a
// guild with. The guildBanAdd handler is only a fallback for bans made outside
// Sylo (a manual Discord ban, another bot).
//
// config shape:
//   {
//     questions: string[],        // 1..5 prompts shown on the appeal form
//     autoUnbanOnAccept: boolean, // lift the ban automatically when accepted
//     reviewChannelId: '',        // staff channel that gets new-appeal / decision notices
//     cooldownDays: 7,            // wait after a denied appeal before another is allowed
//     appealMessage: '',         // extra line added to the ban DM
//     appealServerInvite: '',    // optional invite to a server Sylo is also in, so
//                                // it can DM the decision (a banned user shares no
//                                // guild with the bot otherwise)
//   }
//
// The decision is always shown on the appeal page itself when the user reopens
// their link, so notification never depends on the DM succeeding.
import { ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { on } from './dispatch.js';
import { config } from '../config.js';
import { signToken, verifyToken } from '../lib/signedToken.js';
import { getGuildModule, isModuleEnabled } from '../db/modules.js';
import { decideAppeal, setAppealInvite } from '../db/appeals.js';
import { sendToChannel } from './lib/send.js';
import { postModLog } from '../bot/lib/modlog.js';

const TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days — link must outlast a slow review
const COLOR = 0xb4472b;
const OK_COLOR = 0x58d68d;

export const DEFAULT_QUESTIONS = [
  'Why were you banned?',
  'Why should your ban be lifted?',
  'What will you do differently if your appeal is accepted?',
];

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
const id = (v) => (/^\d{17,20}$/.test(v ?? '') ? v : '');
const inviteUrl = (v) => {
  const s = String(v ?? '').trim();
  return /^https:\/\/(discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+$/i.test(s) ? s : '';
};

/** @param {object} raw */
export function normaliseAppealsConfig(raw = {}) {
  const questions = (Array.isArray(raw.questions) ? raw.questions : [])
    .map((q) => String(q ?? '').trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 5);
  return {
    questions: questions.length ? questions : [...DEFAULT_QUESTIONS],
    autoUnbanOnAccept: raw.autoUnbanOnAccept !== false,
    reviewChannelId: id(raw.reviewChannelId),
    cooldownDays: clampInt(raw.cooldownDays, 0, 90, 7),
    appealMessage: String(raw.appealMessage ?? '').slice(0, 1000),
    appealServerInvite: inviteUrl(raw.appealServerInvite),
  };
}

// --- signed appeal link --------------------------------------------------

export function signAppealToken(guildId, userId) {
  return signToken([guildId, userId], TOKEN_TTL_MS);
}

/** @returns {{ guildId: string, userId: string } | null} */
export function verifyAppealToken(token) {
  const parts = verifyToken(token, 2);
  if (!parts) return null;
  const [guildId, userId] = parts;
  if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(userId)) return null;
  return { guildId, userId };
}

/** Full appeal URL for a user, or null when no dashboard URL is configured. */
export function appealLink(guildId, userId) {
  if (!config.dashboardUrl) return null;
  return `${config.dashboardUrl.replace(/\/$/, '')}/appeal/${guildId}?t=${signAppealToken(guildId, userId)}`;
}

/** Whether a denied appeal still blocks a new one under the cooldown. */
export function cooldownRemainingMs(latestAppeal, cooldownDays) {
  if (!latestAppeal || latestAppeal.status !== 'denied' || !cooldownDays) return 0;
  const until = (latestAppeal.decided_at ?? latestAppeal.created_at) + cooldownDays * 86_400_000;
  return Math.max(0, until - Date.now());
}

// --- ban -> DM the appeal link -----------------------------------------

/** The DM a banned user receives, carrying the appeal link. */
function banAppealEmbed(guildName, reason, link, cfg) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`You were banned from ${guildName}`)
    .addFields(
      { name: 'Reason', value: String(reason || 'No reason provided').slice(0, 1024) },
      { name: 'Appeal this ban', value: `If you believe this was a mistake, submit an appeal here:\n${link}` },
      { name: 'The decision', value: 'Reopen the link above at any time to see whether your appeal was accepted or denied. The link is valid for 60 days.' }
    )
    .setTimestamp(Date.now());
  if (cfg.appealServerInvite) {
    embed.addFields({
      name: 'Prefer a DM?',
      value: `Join ${cfg.appealServerInvite} so Sylo shares a server with you, and it will DM you the outcome too.`,
    });
  }
  if (cfg.appealMessage) embed.addFields({ name: 'From the moderators', value: cfg.appealMessage.slice(0, 1024) });
  return embed;
}

// Sylo's own /ban and warn-threshold flows DM the link *before* the ban lands
// (you can't DM a user you no longer share a guild with). This short-lived map
// lets the guildBanAdd handler below skip a doomed second attempt.
const preBanDmed = new Map(); // `${guildId}:${userId}` -> { expires, sent }
const PRE_BAN_TTL_MS = 60_000;

function rememberPreBanDm(guildId, userId, sent) {
  preBanDmed.set(`${guildId}:${userId}`, { expires: Date.now() + PRE_BAN_TTL_MS, sent });
}
function takePreBanDm(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const rec = preBanDmed.get(key);
  preBanDmed.delete(key);
  return rec && rec.expires > Date.now() ? rec : null;
}

/**
 * DM the appeal link to a member who is about to be banned. Call this *before*
 * `guild.bans.create()`.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').User} user
 * @param {string} reason
 * @returns {Promise<boolean | null>} true/false when appeals handled the DM
 *   (delivered or not); null when the module is off / no dashboard URL, so the
 *   caller should send its own ban DM instead.
 */
export async function sendPreBanAppealDm(guild, user, reason) {
  if (!isModuleEnabled(guild.id, 'appeals')) return null;
  const link = appealLink(guild.id, user.id);
  if (!link) return null;
  const cfg = normaliseAppealsConfig(getGuildModule(guild.id, 'appeals').config);
  const sent = await user
    .send({ embeds: [banAppealEmbed(guild.name, reason, link, cfg)] })
    .then(() => true)
    .catch(() => false);
  rememberPreBanDm(guild.id, user.id, sent);
  return sent;
}

on('appeals', 'guildBanAdd', async (ban, rawConfig) => {
  const user = ban.user;
  if (!user || user.bot) return;
  const cfg = normaliseAppealsConfig(rawConfig);

  const link = appealLink(ban.guild.id, user.id);
  if (!link) {
    console.warn('[appeals] DASHBOARD_URL is not set — cannot build an appeal link.');
    return;
  }

  // The event's reason is often null; the ban list carries it.
  let reason = ban.reason ?? null;
  if (!reason) {
    reason = await ban.guild.bans.fetch(user.id).then((b) => b.reason).catch(() => null);
  }
  reason = reason || 'No reason recorded';

  // Did Sylo's own ban flow already DM the link (before the ban)?
  const pre = takePreBanDm(ban.guild.id, user.id);
  const delivered = pre
    ? pre.sent
    : await user
        .send({ embeds: [banAppealEmbed(ban.guild.name, reason, link, cfg)] })
        .then(() => true)
        .catch(() => false);

  if (cfg.reviewChannelId) {
    await sendToChannel(ban.guild.id, cfg.reviewChannelId, {
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR)
          .setTitle('⚖️ Ban appeal link issued')
          .setDescription(`${user.tag} (\`${user.id}\`) was banned.`)
          .addFields(
            { name: 'Reason', value: String(reason).slice(0, 1024) },
            {
              name: 'Appeal DM',
              value: delivered
                ? 'Delivered'
                : 'Not delivered (their DMs are closed) — share the link below manually',
            },
            { name: 'Appeal link', value: link }
          )
          .setTimestamp(Date.now()),
      ],
      allowedMentions: { parse: [] },
    });
  }
});

// --- decide an appeal (called from the dashboard) ----------------------

/**
 * Create a one-time invite so an unbanned user can rejoin. Best-effort — needs
 * Create Invite and a channel to anchor it to. Returns the invite URL or null.
 * @param {import('discord.js').Guild} guild
 */
export async function createRejoinInvite(guild) {
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.CreateInstantInvite)) return null;

  const canInvite = (ch) =>
    ch &&
    (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) &&
    ch.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite);

  const target =
    (canInvite(guild.rulesChannel) && guild.rulesChannel) ||
    (canInvite(guild.systemChannel) && guild.systemChannel) ||
    [...guild.channels.cache.values()]
      .filter(canInvite)
      .sort((a, b) => a.rawPosition - b.rawPosition)[0];
  if (!target) return null;

  try {
    const invite = await guild.invites.create(target.id, {
      maxAge: 7 * 86_400, // 7 days
      maxUses: 1,
      unique: true,
      reason: 'Ban appeal accepted — single-use rejoin link',
    });
    return invite.url;
  } catch {
    return null;
  }
}

/**
 * Record a decision, optionally lift the ban, DM the user, and log it.
 * @param {import('discord.js').Guild} guild
 * @param {object} appeal            row from db/appeals.js (answers parsed)
 * @param {{ status: 'accepted' | 'denied', decidedBy: string, reason: string }} decision
 * @returns {Promise<{ recorded: boolean, unbanned: boolean, dmDelivered: boolean, inviteUrl: string | null }>}
 */
export async function decideAndNotify(guild, appeal, { status, decidedBy, reason }) {
  const recorded = decideAppeal(guild.id, appeal.id, { status, decidedBy, reason });
  if (!recorded) return { recorded: false, unbanned: false, dmDelivered: false, inviteUrl: null };

  const cfg = normaliseAppealsConfig(getGuildModule(guild.id, 'appeals').config);
  const accepted = status === 'accepted';

  let unbanned = false;
  if (accepted && cfg.autoUnbanOnAccept) {
    if (guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
      unbanned = await guild.bans
        .remove(appeal.user_id, `Ban appeal #${appeal.id} accepted by ${decidedBy}`)
        .then(() => true)
        .catch(() => false);
    }
  }

  // On accept, mint a single-use rejoin invite and store it on the appeal so the
  // appeal page can show it when the user reopens their link.
  let inviteUrl = null;
  if (accepted) {
    inviteUrl = await createRejoinInvite(guild);
    if (inviteUrl) setAppealInvite(guild.id, appeal.id, inviteUrl);
  }

  const dm = new EmbedBuilder()
    .setColor(accepted ? OK_COLOR : COLOR)
    .setTitle(accepted ? `✅ Your ban appeal for ${guild.name} was accepted` : `❌ Your ban appeal for ${guild.name} was denied`)
    .addFields({ name: 'Reason', value: String(reason || '—').slice(0, 1024) })
    .setTimestamp(Date.now());
  if (accepted) {
    dm.addFields({
      name: 'What happens now',
      value: unbanned
        ? 'Your ban has been lifted — you can rejoin the server.'
        : 'A moderator will remove your ban shortly.',
    });
    if (inviteUrl) dm.addFields({ name: 'Rejoin link (single use)', value: inviteUrl });
  } else if (cfg.cooldownDays) {
    dm.addFields({ name: 'Appealing again', value: `You can submit a new appeal in ${cfg.cooldownDays} day(s).` });
  }

  const dmDelivered = await guild.client.users
    .fetch(appeal.user_id)
    .then((u) => u.send({ embeds: [dm] }))
    .then(() => true)
    .catch(() => false);

  const logEmbed = new EmbedBuilder()
    .setColor(accepted ? OK_COLOR : COLOR)
    .setTitle(accepted ? 'Ban appeal accepted' : 'Ban appeal denied')
    .setDescription(`${appeal.user_tag || appeal.user_id} (\`${appeal.user_id}\`) · appeal #${appeal.id}`)
    .addFields(
      { name: 'Decided by', value: decidedBy },
      { name: 'Reason', value: String(reason || '—').slice(0, 1024) },
      { name: 'Ban lifted', value: accepted ? (unbanned ? 'Yes (automatic)' : 'No — do it manually') : 'n/a' },
      {
        name: 'User notified',
        value: dmDelivered
          ? 'Yes (DM sent)'
          : 'No DM (no shared server) — they see it on their appeal link',
      }
    )
    .setTimestamp(Date.now());
  if (accepted) {
    logEmbed.addFields({ name: 'Rejoin invite', value: inviteUrl || 'Could not create one (missing Create Invite)' });
  }
  await postModLog(guild, logEmbed);
  if (cfg.reviewChannelId) {
    await sendToChannel(guild.id, cfg.reviewChannelId, { embeds: [logEmbed], allowedMentions: { parse: [] } });
  }

  return { recorded: true, unbanned, dmDelivered, inviteUrl };
}

/** Post a "new appeal submitted" notice to staff. Called from the web route. */
export async function announceNewAppeal(guild, appeal) {
  const cfg = normaliseAppealsConfig(getGuildModule(guild.id, 'appeals').config);
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('⚖️ New ban appeal')
    .setDescription(`${appeal.user_tag || appeal.user_id} (\`${appeal.user_id}\`) · appeal #${appeal.id}`)
    .addFields(
      ...appeal.answers.slice(0, 5).map((qa) => ({
        name: String(qa.q || 'Question').slice(0, 256),
        value: String(qa.a || '—').slice(0, 1024),
      })),
      { name: 'Review', value: `${config.dashboardUrl ? config.dashboardUrl.replace(/\/$/, '') : ''}/guilds/${guild.id}/appeals` }
    )
    .setTimestamp(Date.now());
  await postModLog(guild, embed);
  if (cfg.reviewChannelId) {
    await sendToChannel(guild.id, cfg.reviewChannelId, { embeds: [embed], allowedMentions: { parse: [] } });
  }
}
