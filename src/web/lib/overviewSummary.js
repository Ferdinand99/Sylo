// View-model for the guild "Combined Overview" page: a server-health card plus
// category-grouped module status cards (YAGPDB-style), each summarising that
// module's current configuration with a jump link to its settings.
import { primaryClient, platformOfGuild } from '../../platform/platformOf.js';
import { PermissionFlagsBits } from 'discord.js';
import { config } from '../../config.js';
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
import { upcomingEvents } from '../../db/events.js';
import { openSuggestionCount, suggestionCount } from '../../db/suggestions.js';
import { nextTempRoleExpiry, tempRoleCount } from '../../db/tempRoles.js';
import { recentLookups } from '../../db/cache.js';
import { dailySeries } from '../../db/insights.js';
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
  { title: 'Moderation & filtering', ids: ['automod', 'honeypot', 'verification', 'appeals', 'logging'] },
  {
    title: 'Engagement',
    ids: [
      'welcome',
      'welcome-channel',
      'roles',
      'temp-roles',
      'counting',
      'leveling',
      'starboard',
      'sticky',
      'birthdays',
    ],
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
      'events',
      'suggestions',
      'autoresponder',
      'auto-react',
      'auto-threads',
      'afk',
      'server-stats',
      'insights',
      'temp-voice',
      'free-games',
      'game-stats',
      'channel-cleanup',
    ],
  },
  {
    title: 'Social alerts',
    ids: ['twitch-alerts', 'youtube-alerts', 'kick-alerts', 'rss', 'github', 'apple-connect'],
  },
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
 * @param {{ owner?: boolean }} [viewer]  a non-owner never sees an owner-only module's card.
 *   Every card's `href` is an address in the dashboard (/v2/...), for the web dashboard and the
 *   Sylo app.
 */
export async function buildOverview(guild, { owner = true } = {}) {
  const settings = await getGuildSettings(guild.id);
  const state = new Map((await getGuildModules(guild.id)).map((m) => [m.id, m]));

  return {
    health: await buildHealth(guild, settings, state, owner),
    groups: await Promise.all(
      LAYOUT.map(async (g) => ({
        title: g.title,
        cards: (
          await Promise.all(
            g.ids
              .filter((id) => owner || !getModule(id)?.ownerOnly)
              .map((id) => buildCard(id, guild, settings, state))
          )
        ).filter(Boolean),
      }))
    ),
  };
}

// Where each card lives in the new dashboard (web-v2's SPECIAL_V2_PATHS); every other module is
// /v2/guilds/<key>/m/<id>. Keep in step with web-v2/src/moduleForms/index.js.
export const V2_CARD_PAGES = {
  general: 'settings',
  commands: 'moderation/commands',
  messages: 'messages',
  insights: 'insights',
};

export function v2CardHref(id, guildId) {
  return `/v2/guilds/${guildId}/${V2_CARD_PAGES[id] ?? `m/${id}`}`;
}

async function buildHealth(guild, settings, state, owner = true) {
  const visible = MODULES.filter((d) => owner || !d.ownerOnly);
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

  const enabledCount = visible.filter((d) => state.get(d.id)?.enabled ?? d.defaultEnabled).length;
  const discord = platformOfGuild(guild) === 'discord';

  return {
    perms: { ok: missingPerms.length === 0, missing: missingPerms },
    intents: {
      members: config.intentGuildMembers,
      content: config.intentMessageContent,
      // Privileged intents are a Discord concept; Fluxer has none to warn about.
      membersBlocking: discord && needMembers && !config.intentGuildMembers,
      contentBlocking: discord && needContent && !config.intentMessageContent,
    },
    modlog: {
      set: Boolean(settings?.modlog_channel_id),
      name: channelName(guild, settings?.modlog_channel_id),
    },
    tickets: { open: await openTicketCount(guild.id), unread: await unreadTicketCount(guild.id) },
    modules: { enabled: enabledCount, total: visible.length },
  };
}

async function buildCard(id, guild, settings, state) {
  if (id === 'general') return generalCard(guild, settings);
  if (id === 'commands') return commandsCard(guild);
  if (id === 'messages') return messagesCard(guild);

  const def = getModule(id);
  if (!def) return null;
  const row = state.get(id);
  const enabled = row?.enabled ?? def.defaultEnabled;
  const missing = platformOfGuild(guild) === 'discord' ? missingIntents(def) : [];
  return {
    kind: 'module',
    id,
    name: def.name,
    icon: moduleIcon(id),
    description: def.description,
    hasToggle: true,
    enabled,
    beta: Boolean(def.beta),
    missingIntents: missing,
    status: missing.length ? 'blocked' : enabled ? 'on' : 'off',
    href: v2CardHref(id, guild.id),
    lines: await moduleLines(id, guild, row?.config ?? {}),
  };
}

async function moduleLines(id, guild, cfg) {
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
      const open = await openTicketCount(guild.id);
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
      const open = await countOpenAppeals(guild.id);
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
    case 'auto-threads': {
      const rules = Array.isArray(cfg.rules) ? cfg.rules.length : 0;
      return [
        rules
          ? on('Channels with auto threads', String(new Set(cfg.rules.map((r) => r?.channelId)).size))
          : off('Channels with auto threads', 'none'),
      ];
    }
    case 'counting': {
      const ch = channelName(guild, cfg.channelId);
      const st = await getCounting(guild.id);
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
        neutral('Inviters ranked', String(await inviterCount(guild.id))),
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
    case 'apple-connect': {
      const watching = cfg.channelId
        ? on('Channel', `#${channelName(guild, cfg.channelId) ?? 'unknown'}`)
        : off('Channel', 'not set');
      return [
        watching,
        config.appleEnabled
          ? neutral('API', 'connected')
          : off('API', 'APPLE_KEY_ID / APPLE_PRIVATE_KEY not set'),
      ];
    }
    case 'rss': {
      const feeds = Array.isArray(cfg.feeds) ? cfg.feeds.filter((f) => f.url && f.channelId) : [];
      return [feeds.length ? on('Feeds', String(feeds.length)) : off('Feeds', 'none')];
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
      const cached = (await recentLookups(50)).length;
      return [
        neutral('Command', '/stats battlefield'),
        cached ? on('Cached lookups', String(cached)) : neutral('Cached lookups', '0'),
      ];
    }
    case 'giveaways': {
      const active = await activeGiveaways(guild.id);
      const ping = cfg.ping === 'everyone' ? '@everyone' : cfg.ping === 'here' ? '@here' : 'none';
      return [
        active.length ? on('Active giveaways', String(active.length)) : neutral('Active giveaways', '0'),
        neutral('Winner ping', ping),
      ];
    }
    case 'events': {
      const upcoming = await upcomingEvents(guild.id);
      const next = upcoming[0];
      return [
        upcoming.length ? on('Upcoming events', String(upcoming.length)) : neutral('Upcoming events', '0'),
        next
          ? neutral(
              'Next',
              `${next.title.slice(0, 40)} · ${new Date(next.start_at).toISOString().slice(0, 16).replace('T', ' ')} UTC`
            )
          : neutral('Next', 'none'),
      ];
    }
    case 'temp-roles': {
      const active = await tempRoleCount(guild.id);
      const next = await nextTempRoleExpiry(guild.id);
      return [
        active ? on('Active temporary roles', String(active)) : neutral('Active temporary roles', '0'),
        next
          ? neutral('Next expiry', new Date(next).toISOString().slice(0, 16).replace('T', ' ') + ' UTC')
          : neutral('Next expiry', 'none'),
      ];
    }
    case 'suggestions': {
      const open = await openSuggestionCount(guild.id);
      const total = await suggestionCount(guild.id);
      return [
        open ? on('Open suggestions', String(open)) : neutral('Open suggestions', '0'),
        neutral('Stored', String(total)),
        cfg.channel ? on('Channel', 'set') : off('Channel', 'not set'),
      ];
    }
    case 'polls': {
      const open = await guildPollCount(guild.id);
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
    case 'insights': {
      const week = await dailySeries(guild.id, 7);
      const msgs = week.reduce((t, d) => t + d.messages, 0);
      const net = week.reduce((t, d) => t + d.joins - d.leaves, 0);
      const voiceH = Math.round(week.reduce((t, d) => t + d.voiceMinutes, 0) / 60);
      return [
        neutral('Messages (7d)', msgs.toLocaleString('en')),
        neutral('Net members (7d)', `${net >= 0 ? '+' : ''}${net}`),
        neutral('Voice (7d)', `${voiceH.toLocaleString('en')} h`),
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
      const jobs = await listScheduled(guild.id);
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
        neutral('Ranked members', String(await levelingMemberCount(guild.id))),
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
    case 'honeypot': {
      const channels = Array.isArray(cfg.channels) ? cfg.channels.length : 0;
      const messages = Array.isArray(cfg.messages) ? cfg.messages.length : 0;
      const traps = channels + messages;
      return [
        traps ? on('Traps set', String(traps)) : off('Traps set', 'none'),
        neutral('Exempt roles', String(cfg.exemptRoles?.length ?? 0)),
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
    href: v2CardHref('general', guild.id),
    lines: [modlog ? on('Mod-log channel', `#${modlog}`) : off('Mod-log channel', 'not set')],
  };
}

async function commandsCard(guild) {
  const overrides = [...(await getCommandOverrides(guild.id)).values()];
  const total = primaryClient()?.commands?.size ?? 0;
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
    href: v2CardHref('commands', guild.id),
    lines: [
      on('Available', String(total)),
      disabled ? off('Disabled here', String(disabled)) : neutral('Disabled here', '0'),
      limited ? on('Channel / role limited', String(limited)) : neutral('Channel / role limited', '0'),
    ],
  };
}

async function messagesCard(guild) {
  const n = (await listComposed(guild.id, 200)).length;
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
    href: v2CardHref('messages', guild.id),
    lines: [n ? on('Saved embeds', String(n)) : neutral('Saved embeds', 'none')],
  };
}
