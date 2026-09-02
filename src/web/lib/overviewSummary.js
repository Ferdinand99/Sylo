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
import { countOpenAppeals } from '../../db/appeals.js';
import { inviterCount } from '../../db/inviteTracker.js';
import { guildPollCount } from '../../db/polls.js';
import { activeGiveaways } from '../../db/giveaways.js';
import { recentLookups } from '../../db/cache.js';
import { memberCount as levelingMemberCount } from '../../db/leveling.js';
import { LOG_EVENTS } from '../../modules/logging.js';
import { AUTOMOD_RULES } from '../../modules/automod.js';
import { moduleIcon } from './moduleIcons.js';

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
  { title: 'Moderation & filtering', ids: ['automod', 'verification', 'appeals', 'logging'] },
  {
    title: 'Engagement',
    ids: ['welcome', 'welcome-channel', 'roles', 'counting', 'leveling', 'starboard', 'sticky'],
  },
  {
    title: 'Utilities',
    ids: [
      'tickets',
      'messages',
      'reminders',
      'custom-commands',
      'invite-tracker',
      'polls',
      'giveaways',
      'autoresponder',
      'afk',
      'server-stats',
      'temp-voice',
      'free-games',
      'game-stats',
    ],
  },
  { title: 'Social alerts', ids: ['twitch-alerts', 'youtube-alerts', 'kick-alerts'] },
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
    modlog: {
      set: Boolean(settings?.modlog_channel_id),
      name: channelName(guild, settings?.modlog_channel_id),
    },
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
    icon: moduleIcon(id),
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
        rules
          ? on('Warning thresholds', `${rules} rule${rules === 1 ? '' : 's'}`)
          : off('Warning thresholds', 'none'),
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
    case 'appeals': {
      const q = Array.isArray(cfg.questions) ? cfg.questions.length : 3;
      const open = countOpenAppeals(guild.id);
      const review = channelName(guild, cfg.reviewChannelId);
      return [
        on('Form questions', String(q || 3)),
        open ? on('Open appeals', String(open)) : neutral('Open appeals', '0'),
        review ? on('Review channel', `#${review}`) : neutral('Review channel', 'not set'),
      ];
    }
    case 'welcome-channel': {
      const ch = channelName(guild, cfg.channelId);
      const els = cfg.spec && Array.isArray(cfg.spec.embeds) ? cfg.spec.embeds.length : 0;
      return [
        ch ? on('Channel', `#${ch}`) : off('Channel', 'not set'),
        els ? on('Elements', String(els)) : off('Elements', 'none'),
        cfg.messageId ? on('Published', 'yes') : off('Published', 'no'),
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
      const cmds = Array.isArray(cfg.commands) ? cfg.commands : [];
      const actions = cmds.reduce((sum, c) => sum + (Array.isArray(c.actions) ? c.actions.length : 0), 0);
      return [
        cmds.length ? on('Commands', String(cmds.length)) : off('Commands', 'none'),
        cmds.length ? neutral('Actions', String(actions)) : neutral('Actions', '0'),
      ];
    }
    case 'invite-tracker': {
      const log = channelName(guild, cfg.joinLogChannelId);
      return [
        neutral('Inviters ranked', String(inviterCount(guild.id))),
        log ? on('Join log', `#${log}`) : off('Join log', 'off'),
      ];
    }
    case 'twitch-alerts': {
      const alerts = Array.isArray(cfg.alerts) ? cfg.alerts.filter((a) => a.login && a.channelId) : [];
      return [
        alerts.length ? on('Streamers', String(alerts.length)) : off('Streamers', 'none'),
        config.twitchEnabled ? neutral('API', 'connected') : off('API', 'TWITCH_CLIENT_ID/SECRET not set'),
      ];
    }
    case 'kick-alerts': {
      const alerts = Array.isArray(cfg.alerts) ? cfg.alerts.filter((a) => a.slug && a.channelId) : [];
      return [
        alerts.length ? on('Streamers', String(alerts.length)) : off('Streamers', 'none'),
        config.kickEnabled ? neutral('API', 'connected') : off('API', 'KICK_CLIENT_ID/SECRET not set'),
      ];
    }
    case 'youtube-alerts': {
      const alerts = Array.isArray(cfg.alerts)
        ? cfg.alerts.filter((a) => a.ytChannelId && a.discordChannelId)
        : [];
      const live = alerts.filter((a) => a.onLive).length;
      return [
        alerts.length ? on('Channels', String(alerts.length)) : off('Channels', 'none'),
        alerts.length
          ? neutral('Live alerts', live ? `${live} of ${alerts.length}` : 'off')
          : neutral('Live alerts', 'off'),
      ];
    }
    case 'game-stats': {
      const cached = recentLookups(50).length;
      return [
        neutral('Command', '/stats battlefield'),
        cached ? on('Cached lookups', String(cached)) : neutral('Cached lookups', '0'),
      ];
    }
    case 'giveaways': {
      const active = activeGiveaways(guild.id);
      const ping = cfg.ping === 'everyone' ? '@everyone' : cfg.ping === 'here' ? '@here' : 'none';
      return [
        active.length ? on('Active giveaways', String(active.length)) : neutral('Active giveaways', '0'),
        neutral('Winner ping', ping),
      ];
    }
    case 'polls': {
      const open = guildPollCount(guild.id);
      const restricted = Array.isArray(cfg.voteRoles) && cfg.voteRoles.length;
      return [
        open ? on('Open polls', String(open)) : neutral('Open polls', '0'),
        restricted
          ? on(
              'Vote restriction',
              `${cfg.voteRoleMode === 'deny' ? 'deny' : 'allow'} ${cfg.voteRoles.length} role(s)`
            )
          : neutral('Vote restriction', 'everyone'),
      ];
    }
    case 'autoresponder': {
      const n = Array.isArray(cfg.responders) ? cfg.responders.length : 0;
      return [n ? on('Responders', String(n)) : off('Responders', 'none')];
    }
    case 'afk': {
      return [
        cfg.setNickname !== false ? on('Nickname tag', 'on') : off('Nickname tag', 'off'),
        cfg.mentionReply !== false ? on('Mention reply', 'on') : off('Mention reply', 'off'),
      ];
    }
    case 'server-stats': {
      const n = Array.isArray(cfg.channels) ? cfg.channels.length : 0;
      return [
        n ? on('Stat channels', String(n)) : off('Stat channels', 'none'),
        neutral('Refresh', `every ${cfg.refreshMinutes || 10} min`),
      ];
    }
    case 'starboard': {
      const boards = Array.isArray(cfg.boards) ? cfg.boards : [];
      const ready = boards.filter((b) => b.channelId);
      if (!boards.length) return [off('Boards', 'none')];
      const names = ready
        .map((b) => channelName(guild, b.channelId))
        .filter(Boolean)
        .map((nm) => `#${nm}`);
      return [
        on(
          'Boards',
          `${boards.length}${ready.length < boards.length ? ` · ${boards.length - ready.length} unconfigured` : ''}`
        ),
        names.length ? neutral('Channels', names.join(', ')) : off('Channels', 'not set'),
      ];
    }
    case 'temp-voice': {
      const hubs = Array.isArray(cfg.hubs) ? cfg.hubs.filter((h) => h.hubChannelId) : [];
      if (!hubs.length) return [off('Hub channels', 'none')];
      const names = hubs
        .map((h) => channelName(guild, h.hubChannelId))
        .filter(Boolean)
        .map((nm) => `🔊 ${nm}`);
      return [on('Hub channels', names.length ? names.join(', ') : String(hubs.length))];
    }
    case 'free-games': {
      const ch = channelName(guild, cfg.channelId);
      const role = cfg.roleId ? guild.roles?.cache?.get(cfg.roleId) : null;
      return [
        ch ? on('Channel', `#${ch}`) : off('Channel', 'not set'),
        role ? on('Ping role', `@${role.name}`) : neutral('Ping role', 'none'),
      ];
    }
    case 'reminders': {
      const jobs = listScheduled(guild.id);
      const active = jobs.filter((j) => j.enabled === 1).length;
      return [
        jobs.length
          ? on('Reminders', `${active} active${jobs.length > active ? ` · ${jobs.length - active} off` : ''}`)
          : off('Reminders', 'none'),
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
        active ? on('Active filters', `${active} of ${AUTOMOD_RULES.length}`) : off('Active filters', 'none'),
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
    name: 'Settings',
    icon: moduleIcon('general'),
    description: 'Bot masters, mod-log channel, embed colour, backup.',
    hasToggle: false,
    enabled: null,
    missingIntents: [],
    status: 'link',
    href: `/guilds/${guild.id}/settings`,
    lines: [modlog ? on('Mod-log channel', `#${modlog}`) : off('Mod-log channel', 'not set')],
  };
}

function commandsCard(guild) {
  const overrides = [...getCommandOverrides(guild.id).values()];
  const total = runtime.client?.commands?.size ?? 0;
  const disabled = overrides.filter((o) => !o.enabled).length;
  const limited = overrides.filter(
    (o) => o.enabled && (o.allowedChannels.length || o.allowedRoles.length)
  ).length;
  return {
    kind: 'link',
    id: 'commands',
    name: 'Commands',
    icon: moduleIcon('commands'),
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
    name: 'Embed messages',
    icon: moduleIcon('messages'),
    description: 'Build rich embed messages and publish them to a channel as the bot.',
    hasToggle: false,
    enabled: null,
    missingIntents: [],
    status: 'link',
    href: `/guilds/${guild.id}/messages`,
    lines: [n ? on('Saved embeds', String(n)) : neutral('Saved embeds', 'none')],
  };
}
