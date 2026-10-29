// Verification / gate: new members must click a Verify button (and optionally
// pass a Cloudflare Turnstile captcha on the dashboard) to get a role.
//
// config shape:
//   {
//     mode: 'button' | 'captcha',       // captcha falls back to button when Turnstile is unconfigured
//     verifiedRoleId: '',
//     channelId: '',                    // where the verify message is posted
//     messageId: '',                    // id of that message (bot-managed)
//     title: 'Verification',
//     message: '...',
//     successMessage: '...',
//     logChannelId: '',
//     kickAfterMinutes: 0,              // 0 = never kick unverified
//   }
import { allClientsReady, guildByKey, guildKey } from '../platform/platformOf.js';
import {
  clearVerificationKick,
  dueVerificationKicks,
  scheduleVerificationKick,
} from '../db/verificationKicks.js';
import { signToken, verifyToken } from '../lib/signedToken.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { on } from './dispatch.js';
import { registerComponent } from '../bot/lib/components.js';
import { config } from '../config.js';
import { getGuildModule, setGuildModule, isModuleEnabled } from '../db/modules.js';
import { isPlatformGuildId } from '../lib/platformId.js';
import { sendToChannel } from './lib/send.js';
import { log } from '../lib/log.js';
import { every } from './schedule.js';

export const VERIFY_MODES = ['button', 'captcha'];
const TOKEN_TTL_MS = 15 * 60 * 1000;

const DEFAULTS = {
  mode: 'button',
  verifiedRoleId: '',
  channelId: '',
  messageId: '',
  title: 'Verification',
  message: 'Click the button below to verify and unlock the rest of the server.',
  successMessage: 'You are verified — welcome!',
  logChannelId: '',
  kickAfterMinutes: 0,
};

/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  title: { maxLength: 200 },
  message: { maxLength: 1500 },
  successMessage: { maxLength: 1000 },
  kickAfterMinutes: { min: 0, max: 10080 },
};

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
const id = (v) => (/^\d{17,20}$/.test(v ?? '') ? v : '');

export function normaliseVerificationConfig(raw = {}) {
  return {
    mode: VERIFY_MODES.includes(raw.mode) ? raw.mode : 'button',
    verifiedRoleId: id(raw.verifiedRoleId),
    channelId: id(raw.channelId),
    messageId: id(raw.messageId),
    title: String(raw.title ?? DEFAULTS.title).slice(0, LIMITS.title.maxLength) || DEFAULTS.title,
    message: String(raw.message ?? DEFAULTS.message).slice(0, LIMITS.message.maxLength) || DEFAULTS.message,
    successMessage:
      String(raw.successMessage ?? DEFAULTS.successMessage).slice(0, LIMITS.successMessage.maxLength) ||
      DEFAULTS.successMessage,
    logChannelId: id(raw.logChannelId),
    kickAfterMinutes: clampInt(
      raw.kickAfterMinutes,
      LIMITS.kickAfterMinutes.min,
      LIMITS.kickAfterMinutes.max,
      0
    ),
  };
}

/** Effective mode — captcha only when Turnstile keys are configured. */
export function effectiveMode(cfg) {
  return cfg.mode === 'captcha' && config.turnstileEnabled ? 'captcha' : 'button';
}

// --- signed link tokens --------------------------------------------------

// Signed with the "verify" purpose, so an appeal link (same shape) is not a verification link.
export function signVerifyToken(guildId, userId) {
  return signToken([guildId, userId], TOKEN_TTL_MS, { purpose: 'verify' });
}

/** @returns {{ guildId: string, userId: string } | null} */
export function verifyVerifyToken(token) {
  const parts = verifyToken(token, 2, { purpose: 'verify' });
  if (!parts) return null;
  const [guildId, userId] = parts;
  if (!isPlatformGuildId(guildId) || !/^\d{17,20}$/.test(userId)) return null;
  return { guildId, userId };
}

// --- the verify message ------------------------------------------------------

function verifyButtonRow(label = 'Verify') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify:start').setStyle(ButtonStyle.Success).setLabel(`✅ ${label}`)
  );
}

/** Make sure the guild's verify message exists; (re)post it and store the id. */
export async function ensureVerifyMessage(guild, cfg) {
  if (!cfg.channelId || !cfg.verifiedRoleId) return;
  const channel =
    guild.channels.cache.get(cfg.channelId) ?? (await guild.channels.fetch(cfg.channelId).catch(() => null));
  if (!channel?.isTextBased()) return;
  const me = guild.members.me;
  if (!channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) return;

  if (cfg.messageId) {
    const existing = await channel.messages.fetch(cfg.messageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [verifyEmbed(cfg)], components: [verifyButtonRow()] }).catch(() => {});
      return;
    }
  }
  const posted = await channel
    .send({ embeds: [verifyEmbed(cfg)], components: [verifyButtonRow()] })
    .catch(() => null);
  if (!posted) return;
  const fresh = (await getGuildModule(guildKey(guild), 'verification')).config;
  await setGuildModule(guildKey(guild), 'verification', { config: { ...fresh, messageId: posted.id } });
}

function verifyEmbed(cfg) {
  return new EmbedBuilder().setColor(0x58d68d).setTitle(cfg.title).setDescription(cfg.message);
}

// --- granting the role -----------------------------------------------------

/** Add the verified role and log it. Returns 'ok' | 'already' | 'norole' | 'fail'. */
export async function grantVerified(guild, userId, cfg) {
  if (!cfg.verifiedRoleId) return 'norole';
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return 'fail';
  if (member.roles.cache.has(cfg.verifiedRoleId)) return 'already';

  const role = guild.roles.cache.get(cfg.verifiedRoleId);
  if (!role || !role.editable) return 'fail';

  try {
    await member.roles.add(role, 'Verification passed');
  } catch {
    return 'fail';
  }

  if (cfg.logChannelId) {
    await sendToChannel(guildKey(guild), cfg.logChannelId, {
      embeds: [
        new EmbedBuilder()
          .setColor(0x58d68d)
          .setDescription(`✅ ${member.user.tag} (\`${member.id}\`) verified`)
          .setTimestamp(Date.now()),
      ],
    });
  }
  return 'ok';
}

// --- interaction handler (Verify button) ---------------------------------

async function handleVerifyButton(interaction) {
  if (!interaction.inGuild() || !(await isModuleEnabled(interaction.guildId, 'verification'))) {
    return interaction.reply({
      content: 'Verification is not active here.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const cfg = normaliseVerificationConfig((await getGuildModule(interaction.guildId, 'verification')).config);
  if (!cfg.verifiedRoleId) {
    return interaction.reply({
      content: 'Verification is misconfigured — no role is set.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (interaction.member.roles.cache.has(cfg.verifiedRoleId)) {
    return interaction.reply({ content: 'You are already verified.', flags: MessageFlags.Ephemeral });
  }

  if (effectiveMode(cfg) === 'captcha' && config.dashboardUrl) {
    const url = `${config.dashboardUrl}/verify/${interaction.guildId}?t=${signVerifyToken(interaction.guildId, interaction.user.id)}`;
    return interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: 'One quick check — open the link below to finish verifying. It expires in 15 minutes.',
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Complete verification').setURL(url)
        ),
      ],
    });
  }

  const result = await grantVerified(interaction.guild, interaction.user.id, cfg);
  const msg =
    result === 'ok'
      ? cfg.successMessage
      : result === 'already'
        ? 'You are already verified.'
        : "That didn't work — the bot may be missing Manage Roles, or its role is below the verified role.";
  return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
}

registerComponent('verification', 'verify:start', handleVerifyButton);

// --- kick unverified after a grace period -------------------------------

on('verification', 'guildMemberAdd', async (member, rawConfig) => {
  const cfg = normaliseVerificationConfig(rawConfig);
  // Ensure the verify message still exists (cheap no-op if it does).
  await ensureVerifyMessage(member.guild, cfg).catch(() => {});

  if (cfg.kickAfterMinutes <= 0 || !cfg.verifiedRoleId) return;
  // Stored, not a timer: a restart within the grace period must not cancel the kick.
  await scheduleVerificationKick({
    guildId: guildKey(member.guild),
    userId: member.id,
    dueAt: Date.now() + cfg.kickAfterMinutes * 60_000,
  });
});

/** Kick the members whose grace period has passed and who are still not verified. */
export async function sweepVerificationKicks(now = Date.now()) {
  for (const row of await dueVerificationKicks(now)) {
    await clearVerificationKick(row.guild_id, row.user_id); // first, so a failure cannot loop
    try {
      const guild = guildByKey(row.guild_id);
      if (!guild || !(await isModuleEnabled(row.guild_id, 'verification'))) continue;
      const fresh = normaliseVerificationConfig((await getGuildModule(row.guild_id, 'verification')).config);
      if (!fresh.verifiedRoleId || fresh.kickAfterMinutes <= 0) continue;
      const m = await guild.members.fetch(row.user_id).catch(() => null);
      if (!m || m.roles.cache.has(fresh.verifiedRoleId) || !m.kickable) continue;
      await m.kick(`Did not verify within ${fresh.kickAfterMinutes} minutes`).catch(() => {});
    } catch (err) {
      log.warn('verification', `kick check failed: ${err.message}`);
    }
  }
}

const KICK_TICK_MS = 60_000;
every('verification', KICK_TICK_MS, () => {
  if (!allClientsReady()) return;
  sweepVerificationKicks().catch((err) => log.error('verification', 'kick sweep failed:', err.message));
});
