// Invite tracker: credit the member whose invite link a new joiner used, keep a
// per-member tally, and (optionally) post a join/leave log. Fake-invite guard:
// if the joiner leaves within the grace window the inviter loses the credit.
//
// config shape: { joinLogChannelId: '', graceHours: 24 }
import { on } from './dispatch.js';
import { isModuleEnabled } from '../db/modules.js';
import {
  bumpRegular,
  bumpLeaves,
  recordJoin,
  getJoin,
  deleteJoin,
  getInviteCount,
  personalCodeOwner,
} from '../db/inviteTracker.js';

const isId = (v) => /^\d{17,20}$/.test(v ?? '');

export function normaliseInviteTrackerConfig(raw = {}) {
  return {
    joinLogChannelId: isId(raw.joinLogChannelId) ? raw.joinLogChannelId : '',
    graceHours: Math.max(0, Math.min(168, Math.floor(Number(raw.graceHours) || 24))),
  };
}

// --- invite-use cache (per process) ---------------------------------------
// guildId -> { codes: Map<code, { uses, inviterId }>, vanityUses: number }
const cache = new Map();

async function snapshot(guild) {
  const me = guild.members.me;
  if (me && !me.permissions.has('ManageGuild')) return null; // can't read invites

  let invites;
  try {
    invites = await guild.invites.fetch({ cache: false });
  } catch {
    return null;
  }

  const codes = new Map();
  for (const inv of invites.values()) {
    codes.set(inv.code, { uses: inv.uses ?? 0, inviterId: inv.inviterId ?? inv.inviter?.id ?? null });
  }

  let vanityUses = 0;
  if (guild.vanityURLCode) {
    try {
      vanityUses = (await guild.fetchVanityData()).uses ?? 0;
    } catch {
      /* no access */
    }
  }
  return { codes, vanityUses };
}

/** Load a guild's current invite uses into the cache. */
export async function primeGuild(guild) {
  const snap = await snapshot(guild);
  if (snap) cache.set(guild.id, snap);
  return Boolean(snap);
}

/** Startup: prime every guild that has the module enabled. */
export async function primeAllInviteCaches(client) {
  for (const guild of client.guilds.cache.values()) {
    if (isModuleEnabled(guild.id, 'invite-tracker')) await primeGuild(guild);
  }
}

// --- join / leave handling ----------------------------------------------

async function postLog(guild, channelId, content) {
  if (!isId(channelId)) return;
  const ch = guild.channels.cache.get(channelId);
  const me = guild.members.me;
  if (!ch?.isTextBased() || !ch.permissionsFor(me)?.has(['ViewChannel', 'SendMessages'])) return;
  await ch.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
}

on('invite-tracker', 'guildMemberAdd', async (member, rawConfig, guildId) => {
  const cfg = normaliseInviteTrackerConfig(rawConfig);
  const guild = member.guild;
  const now = Date.now();

  if (member.user.bot) {
    recordJoin(guildId, member.id, { source: 'bot', joinedAt: now, counted: 0 });
    return;
  }

  const before = cache.get(guildId);
  const after = await snapshot(guild);
  if (after) cache.set(guildId, after);

  let inviterId = null;
  let code = null;
  let source = 'unknown';

  if (before && after) {
    for (const [c, data] of after.codes) {
      if (data.uses > (before.codes.get(c)?.uses ?? 0)) {
        // A link Sylo minted for a member via /invites credits that member,
        // not the bot that technically created it.
        inviterId = personalCodeOwner(guildId, c) ?? data.inviterId;
        code = c;
        source = 'invite';
        break;
      }
    }
    if (source === 'unknown' && after.vanityUses > before.vanityUses) source = 'vanity';
  }

  const creditable = source === 'invite' && isId(inviterId) && inviterId !== member.id;
  if (creditable) {
    const inviterMember = guild.members.cache.get(inviterId);
    if (inviterMember?.user.bot) {
      source = 'unknown';
    } else {
      bumpRegular(guildId, inviterId, 1);
    }
  }

  recordJoin(guildId, member.id, {
    inviterId: creditable && source === 'invite' ? inviterId : null,
    code,
    source,
    joinedAt: now,
    counted: creditable && source === 'invite' ? 1 : 0,
  });

  if (cfg.joinLogChannelId) {
    let tail;
    if (source === 'invite' && isId(inviterId)) {
      const net = getInviteCount(guildId, inviterId).net;
      tail = `invited by <@${inviterId}> — they now have **${net}** invite${net === 1 ? '' : 's'}`;
    } else if (source === 'vanity') {
      tail = 'joined through the server’s vanity URL';
    } else if (source === 'bot') {
      tail = 'was added by a bot';
    } else {
      tail = 'I could not tell who invited them';
    }
    await postLog(guild, cfg.joinLogChannelId, `📥 <@${member.id}> (${member.user.tag}) joined — ${tail}.`);
  }
});

on('invite-tracker', 'guildMemberRemove', async (member, rawConfig, guildId) => {
  const cfg = normaliseInviteTrackerConfig(rawConfig);
  const join = getJoin(guildId, member.id);
  deleteJoin(guildId, member.id);
  if (!join) return;

  let note = '';
  if (join.counted && isId(join.inviter_id)) {
    const withinGrace = Date.now() - join.joined_at < cfg.graceHours * 3_600_000;
    if (withinGrace) {
      bumpLeaves(guildId, join.inviter_id, 1);
      note = ` — the invite by <@${join.inviter_id}> no longer counts (left within ${cfg.graceHours}h)`;
    } else {
      note = ` — was invited by <@${join.inviter_id}>`;
    }
  }

  if (cfg.joinLogChannelId) {
    await postLog(
      member.guild,
      cfg.joinLogChannelId,
      `📤 **${member.user.tag}** left${note}.`
    );
  }
});

// Keep the cache fresh so the next join diffs cleanly.
on('invite-tracker', 'inviteCreate', async (invite) => {
  if (invite.guild) await primeGuild(invite.guild);
});
on('invite-tracker', 'inviteDelete', async (invite) => {
  if (invite.guild) await primeGuild(invite.guild);
});
on('invite-tracker', 'guildCreate', async (guild) => {
  await primeGuild(guild);
});
