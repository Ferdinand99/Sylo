// Server logging module: posts member / message / role / channel events to a
// configured log channel. config shape:
//   { channel: "<id>", events: { memberJoin, memberLeave, memberBan,
//     memberUnban, memberTimeout, nickChange, roleChange, messageDelete,
//     messageEdit, messageBulkDelete, roleCreateDelete, channelCreateDelete } }
import { EmbedBuilder, AuditLogEvent } from 'discord.js';
import { on } from './dispatch.js';
import { sendToChannel } from './lib/send.js';

const COLORS = { add: 0x3fb950, remove: 0xf85149, edit: 0xd29922, info: 0x4aa3df };

/** Every toggle a guild can flip, with a label for the settings panel. */
export const LOG_EVENTS = [
  ['memberJoin', 'Member joined'],
  ['memberLeave', 'Member left'],
  ['memberBan', 'Member banned'],
  ['memberUnban', 'Member unbanned'],
  ['memberTimeout', 'Member timed out / untimed'],
  ['nickChange', 'Nickname changed'],
  ['roleChange', "Member's roles changed"],
  ['messageDelete', 'Message deleted'],
  ['messageEdit', 'Message edited'],
  ['messageBulkDelete', 'Messages bulk-deleted'],
  ['roleCreateDelete', 'Role created / deleted'],
  ['channelCreateDelete', 'Channel created / deleted'],
];

const want = (config, key) => Boolean(config?.channel) && config?.events?.[key];

function log(guildId, config, embed) {
  return sendToChannel(guildId, config.channel, { embeds: [embed.setTimestamp(Date.now())] });
}

function base(color, title) {
  return new EmbedBuilder().setColor(color).setTitle(title);
}

function truncate(text, max = 1024) {
  if (!text) return '*none*';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// --- member events -------------------------------------------------------

on('logging', 'guildMemberAdd', (member, config, guildId) => {
  if (!want(config, 'memberJoin')) return;
  const created = Math.floor(member.user.createdTimestamp / 1000);
  return log(
    guildId,
    config,
    base(COLORS.add, 'Member joined')
      .setThumbnail(member.user.displayAvatarURL())
      .setDescription(`${member} · ${member.user.tag} (\`${member.id}\`)`)
      .addFields(
        { name: 'Account created', value: `<t:${created}:R>`, inline: true },
        { name: 'Member count', value: String(member.guild.memberCount), inline: true }
      )
  );
});

on('logging', 'guildMemberRemove', (member, config, guildId) => {
  if (!want(config, 'memberLeave')) return;
  const roles = member.roles?.cache
    ? [...member.roles.cache.filter((r) => r.id !== guildId).values()].map((r) => r.name).join(', ')
    : '';
  return log(
    guildId,
    config,
    base(COLORS.remove, 'Member left')
      .setThumbnail(member.user.displayAvatarURL())
      .setDescription(`${member.user.tag} (\`${member.id}\`)`)
      .addFields({ name: 'Roles', value: truncate(roles || '*none*', 1024) })
  );
});

on('logging', 'guildBanAdd', async (ban, config, guildId) => {
  if (!want(config, 'memberBan')) return;
  let reason = ban.reason;
  if (!reason) {
    const entry = await ban.guild
      .fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 1 })
      .then((l) => l.entries.first())
      .catch(() => null);
    if (entry?.target?.id === ban.user.id) reason = entry.reason;
  }
  return log(
    guildId,
    config,
    base(COLORS.remove, 'Member banned')
      .setDescription(`${ban.user.tag} (\`${ban.user.id}\`)`)
      .addFields({ name: 'Reason', value: reason || '*none*' })
  );
});

on('logging', 'guildBanRemove', (ban, config, guildId) => {
  if (!want(config, 'memberUnban')) return;
  return log(
    guildId,
    config,
    base(COLORS.add, 'Member unbanned').setDescription(`${ban.user.tag} (\`${ban.user.id}\`)`)
  );
});

on('logging', 'guildMemberUpdate', ({ old: o, new: n }, config, guildId) => {
  const embeds = [];

  if (want(config, 'nickChange') && o.nickname !== n.nickname) {
    embeds.push(
      base(COLORS.edit, 'Nickname changed')
        .setDescription(`${n} (\`${n.id}\`)`)
        .addFields(
          { name: 'Before', value: o.nickname || '*none*', inline: true },
          { name: 'After', value: n.nickname || '*none*', inline: true }
        )
    );
  }

  if (want(config, 'memberTimeout')) {
    const wasTimedOut = o.communicationDisabledUntilTimestamp > Date.now();
    const isTimedOut = n.communicationDisabledUntilTimestamp > Date.now();
    if (!wasTimedOut && isTimedOut) {
      embeds.push(
        base(COLORS.remove, 'Member timed out')
          .setDescription(`${n} (\`${n.id}\`)`)
          .addFields({
            name: 'Until',
            value: `<t:${Math.floor(n.communicationDisabledUntilTimestamp / 1000)}:F>`,
          })
      );
    } else if (wasTimedOut && !isTimedOut) {
      embeds.push(base(COLORS.add, 'Timeout removed').setDescription(`${n} (\`${n.id}\`)`));
    }
  }

  if (want(config, 'roleChange') && o.roles?.cache && n.roles?.cache) {
    const added = [...n.roles.cache.filter((r) => !o.roles.cache.has(r.id)).values()];
    const removed = [...o.roles.cache.filter((r) => !n.roles.cache.has(r.id)).values()];
    if (added.length || removed.length) {
      const e = base(COLORS.info, "Member's roles changed").setDescription(`${n} (\`${n.id}\`)`);
      if (added.length) e.addFields({ name: 'Added', value: added.map((r) => `${r}`).join(' ') });
      if (removed.length) e.addFields({ name: 'Removed', value: removed.map((r) => r.name).join(', ') });
      embeds.push(e);
    }
  }

  return Promise.all(embeds.map((e) => log(guildId, config, e)));
});

// --- message events ----------------------------------------------------

on('logging', 'messageDelete', (message, config, guildId) => {
  if (!want(config, 'messageDelete') || message.author?.bot) return;
  return log(
    guildId,
    config,
    base(COLORS.remove, 'Message deleted')
      .setDescription(`In ${message.channel} by ${message.author ? message.author.tag : 'unknown'}`)
      .addFields({ name: 'Content', value: truncate(message.content) })
  );
});

on('logging', 'messageUpdate', ({ old: o, new: n }, config, guildId) => {
  if (!want(config, 'messageEdit') || n.author?.bot || o.content === n.content) return;
  return log(
    guildId,
    config,
    base(COLORS.edit, 'Message edited')
      .setDescription(`In ${n.channel} by ${n.author?.tag} · [jump](${n.url})`)
      .addFields(
        { name: 'Before', value: truncate(o.content) },
        { name: 'After', value: truncate(n.content) }
      )
  );
});

on('logging', 'messageDeleteBulk', ({ messages, channel }, config, guildId) => {
  if (!want(config, 'messageBulkDelete')) return;
  return log(
    guildId,
    config,
    base(COLORS.remove, 'Messages bulk-deleted').setDescription(
      `${messages.size} messages deleted in ${channel}`
    )
  );
});

// --- role / channel events -------------------------------------------

on('logging', 'roleCreate', (role, config, guildId) => {
  if (!want(config, 'roleCreateDelete')) return;
  return log(guildId, config, base(COLORS.add, 'Role created').setDescription(`${role} (\`${role.id}\`)`));
});
on('logging', 'roleDelete', (role, config, guildId) => {
  if (!want(config, 'roleCreateDelete')) return;
  return log(
    guildId,
    config,
    base(COLORS.remove, 'Role deleted').setDescription(`**${role.name}** (\`${role.id}\`)`)
  );
});

on('logging', 'channelCreate', (channel, config, guildId) => {
  if (!want(config, 'channelCreateDelete')) return;
  return log(
    guildId,
    config,
    base(COLORS.add, 'Channel created').setDescription(`${channel} (\`${channel.id}\`)`)
  );
});
on('logging', 'channelDelete', (channel, config, guildId) => {
  if (!want(config, 'channelCreateDelete')) return;
  return log(
    guildId,
    config,
    base(COLORS.remove, 'Channel deleted').setDescription(`**#${channel.name}** (\`${channel.id}\`)`)
  );
});
