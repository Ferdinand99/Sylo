// The model of the command palette (Ctrl+K): which places it can jump to, how a typed text ranks them and
// how the recent ones are remembered. Pure functions (the storage calls aside), so the wording and the
// order are tested without rendering anything.
import { cardTone, navModel, TONE_LABEL } from './overviewModel.js';
import { v2Href } from './moduleForms/index.js';

/** The groups of the list, in the order they are shown. */
export const GROUPS = [
  'Recent',
  'Members',
  'Inbox items',
  'Pages',
  'Inbox',
  'Modules',
  'Servers',
  'More',
  'Bot owner',
];

const RECENT_KEY = 'sylo:v2:paletteRecent';
const MAX_RECENT = 5;
/** The most results a typed text shows; the list is for a short pick, not for scrolling a catalogue. */
const MAX_SHOWN = 30;

const pathOf = (href) => String(href).split('?')[0];

/** The recent items' keys, newest first. Best effort, like the other stored conveniences. */
export function readRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((k) => typeof k === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function rememberRecent(key) {
  try {
    const next = [key, ...readRecent().filter((k) => k !== key)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    return next;
  } catch {
    return [];
  }
}

const NAV_GROUPS = [
  ['top', 'Pages'],
  ['people', 'Pages'],
  ['server', 'Pages'],
  ['inbox', 'Inbox'],
  ['more', 'More'],
  ['bot', 'Bot owner'],
];

/**
 * Every place the palette can open for the picked server: the pages of the sidebar, every module page (also a
 * module that is switched off: the person may be looking for where to switch it on), and the other servers.
 * An item is `{ key, group, label, hint, href, icon, keywords }`; `href` is relative to the dashboard base.
 * @param {{ guildId: string|null, data: object|null, operator: boolean, guilds?: Array<{id: string, name: string}> }} src
 */
export function paletteItems({ guildId, data, operator, guilds = [] }) {
  const nav = navModel({ guildId, data, operator });
  const items = [];
  const seen = new Set();
  const add = (item) => {
    if (!item.href) return;
    items.push({ hint: '', keywords: '', ...item });
    seen.add(pathOf(item.href));
  };

  for (const [part, group] of NAV_GROUPS) {
    for (const it of nav[part]) {
      add({
        key: `page:${it.key}`,
        group,
        label: it.label,
        icon: it.icon,
        href: it.href,
        hint: it.count ? `${it.count} waiting` : '',
      });
    }
  }

  const problems = new Set((data?.attention?.problems ?? []).map((p) => p.id));
  for (const grp of data?.groups ?? []) {
    for (const card of grp.cards ?? []) {
      const href = guildId ? v2Href(card, guildId) : null;
      const tone = cardTone(card, problems);
      const hint = [grp.title, tone === 'link' ? '' : TONE_LABEL[tone]].filter(Boolean).join(' · ');
      if (href && !seen.has(pathOf(href))) {
        add({
          key: `module:${card.id}`,
          group: 'Modules',
          // The ticket and appeal queues are pages of their own; the module card is their settings.
          label: NAMED_SETTINGS.has(card.id) ? `${card.name} settings` : card.name,
          icon: card.icon,
          href,
          hint,
          keywords: grp.title,
        });
      } else if (href && SETTINGS_TAB[card.id]) {
        // The page is in the sidebar already (Suggestions, Applications): its settings are the part with
        // no sidebar entry of their own.
        add({
          key: `module:${card.id}:settings`,
          group: 'Modules',
          label: `${card.name} settings`,
          icon: card.icon,
          href: `${href}?tab=${SETTINGS_TAB[card.id]}`,
          hint,
          keywords: grp.title,
        });
      }
    }
  }

  for (const g of guilds) {
    if (g.id === guildId) continue;
    add({
      key: `guild:${g.id}`,
      group: 'Servers',
      label: `Switch to ${g.name}`,
      icon: 'grid',
      href: `/guilds/${g.id}`,
      keywords: `server ${g.name}`,
    });
  }
  return items;
}

// The tab that holds a module's settings when its main page is an inbox queue.
const SETTINGS_TAB = { suggestions: 'settings', applications: 'panel' };
const NAMED_SETTINGS = new Set(['tickets', 'appeals']);

const fold = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');

/**
 * How well one item matches the typed words: 0 for no match, higher is better. Every word must be found
 * (in the label, or the words kept with it); a label that starts with the word, or has a word that does,
 * ranks over one that only contains it.
 */
export function scoreItem(item, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const label = fold(item.label);
  const extra = fold(`${item.keywords} ${item.hint}`);
  let total = 0;
  for (const w of words) {
    let s = 0;
    if (label.startsWith(w)) s = 100;
    else if (label.split(/[^a-z0-9]+/).some((p) => p.startsWith(w))) s = 70;
    else if (label.includes(w)) s = 40;
    else if (extra.includes(w)) s = 15;
    if (!s) return 0;
    total += s;
  }
  return total;
}

/**
 * The list to show: with nothing typed, the recent items first and then the pages; with a text, the items
 * that match, best first (a recent one wins a tie), plus the `extra` items found on the server (members,
 * inbox items by number), which come first because the person typed their name or number.
 * @returns {Array<{ group: string } & object>}
 */
export function rankItems(items, query, recent = [], extra = []) {
  const typed = String(query ?? '').trim();
  const byKey = new Map(items.map((i) => [i.key, i]));
  if (!typed) {
    const recents = recent.map((k) => byKey.get(k)).filter(Boolean);
    const rest = items.filter((i) => !recents.includes(i) && ['Pages', 'Inbox'].includes(i.group));
    return [...recents.map((i) => ({ ...i, group: 'Recent' })), ...rest];
  }
  const scored = items
    .map((item, index) => ({ item, index, score: scoreItem(item, typed) }))
    .filter((r) => r.score > 0)
    .sort(
      (a, b) =>
        b.score +
          (recent.includes(b.item.key) ? 25 : 0) -
          (a.score + (recent.includes(a.item.key) ? 25 : 0)) || a.index - b.index
    )
    .slice(0, MAX_SHOWN)
    .map((r) => r.item);
  return [...extra, ...scored];
}

/** The list grouped for display, keeping each group's items in rank order and the groups in GROUPS order. */
export function groupItems(list) {
  const out = [];
  for (const group of GROUPS) {
    const members = list.filter((i) => i.group === group);
    if (members.length) out.push({ group, items: members });
  }
  return out;
}
