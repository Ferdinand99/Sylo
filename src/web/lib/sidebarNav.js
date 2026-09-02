// Left-sidebar navigation model, MEE6-style: an unlabelled top group, then
// collapsible category groups whose rows each carry a leading enable-state dot
// (modules) or a spacer (plain pages). A server is always in view — the id is
// resolved in auth.js and passed in here. Every row uses an inline SVG icon
// (the `#i-*` symbols in partials/header.ejs), never an emoji.
import { runtime } from '../../runtime.js';
import { getModule } from '../../modules/registry.js';
import { getGuildModules } from '../../db/modules.js';
import { MODULE_ICONS } from './moduleIcons.js';

// module id / page slug -> `#i-<name>` symbol id. Module rows come from the
// shared MODULE_ICONS map (also used by the overview grid); the extras here are
// sidebar-only pages that aren't modules.
const ICONS = {
  ...MODULE_ICONS,
  leaderboard: 'trophy',
  personalizer: 'id',
  audit: 'list',
};

// Top group — special pages, no dot.
const TOP = [
  { key: 'dashboard', label: 'Dashboard', icon: 'grid', guild: (g) => `/guilds/${g}/overview`, noGuild: '/' },
  {
    key: 'leaderboard',
    label: 'Leaderboard',
    icon: ICONS.leaderboard,
    guild: (g) => `/guilds/${g}/leaderboard`,
    noGuild: '/',
  },
  { key: 'personalizer', label: 'Bot Personalizer', icon: ICONS.personalizer, href: '/settings' },
  { key: 'settings', label: 'Settings', icon: 'gear', guild: (g) => `/guilds/${g}/settings`, noGuild: '/' },
  { key: 'health', label: 'Health', icon: 'pulse', href: '/health' },
];

// Category groups. Each item is one of:
//   { module: '<id>' [, label] }                          -> config page + enable dot
//   { page: '<slug>', label }                             -> plain page, no dot
//   { page: '<slug>', dotModule: '<id>', label }          -> page + a module's dot
const CATEGORIES = [
  {
    key: 'essentials',
    title: 'Essentials',
    items: [
      { module: 'welcome', label: 'Welcome & goodbye' },
      { module: 'welcome-channel', label: 'Welcome channel' },
      { module: 'roles', label: 'Reaction roles' },
      { module: 'verification' },
      { page: 'moderation', dotModule: 'moderation', label: 'Moderator' },
      { module: 'leveling', label: 'Levels' },
      { module: 'starboard', label: 'Starboard' },
    ],
  },
  {
    key: 'management',
    title: 'Server management',
    items: [
      { page: 'appeals', dotModule: 'appeals', label: 'Ban appeals' },
      { page: 'tickets', label: 'Tickets' },
      { module: 'custom-commands' },
      { module: 'invite-tracker', label: 'Invite tracker' },
      { module: 'sticky' },
      { page: 'audit', label: 'Audit log' },
    ],
  },
  {
    key: 'utilities',
    title: 'Utilities',
    items: [
      { page: 'messages', label: 'Embed messages' },
      { module: 'counting' },
      { module: 'polls' },
      { module: 'giveaways' },
      { module: 'reminders' },
      { module: 'autoresponder' },
      { module: 'afk' },
      { module: 'server-stats' },
      { module: 'temp-voice' },
      { module: 'free-games' },
      { module: 'game-stats', label: 'Game stats' },
    ],
  },
  {
    key: 'social',
    title: 'Social alerts',
    items: [
      { module: 'twitch-alerts', label: 'Twitch alerts' },
      { module: 'youtube-alerts', label: 'YouTube alerts' },
    ],
  },
];

/**
 * @param {import('express').Request} req
 * @param {string|null} gid  resolved active guild id
 */
export function buildSidebar(req, gid = null) {
  const path = req.path;
  const guild = gid ? runtime.client?.guilds.cache.get(gid) : null;

  const top = TOP.map((t) => {
    const href = t.href ?? (guild ? t.guild(gid) : t.noGuild);
    let active;
    if (t.key === 'dashboard') active = path === '/' || (!!guild && path === `/guilds/${gid}/overview`);
    else if (t.key === 'leaderboard') active = !!guild && path === `/guilds/${gid}/leaderboard`;
    else if (t.key === 'settings') active = !!guild && path.startsWith(`/guilds/${gid}/settings`);
    else active = path === t.href || path.startsWith(`${t.href}/`);
    return { label: t.label, icon: t.icon, href, active };
  });

  if (!guild) return { top, guild: null, categories: [] };

  const base = `/guilds/${gid}`;
  const enabled = new Map(getGuildModules(gid).map((m) => [m.id, m.enabled]));

  const resolve = (it) => {
    if (it.module) {
      const def = getModule(it.module);
      if (!def) return null;
      const href = `${base}/m/${it.module}`;
      return {
        id: it.module,
        label: it.label || def.name,
        icon: ICONS[it.module] || 'sliders',
        href,
        dot: (enabled.get(it.module) ?? def.defaultEnabled) ? 'on' : 'off',
        active: path === href,
      };
    }
    const href = `${base}/${it.page}`;
    let dot = 'spacer';
    let id;
    if (it.dotModule) {
      const def = getModule(it.dotModule);
      id = it.dotModule;
      dot = (enabled.get(it.dotModule) ?? def?.defaultEnabled) ? 'on' : 'off';
    }
    return { id, label: it.label, icon: ICONS[it.page] || 'list', href, dot, active: path === href };
  };

  const categories = CATEGORIES.map((c) => ({
    key: c.key,
    title: c.title,
    items: c.items.map(resolve).filter(Boolean),
  }));

  return { top, guild: { id: gid, name: guild.name, icon: guild.iconURL({ size: 64 }) }, categories };
}
