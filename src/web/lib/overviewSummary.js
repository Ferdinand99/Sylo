// View-model for the guild "Combined Overview" page: a server-health card plus
// category-grouped module status cards (YAGPDB-style), each summarising that
// module's current configuration with a jump link to its settings.
import { PermissionFlagsBits } from 'discord.js';
import { config } from '../../config.js';
import { runtime } from '../../runtime.js';
import { MODULES, getModule, missingIntents } from '../../modules/registry.js';
import { getGuildModules } from '../../db/modules.js';
import { getGuildSettings } from '../../db/guildSettings.js';
import { getCommandOverrides } from '../../db/commandOverrides.js';
import { openTicketCount, unreadTicketCount } from '../../db/tickets.js';
import { listComposed } from '../../db/composedMessages.js';
import { getCounting } from '../../db/counting.js';
import { listScheduled } from '../../db/scheduledMessages.js';
import { memberCount as levelingMemberCount } from '../../db/leveling.js';
import { LOG_EVENTS } from '../../modules/logging.js';
import { AUTOMOD_RULES } from '../../modules/automod.js';

// Permissions Sylo relies on for its core moderation / role / logging features.
const KEY_PERMS = [
  ['KickMembers', 'Kick Members'],
  ['BanMembers', 'Ban Members'],
  ['ModerateMembers', 'Timeout Members'],
  ['ManageRoles', 'Manage Roles'],
  ['ManageMessages', 'Manage Messages'],
  ['ViewAuditLog', 'View Audit Log'],
];

// How the cards are laid out on the overview. Ids are either module ids or one
// of the synthetic cards built below ('general', 'commands', 'messages').
const LAYOUT = [
  { title: 'Core', ids: ['general', 'commands', 'moderation'] },
  { title: 'Moderation & filtering', ids: ['automod', 'verification', 'logging'] },
  { title: 'Engagement', ids: ['welcome', 'roles', 'counting', 'leveling', 'sticky'] },
  { title: 'Utilities', ids: ['tickets', 'messages', 'scheduled-messages', 'custom-commands', 'autoresponder'] },
];

const line = (label, value, state) => ({ label, value, state });
const on = (label, value) => line(label, value, 'on');
const off = (label, value) => line(label, value, 'off');
const neutral = (label, value) => line(label, value, 'neutral');

function channelName(guild, id) {
  if (!id) return null;
  return guild.channels.cache.get(id)?.name ?? null;
}

/**
 * Build the whole overview view-model for a guild.
 * @param {import('discord.js').Guild} guild
 */
export function buildOverview(guild) {
  const settings = getGuildSettings(guild.id);
  const state = new Map(getGuildModules(guild.id).map((m) => [m.id, m]));

  return {
    health: buildHealth(guild, settings, state),
    groups: LAYOUT.map((g) => ({
      title: g.title,
      cards: g.ids.map((id) => buildCard(id, guild, settings, state)).filter(Boolean),
    })),
  };
}

function buildHealth(guild, settings, state) {
  const me = guild.members.me;
  const missingPerms = me
    ? KEY_PERMS.filter(([bit]) => !me.permissions.has(PermissionFlagsBits[bit])).map(([, l]) => l)
    : KEY_PERMS.map(([, l]) => l);

  // Which privileged intents an *enabled* module actually needs right now.
  let needMembers = false;
  let needContent = false;
  for (const def of MODULES) {
    if (!(state.get(def.id)?.enabled ?? def.defaultEnabled)) continue;
    if (def.requiredIntents.includes('GuildMembers')) needMembers = true;
    if (def.requiredIntents.includes('MessageContent')) needContent = true;
  }

  const enabledCount = MODULES.filter((d) => state.get(d.id)?.enabled ?? d.defaultEnabled).length;

  return {
    perms: { ok: missingPerms.length === 0, missing: missingPerms },
    intents: {
      members: config.intentGuildMembers,
      content: config.intentMessageContent,
      membersBlocking: needMembers && !config.intentGuildMembers,
      contentBlocking: needContent && !config.intentMessageContent,
    },
    modlog: { set: Boolean(settings?.modlog_channel_id), name: channelName(guild, settings?.modlog_channel_id) },
    tickets: { open: openTicketCount(guild.id), unread: unreadTicketCount(guild.id) },
    modules: { enabled: enabledCount, total: MODULES.length },
  };
}

function buildCard(id, guild, settings, state) {
  if (id === 'general') return generalCard(guild, settings);
  if (id === 'commands') return commandsCard(guild);
  if (id === 'messages') return messagesCard(guild);

  const def = getModule(id);
  if (!def) return null;
  const row = state.get(id);
  const enabled = row?.enabled ?? def.defaultEnabled;
  const missing = missingIntents(def);
  return {
    kind: 'module',
    id,
    name: def.name,
    icon: def.icon,
    description: def.description,
    hasToggle: true,
    enabled,
    missingIntents: missing,
    status: missing.length ? 'blocked' : enabled ? 'on' : 'off',
    href: id === 'moderation' ? `/guilds/${guild.id}/m/moderation` : `/guilds/${guild.id}/m/${id}`,
    lines: moduleLines(id, guild, row?.config ?? {}),
  };
}

function moduleLines(id, guild, cfg) {
  switch (id) {
    case 'moderation': {
      const rules = Array.isArray(cfg.warnThresholds) ? cfg.warnThresholds.length : 0;
      return [
        rules ? on('Warning thresholds', `${rules} rule${rules === 1 ? '' : 's'}`) : off('Warning thresholds', 'none'),
        cfg.dmOnPunish ? on('DM on punishment', 'on') : off('DM on punishment', 'off'),
      ];
    }
    case 'logging': {
      const name = channelName(guild, cfg.channel);
      const total = LOG_EVENTS.length;
      const tracked = LOG_EVENTS.filter(([k]) => cfg.events?.[k]).length;
      return [
        name ? on('Log channel', `#${name}`) : off('Log channel', 'not set'),
        tracked ? on('Events tracked', `${tracked} of ${total}`) : off('Events tracked', `0 of ${total}`),
      ];
    }
    case 'tickets': {
      const staff = Array.isArray(cfg.staffRoles) ? cfg.staffRoles.length : 0;
      const notify = channelName(guild, cfg.notifyChannel);
      const open = openTicketCount(guild.id);
      return [
        staff ? on('Staff roles', String(staff)) : neutral('Staff roles', 'admins only'),
        notify ? on('Notify channel', `#${notify}`) : off('Notify channel', 'not set'),
        open ? on('Open tickets', String(open)) : neutral('Open tickets', '0'),
      ];
    }
    case 'roles': {
      const rr = Array.isArray(cfg.reactionMessages) ? cfg.reactionMessages.length : 0;
      const auto = Array.isArray(cfg.autoroles) ? cfg.autoroles.length : 0;
      return [
        rr ? on('Reaction-role messages', String(rr)) : off('Reaction-role messages', 'none'),
        auto ? on('Autoroles on join', String(auto)) : off('Autoroles on join', 'none'),
      ];
    }
    case 'verification': {
      const role = cfg.verifiedRoleId ? guild.roles?.cache?.get(cfg.verifiedRoleId) : null;
      const ch = channelName(guild, cfg.channelId);
      return [
        role ? on('Verified role', `@${role.name}`) : off('Verified role', 'not set'),
        ch ? on('Channel', `#${ch}`) : off('Channel', 'not set'),
        neutral('Mode', cfg.mode || 'button'),
      ];
    }
    case 'welcome': {
      const join = channelName(guild, cfg.joinChannel);
      const leave = channelName(guild, cfg.leaveChannel);
      const dm = String(cfg.dmMessage ?? '').trim() !== '';
      return [
        join ? on('Welcome message', `#${join}`) : off('Welcome message', 'off'),
        leave ? on('Leave message', `#${leave}`) : off('Leave message', 'off'),
        dm ? on('Welcome DM', 'on') : off('Welcome DM', 'off'),
      ];
    }
    case 'sticky': {
      const n = Array.isArray(cfg.stickies) ? cfg.stickies.length : 0;
      return [n ? on('Active sticky messages', String(n)) : off('Active sticky messages', 'none')];
    }
    case 'counting': {
      const ch = channelName(guild, cfg.channelId);
      const st = getCounting(guild.id);
      return [
        ch ? on('Channel', `#${ch}`) : off('Channel', 'not set'),
        neutral('Count', String(st.current)),
        neutral('Best streak', String(st.record)),
      ];
    }
    case 'custom-commands': {
      const n = Array.isArray(cfg.commands) ? cfg.commands.length : 0;
      return [
        neutral('Prefix', cfg.prefix || '!'),
        n ? on('Commands', String(n)) : off('Commands', 'none'),
      ];
    }
    case 'autoresponder': {
      const n = Array.isArray(cfg.responders) ? cfg.responders.length : 0;
      return [n ? on('Responders', String(n)) : off('Responders', 'none')];
    }
    case 'scheduled-messages': {
      const jobs = listScheduled(guild.id);
      const active = jobs.filter((j) => j.enabled === 1).length;
      return [
        jobs.length ? on('Jobs', `${active} active${jobs.length > active ? ` · ${jobs.length - active} paused` : ''}`) : off('Jobs', 'none'),
      ];
    }
    case 'leveling': {
      const rewards = Array.isArray(cfg.rewards) ? cfg.rewards.length : 0;
      const announce = cfg.announce || 'channel';
      return [
        neutral('Announce', announce),
        rewards ? on('Reward roles', String(rewards)) : off('Reward roles', 'none'),
        neutral('Ranked members', String(levelingMemberCount(guild.id))),
      ];
    }
    case 'automod': {
      const rules = cfg.rules || {};
      const active = AUTOMOD_RULES.filter(([k]) => rules[k]?.enabled).length;
      const exempt = (cfg.exemptRoles?.length ?? 0) + (cfg.exemptChannels?.length ?? 0);
      return [
        active
          ? on('Active filters', `${active} of ${AUTOMOD_RULES.length}`)
          : off('Active filters', 'none'),
        exempt ? on('Exemptions', String(exempt)) : neutral('Exemptions', '0'),
      ];
    }
    default:
      return [neutral('Status', 'enabled')];
  }
}

function generalCard(guild, settings) {
  const modlog = channelName(guild, settings?.modlog_channel_id);
  return {
    kind: 'link',
    id: 'general',
    name: 'General',
    icon: '⚙️',
    description: 'Server-wide settings for Sylo.',
    hasToggle: false,
    enabled: null,
    missingIntents: [],
    status: 'link',
    href: `/guilds/${guild.id}/general`,
    lines: [modlog ? on('Mod-log channel', `#${modlog}`) : off('Mod-log channel', 'not set')],
  };
}

function commandsCard(guild) {
  const overrides = [...getCommandOverrides(guild.id).values()];
  const total = runtime.client?.commands?.size ?? 0;
  const disabled = overrides.filter((o) => !o.enabled).length;
  const limited = overrides.filter((o) => o.enabled && (o.allowedChannels.length || o.allowedRoles.length)).length;
  return {
    kind: 'link',
    id: 'commands',
    name: 'Commands',
    icon: '⌘',
    description: 'Enable, disable or restrict slash commands per server.',
    hasToggle: false,
    enabled: null,
    missingIntents: [],
    status: 'link',
    href: `/guilds/${guild.id}/commands`,
    lines: [
      on('Available', String(total)),
      disabled ? off('Disabled here', String(disabled)) : neutral('Disabled here', '0'),
      limited ? on('Channel / role limited', String(limited)) : neutral('Channel / role limited', '0'),
    ],
  };
}

function messagesCard(guild) {
  const n = listComposed(guild.id, 200).length;
  return {
    kind: 'link',
    id: 'messages',
    name: 'Message Creator',
    icon: '✉️',
    description: 'Compose and send messages or embeds as the bot.',
    hasToggle: false,
    enabled: null,
    missingIntents: [],
    status: 'link',
    href: `/guilds/${guild.id}/messages`,
    lines: [n ? on('Composed messages', String(n)) : neutral('Composed messages', 'none')],
  };
}
