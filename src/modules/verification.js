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
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { on } from './dispatch.js';
import { registerComponent } from '../bot/lib/components.js';
import { config } from '../config.js';
import { getGuildModule, setGuildModule, isModuleEnabled } from '../db/modules.js';
import { sendToChannel } from './lib/send.js';

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
    title: String(raw.title ?? DEFAULTS.title).slice(0, 200) || DEFAULTS.title,
    message: String(raw.message ?? DEFAULTS.message).slice(0, 1500) || DEFAULTS.message,
    successMessage:
      String(raw.successMessage ?? DEFAULTS.successMessage).slice(0, 1000) || DEFAULTS.successMessage,
    logChannelId: id(raw.logChannelId),
    kickAfterMinutes: clampInt(raw.kickAfterMinutes, 0, 10080, 0),
  };
}

/** Effective mode — captcha only when Turnstile keys are configured. */
export function effectiveMode(cfg) {
  return cfg.mode === 'captcha' && config.turnstileEnabled ? 'captcha' : 'button';
}

// --- signed link tokens --------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function signVerifyToken(guildId, userId) {
  const body = `${guildId}.${userId}.${Date.now() + TOKEN_TTL_MS}`;
  const sig = createHmac('sha256', config.sessionSecret).update(body).digest();
  return `${b64url(body)}.${b64url(sig)}`;
}

/** @returns {{ guildId: string, userId: string } | null} */
export function verifyVerifyToken(token) {
  try {
    const [bodyB64, sigB64] = String(token).split('.');
    if (!bodyB64 || !sigB64) return null;
    const body = Buffer.from(bodyB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    const expected = createHmac('sha256', config.sessionSecret).update(body).digest();
    const got = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    const [guildId, userId, exp] = body.split('.');
    if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(userId)) return null;
    if (Date.now() > Number(exp)) return null;
    return { guildId, userId };
  } catch {
    return null;
  }
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
  const fresh = getGuildModule(guild.id, 'verification').config;
  setGuildModule(guild.id, 'verification', { config: { ...fresh, messageId: posted.id } });
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
    await sendToChannel(guild.id, cfg.logChannelId, {
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
  if (!interaction.inGuild() || !isModuleEnabled(interaction.guildId, 'verification')) {
    return interaction.reply({
      content: 'Verification is not active here.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const cfg = normaliseVerificationConfig(getGuildModule(interaction.guildId, 'verification').config);
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
  const graceMs = cfg.kickAfterMinutes * 60_000;
  setTimeout(async () => {
    try {
      if (!isModuleEnabled(member.guild.id, 'verification')) return;
      const fresh = normaliseVerificationConfig(getGuildModule(member.guild.id, 'verification').config);
      const m = await member.guild.members.fetch(member.id).catch(() => null);
      if (!m || m.roles.cache.has(fresh.verifiedRoleId) || !m.kickable) return;
      await m.kick(`Did not verify within ${fresh.kickAfterMinutes} minutes`).catch(() => {});
    } catch {
      /* best-effort */
    }
  }, graceMs).unref();
});
