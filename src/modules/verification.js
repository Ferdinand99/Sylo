// Verification / gate: new members must click a Verify button (and optionally
// pass a Cloudflare Turnstile captcha on the dashboard) to get a role.
//
// config shape:
//   {
//     mode: 'button' | 'captcha',       // captcha falls back to button when Turnstile is unconfigured
//     verifiedRoleId: '',
//     channelId: '',                    // where the verify message is posted
//     messageId: '',                    // id of that message (bot-managed)
//     messageChannelId: '',             // channel that message is in (bot-managed; empty = channelId)
//     title: 'Verification',
//     message: '...',
//     successMessage: '...',
//     logChannelId: '',
//     kickAfterMinutes: 0,              // 0 = never kick unverified
//   }
import { allClientsReady, guildByKey, guildKey, platformOfGuild } from '../platform/platformOf.js';
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
import { isMessageGone, isPermissionDenied } from '../platform/messageErrors.js';
import { deleteComponentActions } from '../db/componentReactions.js';

export const VERIFY_MODES = ['button', 'captcha'];
const TOKEN_TTL_MS = 15 * 60 * 1000;

const DEFAULTS = {
  mode: 'button',
  verifiedRoleId: '',
  channelId: '',
  messageId: '',
  messageChannelId: '',
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
    messageChannelId: id(raw.messageChannelId),
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

// Fetching the message by id needs Read Message History on top of what posting needs. Without it
// the fetch fails like a deleted message would, and every join used to post a new one.
const VERIFY_PERMS = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'];

// Checks of one server run one at a time, and at most one more waits behind the running one: a
// check reads the stored config when it starts, so everything that asks while one is waiting is
// answered by that one. A raid of joins is then one or two checks, not one per join.
const ensureSlots = new Map(); // guild key -> { running, next }
const warnedPermissions = new Set(); // guild keys already told about a missing permission

export const _internals = {
  warnedPermissions,
  /** Time a call to the platform may take inside a check. */
  timeoutMs: 15_000,
  /** Resolves when no check of this guild is running or waiting (for tests). */
  async settled(guild) {
    const key = guildKey(guild);
    for (let slot = ensureSlots.get(key); slot; slot = ensureSlots.get(key)) {
      await (slot.next ?? slot.running)?.catch(() => {});
    }
  },
};

/** A call to the platform that never answers must not hold the server's checks for ever. */
function within(promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} took longer than ${_internals.timeoutMs} ms`)),
      _internals.timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Make sure the guild's verify message exists, from the config stored now. It is edited in place
 * when it is in the channel, posted again only when the platform says it is gone, and, when the
 * channel changed, posted in the new channel with the old one deleted after the new id is stored.
 * A missing permission or a failed lookup is logged and stops: it never posts. The stored
 * `messageChannelId` says where the message is.
 */
export function ensureVerifyMessage(guild) {
  const key = guildKey(guild);
  let slot = ensureSlots.get(key);
  if (!slot) ensureSlots.set(key, (slot = { running: null, next: null }));
  if (slot.next) return slot.next; // one is waiting already: it will see the newest config

  const start = () => {
    const run = ensureVerifyMessageOnce(guild).finally(() => {
      slot.running = null;
      if (!slot.next && ensureSlots.get(key) === slot) ensureSlots.delete(key); // idle: forget the server
    });
    slot.running = run;
    return run;
  };
  if (!slot.running) return start();
  slot.next = slot.running
    .catch(() => {})
    .then(() => {
      slot.next = null;
      return start();
    });
  return slot.next;
}

async function ensureVerifyMessageOnce(guild) {
  const key = guildKey(guild);
  // Everything comes from the stored config, as it is now, not from what the caller saw earlier.
  const cfg = normaliseVerificationConfig((await getGuildModule(key, 'verification')).config);
  if (!cfg.channelId || !cfg.verifiedRoleId) return;
  const postedIn = cfg.messageId ? cfg.messageChannelId || cfg.channelId : '';
  const moved = Boolean(cfg.messageId) && postedIn !== cfg.channelId;

  const channel =
    guild.channels.cache.get(cfg.channelId) ??
    (await within(guild.channels.fetch(cfg.channelId), 'looking up the verify channel').catch(() => null));
  if (!channel?.isTextBased()) return;
  const me = guild.members.me;
  if (!channel.permissionsFor(me)?.has(VERIFY_PERMS)) {
    // Once per server and run: this check runs on every join.
    if (!warnedPermissions.has(key)) {
      warnedPermissions.add(key);
      log.warn(
        'verification',
        `missing permissions (need ${VERIFY_PERMS.join(', ')}) for the verify message in ${key}, channel ${cfg.channelId}`
      );
    }
    return;
  }

  const store = async (messageId) => {
    const fresh = (await getGuildModule(key, 'verification')).config;
    await setGuildModule(key, 'verification', {
      config: { ...fresh, messageId, messageChannelId: cfg.channelId },
    });
  };

  if (cfg.messageId && !moved) {
    let existing = null;
    try {
      existing = await within(channel.messages.fetch(cfg.messageId), 'looking up the verify message');
    } catch (err) {
      // Only "it is gone" means post again. A permission error, a timeout or a 5xx must not.
      if (!isMessageGone(err)) {
        log.warn(
          'verification',
          `could not look up the verify message in ${key}, not posting a new one:`,
          err
        );
        return;
      }
    }
    if (existing) {
      await within(
        existing.edit({ embeds: [verifyEmbed(cfg)], components: [verifyButtonRow()] }),
        'editing the verify message'
      ).catch(() => {});
      if (cfg.messageChannelId !== cfg.channelId) await store(cfg.messageId); // an older config: keep the channel too
      return;
    }
  }
  const posted = await within(
    channel.send({ embeds: [verifyEmbed(cfg)], components: [verifyButtonRow()] }),
    'posting the verify message'
  ).catch((err) => {
    log.warn('verification', `could not post the verify message in ${key}:`, err);
    return null;
  });
  if (!posted) return;
  // Store the new post first; the old one is deleted only after that. When the store fails the new
  // post goes again, so the stored pair and the old message still belong together.
  try {
    await store(posted.id);
  } catch (err) {
    await deleteVerifyMessage(guild, cfg.channelId, posted.id);
    throw err;
  }
  if (moved) await deleteVerifyMessage(guild, postedIn, cfg.messageId);
}

/** Delete a verify message. Never throws; every failure is logged (a gone message or no access is expected). */
async function deleteVerifyMessage(guild, channelId, messageId) {
  const dropActions = async () => {
    // On Fluxer the button is a reaction with a stored action: forget it with the message.
    if (platformOfGuild(guild) === 'fluxer') await deleteComponentActions(messageId).catch(() => {});
  };
  try {
    const channel =
      guild.channels.cache.get(channelId) ??
      (await within(guild.channels.fetch(channelId), 'looking up the verify channel'));
    await within(channel.messages.delete(messageId), 'deleting a verify message');
    await dropActions();
  } catch (err) {
    if (isMessageGone(err)) await dropActions();
    const why = isMessageGone(err) ? 'it is gone' : isPermissionDenied(err) ? 'no access' : 'failed';
    log.warn(
      'verification',
      `could not delete message ${messageId} in channel ${channelId} of ${guildKey(guild)} (${why}):`,
      err
    );
  }
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
  // Ensure the verify message still exists (cheap no-op if it does). Not awaited: a platform call
  // that hangs must not hold back the kick schedule or the other modules' join handlers.
  ensureVerifyMessage(member.guild).catch((err) =>
    log.warn('verification', `checking the verify message failed in ${guildKey(member.guild)}:`, err)
  );

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
