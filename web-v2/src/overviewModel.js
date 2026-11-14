// The view-model of the overview and the sidebar: what each module card says about itself in one line,
// which colour it gets, what needs attention, and how the sidebar is grouped. Pure functions, so the
// wording and the grouping are tested without rendering anything.
import { plural } from './components/Meta.jsx';
import { v2Href } from './moduleForms/index.js';
import { healthItems } from './healthModel.js';

const hrefOf = (id, guildId) => v2Href({ id }, guildId);

const lineText = (l) => (l.value === 'on' || l.value === 'yes' ? l.label : `${l.label}: ${l.value}`);

/**
 * The summary of a card as short parts ("#welcome", "Verified role"), written by the server in plain words
 * (summaryParts on the card). A card from an older server has none: the parts are then built from its
 * lines ("Log channel: #server-log"). A phone shows only the first part.
 * @returns {string[]}
 */
export function cardSummaryParts(card) {
  if (!Array.isArray(card.summaryParts)) return [legacySummary(card)];
  const parts = card.summaryParts;
  if (!card.hasToggle) return parts.length ? parts : [card.description ?? ''];
  if (card.status === 'blocked') return ['Blocked: the bot needs a permission first'];
  if (!card.enabled) {
    const nothing = card.empty || card.waitingForOwner || parts[0] === 'Not set up yet';
    return parts.length && !nothing ? ['Off', parts[0]] : ['Off'];
  }
  return parts.length ? parts : ['On'];
}

/** The summary as one line: parts joined with " · ". */
export const cardSummary = (card) => cardSummaryParts(card).join(' · ');

/**
 * One line that says how a module is set up, from the lines the server already sends for its card:
 * "Log channel: #server-log · Events tracked: 8 of 12", "Not set up", "Off".
 * @param {{ hasToggle?: boolean, enabled?: boolean|null, status?: string, lines?: Array<{label: string, value: string, state: string}>, description?: string }} card
 */
function legacySummary(card) {
  const lines = Array.isArray(card.lines) ? card.lines : [];
  const on = lines.filter((l) => l.state === 'on');
  if (!card.hasToggle) return on.length ? on.slice(0, 2).map(lineText).join(' · ') : (card.description ?? '');
  if (card.status === 'blocked') return 'Blocked: the bot needs a permission first';
  if (!card.enabled) return on.length ? `Off · ${lineText(on[0])}` : 'Off';
  if (lines.length > 0 && lines.every((l) => l.state === 'off')) return 'Not set up';
  const shown = on.length ? on : lines.filter((l) => l.state === 'neutral');
  return shown.slice(0, 2).map(lineText).join(' · ') || 'On';
}

/**
 * The colour of a module row: 'ok' (green: on and set up), 'warn' (amber: on but it needs something, or
 * blocked), 'off' (grey: switched off) or 'link' (a page with no switch).
 * @param {object} card
 * @param {Set<string>} [problemIds]  ids of modules the server reports as misconfigured
 */
export function cardTone(card, problemIds = new Set()) {
  if (!card.hasToggle) return 'link';
  if (!card.enabled) return 'off';
  if (card.status === 'blocked' || problemIds.has(card.id) || card.waitingForOwner) return 'warn';
  const lines = card.lines ?? [];
  if (lines.length > 0 && lines.every((l) => l.state === 'off')) return 'warn';
  return 'ok';
}

/** The short word shown next to the dot of a module row. */
export const TONE_LABEL = { ok: 'On', warn: 'Needs setup', off: 'Off', link: '' };

/**
 * The word next to the dot of one module row: the generic one for its colour, except for a module that
 * waits for API keys only the bot owner can add (nothing an admin can do about it).
 */
export function toneLabel(card, tone) {
  return tone === 'warn' && card.waitingForOwner ? 'Waiting for the bot owner' : TONE_LABEL[tone];
}

/** The filter chips of the overview: [key, label]. */
export const STATUS_FILTERS = [
  ['all', 'All'],
  ['setup', 'Needs setup'],
  ['on', 'On'],
  ['off', 'Off'],
];

/** Whether a card shows under a status filter ('all', 'setup' = amber, 'on' = green, 'off' = grey). */
export function matchesStatus(filter, tone) {
  if (filter === 'setup') return tone === 'warn';
  if (filter === 'on') return tone === 'ok';
  if (filter === 'off') return tone === 'off';
  return true;
}

/**
 * Whether a phone should open a category folded: when every module in it is switched on and fine, there
 * is nothing to look at. A category with a module that needs setup, is off, or is a plain link stays open.
 */
export function startsFolded(cards, problemIds = new Set()) {
  const switches = cards.filter((c) => c.hasToggle);
  return switches.length > 0 && cards.every((c) => c.hasToggle && cardTone(c, problemIds) === 'ok');
}

/**
 * The "Needs attention" list: waiting work first (open tickets, appeals, applications, suggestions),
 * then modules that are on but not set up, then modules the bot cannot run, then missing permissions.
 * Each item has the page where it is fixed (`href`, relative to the dashboard base), except missing
 * permissions, which are given to the bot's role in Discord itself.
 * @returns {Array<{ key: string, kind: 'waiting'|'setup'|'info'|'blocked'|'permissions', title: string, detail: string, href: string|null }>}
 */
export function attentionItems(data, guildId) {
  if (!data) return [];
  const a = data.attention ?? {};
  const waiting = a.waiting ?? {};
  const items = [];
  // The server counts waiting work only for modules that are on; an older server sends just the two totals.
  const tickets = Number(a.waiting ? (waiting.tickets ?? 0) : (data.openTickets ?? 0));
  const appeals = Number(a.waiting ? (waiting.appeals ?? 0) : (data.openAppeals ?? 0));
  const applications = Number(waiting.applications ?? 0);
  const suggestions = Number(waiting.suggestions ?? 0);
  const where = a.platform === 'fluxer' ? 'Fluxer' : 'Discord';
  const work = (key, n, one, many, href) => {
    if (n > 0)
      items.push({ key, kind: 'waiting', title: plural(n, one, many), detail: 'Waiting for a person', href });
  };
  work('tickets', tickets, 'open ticket', 'open tickets', `/guilds/${guildId}/tickets`);
  work('appeals', appeals, 'open ban appeal', 'open ban appeals', `/guilds/${guildId}/appeals`);
  work(
    'applications',
    applications,
    'application waiting',
    'applications waiting',
    `/guilds/${guildId}/m/applications?tab=submissions`
  );
  work('suggestions', suggestions, 'open suggestion', 'open suggestions', `/guilds/${guildId}/m/suggestions`);

  const cards = (data.groups ?? []).flatMap((g) => g.cards ?? []);
  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const p of a.problems ?? []) {
    // The card tells the current state: a module switched off since the data was built is not a problem.
    if (byId.get(p.id) && byId.get(p.id).enabled === false) continue;
    items.push({
      key: `setup-${p.id}`,
      kind: 'setup',
      title: `${p.name} is on but not set up`,
      detail: p.issues.join('. '),
      href: hrefOf(p.id, guildId),
    });
  }
  // What Sylo cannot do in the channels and roles a module uses (a role above Sylo's, a channel it cannot
  // post in): one item per module, with a "Fix" link to the module's page.
  for (const item of healthItems(a.health, guildId)) {
    if (byId.get(item.moduleId) && byId.get(item.moduleId).enabled === false) continue;
    items.push(item);
  }
  // Modules that wait for API keys only the bot operator can add (the server sends them to an operator
  // only): for information, no "Fix" link.
  for (const w of a.waitingForOwner ?? []) {
    if (byId.get(w.id) && byId.get(w.id).enabled === false) continue;
    items.push({
      key: `owner-${w.id}`,
      kind: 'info',
      title: `${w.name} is waiting for the bot owner`,
      detail: `The bot owner has not added the ${w.keys} yet, so nothing is posted. There is nothing to fix here.`,
      href: null,
    });
  }
  for (const c of cards) {
    if (c.hasToggle && c.enabled && c.status === 'blocked') {
      items.push({
        key: `blocked-${c.id}`,
        kind: 'blocked',
        title: `${c.name} cannot run`,
        detail: 'The bot lacks a permission that only the bot owner can allow.',
        href: hrefOf(c.id, guildId),
      });
    }
  }
  if ((a.missingPermissions ?? []).length) {
    items.push({
      key: 'permissions',
      kind: 'permissions',
      title: `Sylo is missing ${plural(a.missingPermissions.length, 'permission', 'permissions')}`,
      detail: `Give Sylo's role in ${where}: ${a.missingPermissions.join(', ')}.`,
      href: null,
    });
  }
  return items;
}

/** Ids of the modules the server reports as on but misconfigured. */
export const problemIdsOf = (data) => new Set((data?.attention?.problems ?? []).map((p) => p.id));

// Cards that have their own place in the sidebar, outside the Modules group.
const MOVED_TO_SERVER = new Set(['general', 'commands']);
const MOVED_TO_MODERATION = new Set(['moderation']);
// Inbox entries that open the same page as the module's own card; the card is then not listed twice.
const INBOX_SAME_PAGE = new Set(['applications', 'suggestions']);
// Inbox entries whose queue is another page than the module's settings: the settings keep an entry.
const SETTINGS_SUFFIX = new Set(['tickets', 'appeals']);

/**
 * The sidebar as groups. `guildId` is null before a server is picked (links are then null and shown
 * disabled). `operator` is whether the server marks the viewer as the bot owner (OWNER_IDS): the bot
 * pages (Bot personalizer, Health, Roadmap admin, Stats cache) only exist for them.
 */
export function navModel({ guildId, data, operator }) {
  const g = (path) => (guildId ? `/guilds/${guildId}${path}` : null);
  const waiting = data?.attention?.waiting ?? {};
  const count = (n) => (Number(n) > 0 ? Number(n) : 0);
  const top = [{ key: 'overview', label: 'Overview', icon: 'grid', href: g('') }];
  const ticketCount = data?.attention ? waiting.tickets : data?.openTickets;
  const appealCount = data?.attention ? waiting.appeals : data?.openAppeals;
  const inbox = [
    {
      key: 'tickets',
      label: 'Tickets',
      icon: 'inbox',
      href: g('/tickets'),
      prefix: true,
      count: count(ticketCount),
    },
    {
      key: 'appeals',
      label: 'Appeals',
      icon: 'flag',
      href: g('/appeals'),
      prefix: true,
      count: count(appealCount),
    },
    {
      key: 'applications',
      label: 'Applications',
      icon: 'clipboard',
      // With work waiting the entry opens on the queue; with none, on the forms (the page's own default).
      href: g(count(waiting.applications) > 0 ? '/m/applications?tab=submissions' : '/m/applications'),
      prefix: true,
      count: count(waiting.applications),
    },
    {
      key: 'suggestions',
      label: 'Suggestions',
      icon: 'lightbulb',
      href: g('/m/suggestions'),
      prefix: true,
      count: count(waiting.suggestions),
    },
  ];
  const people = [
    { key: 'moderation', label: 'Moderation hub', icon: 'shield', href: g('/moderation'), prefix: true },
    { key: 'member-data', label: 'Member data', icon: 'database', href: g('/member-data') },
    { key: 'leaderboard', label: 'Leaderboard', icon: 'trophy', href: g('/leaderboard') },
    { key: 'audit', label: 'Audit log', icon: 'history', href: g('/audit') },
  ];
  const modules = (data?.groups ?? [])
    .map((grp) => ({
      title: grp.title,
      cards: grp.cards
        .filter((c) => !c.hasToggle || c.enabled)
        .filter(
          (c) => !MOVED_TO_SERVER.has(c.id) && !MOVED_TO_MODERATION.has(c.id) && !INBOX_SAME_PAGE.has(c.id)
        )
        .map((c) => ({
          id: c.id,
          name: SETTINGS_SUFFIX.has(c.id) ? `${c.name} settings` : c.name,
          href: guildId ? hrefOf(c.id, guildId) : null,
          beta: Boolean(c.beta),
        })),
    }))
    .filter((grp) => grp.cards.length > 0);
  const server = [
    { key: 'settings', label: 'Server settings', icon: 'gear', href: g('/settings') },
    { key: 'commands', label: 'Commands', icon: 'terminal', href: g('/moderation/commands') },
  ];
  const more = [
    { key: 'command-list', label: 'Command list', icon: 'list', href: '/commands' },
    { key: 'roadmap', label: 'Roadmap', icon: 'megaphone', href: '/roadmap' },
    { key: 'changelog', label: "What's new", icon: 'sparkles', href: '/changelog' },
  ];
  const bot = operator
    ? [
        { key: 'personalizer', label: 'Bot personalizer', icon: 'id', href: '/settings' },
        { key: 'health', label: 'Health', icon: 'pulse', href: '/health' },
        { key: 'roadmap-admin', label: 'Roadmap admin', icon: 'megaphone', href: '/roadmap/admin' },
        { key: 'stats', label: 'Game stats cache', icon: 'chart', href: '/stats' },
      ]
    : [];
  return { top, inbox, people, modules, server, more, bot };
}
