import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  groupItems,
  paletteItems,
  rankItems,
  readRecent,
  rememberRecent,
  scoreItem,
} from '../paletteModel.js';

vi.mock('../moduleForms/index.js', () => ({
  v2Href: (card, guildId) =>
    card.id === 'general' ? `/guilds/${guildId}/settings` : `/guilds/${guildId}/m/${card.id}`,
}));

const G = '111111111111111111';
const data = {
  attention: { waiting: { tickets: 2 }, problems: [{ id: 'welcome' }] },
  groups: [
    {
      title: 'Engagement',
      cards: [
        { id: 'welcome', name: 'Welcome', hasToggle: true, enabled: true, icon: 'users', lines: [] },
        { id: 'leveling', name: 'Leveling', hasToggle: true, enabled: false, icon: 'star' },
        { id: 'suggestions', name: 'Suggestions', hasToggle: true, enabled: true, icon: 'bulb' },
      ],
    },
    {
      title: 'Support',
      cards: [
        { id: 'tickets', name: 'Tickets', hasToggle: true, enabled: true, icon: 'ticket' },
        { id: 'general', name: 'Settings', hasToggle: false, icon: 'gear' },
      ],
    },
  ],
};
const guilds = [
  { id: G, name: 'Home' },
  { id: '222222222222222222', name: 'Other base' },
];
const build = (over = {}) => paletteItems({ guildId: G, data, operator: false, guilds, ...over });
const labels = (items) => items.map((i) => i.label);

beforeEach(() => localStorage.clear());

describe('paletteItems', () => {
  it('lists the pages, the inbox, every module (also one that is off) and the other servers', () => {
    const items = build();
    expect(labels(items)).toEqual(
      expect.arrayContaining([
        'Overview',
        'Audit log',
        'Server settings',
        'Tickets',
        'Welcome',
        'Leveling',
        'Command list',
        "What's new",
        'Switch to Other base',
      ])
    );
    expect(labels(items)).not.toContain('Switch to Home');
    expect(items.find((i) => i.key === 'module:leveling').hint).toBe('Engagement · Off');
    expect(items.find((i) => i.key === 'module:welcome').hint).toBe('Engagement · Needs setup');
  });

  it('does not list a page twice: the Settings card is the Server settings page', () => {
    const items = build();
    const paths = items.map((i) => i.href);
    expect(new Set(paths).size).toBe(paths.length);
    expect(labels(items)).not.toContain('Settings');
  });

  it('gives the ticket module its settings label and the inbox modules a settings entry', () => {
    const items = build();
    expect(items.find((i) => i.key === 'module:tickets:settings').label).toBe('Ticket settings');
    expect(items.find((i) => i.key === 'module:suggestions:settings').href).toBe(
      `/guilds/${G}/m/suggestions?tab=settings`
    );
    expect(items.find((i) => i.key === 'page:tickets').hint).toBe('2 waiting');
  });

  it('writes the settings labels itself: a renamed module does not change them', () => {
    const renamed = {
      ...data,
      groups: data.groups.map((g) => ({
        ...g,
        cards: g.cards.map((c) => (c.id === 'tickets' ? { ...c, name: 'Tickets (modmail)' } : c)),
      })),
    };
    const items = build({ data: renamed });
    expect(items.find((i) => i.key === 'module:tickets:settings').label).toBe('Ticket settings');
    // The module's name still finds it.
    expect(rankItems(items, 'modmail')[0].key).toBe('module:tickets:settings');
  });

  it('shows the bot pages only to the operator', () => {
    expect(labels(build())).not.toContain('Health');
    expect(labels(build({ operator: true }))).toContain('Health');
  });

  it('has no server pages before a server is picked', () => {
    const items = paletteItems({ guildId: null, data: null, operator: false, guilds });
    expect(labels(items)).not.toContain('Audit log');
    expect(labels(items)).toContain('Roadmap');
  });
});

describe('rankItems', () => {
  const items = build();

  it('shows the recent items first, then the pages, when nothing is typed', () => {
    const out = rankItems(items, '', ['module:leveling', 'page:audit']);
    expect(out.slice(0, 2).map((i) => i.key)).toEqual(['module:leveling', 'page:audit']);
    expect(out[0].group).toBe('Recent');
    expect(out.filter((i) => i.key === 'page:audit')).toHaveLength(1);
    expect(out.some((i) => i.group === 'Modules')).toBe(false);
  });

  it('matches every typed word, best match first', () => {
    const out = rankItems(items, 'wel');
    expect(out[0].label).toBe('Welcome');
    expect(labels(rankItems(items, 'server set'))).toEqual(['Server settings']);
    expect(rankItems(items, 'zzzz')).toEqual([]);
  });

  it('puts a recent item ahead of an equal match', () => {
    const plain = rankItems(items, 'set');
    const withRecent = rankItems(items, 'set', ['module:tickets:settings']);
    expect(plain[0].key).not.toBe('module:tickets:settings');
    expect(withRecent[0].key).toBe('module:tickets:settings');
  });

  it('puts the items found on the server first', () => {
    const extra = [
      { key: 'member:1', group: 'Members', label: 'Open member data for Welcome Wagon', href: '/x' },
    ];
    expect(rankItems(items, 'wel', [], extra)[0].key).toBe('member:1');
  });

  it('ignores case and accents', () => {
    expect(scoreItem({ label: 'Café', keywords: '', hint: '' }, 'CAFE')).toBeGreaterThan(0);
  });
});

describe('groupItems', () => {
  it('keeps the groups in their set order', () => {
    const groups = groupItems([
      { group: 'Servers', key: 'a' },
      { group: 'Pages', key: 'b' },
      { group: 'Recent', key: 'c' },
      { group: 'Pages', key: 'd' },
    ]);
    expect(groups.map((g) => g.group)).toEqual(['Recent', 'Pages', 'Servers']);
    expect(groups[1].items.map((i) => i.key)).toEqual(['b', 'd']);
  });
});

describe('recent items', () => {
  it('remembers the newest first, once each, at most five', () => {
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f', 'c']) rememberRecent(k);
    expect(readRecent()).toEqual(['c', 'f', 'e', 'd', 'b']);
  });

  it('survives unreadable storage', () => {
    localStorage.setItem('sylo:v2:paletteRecent', '{not json');
    expect(readRecent()).toEqual([]);
  });
});
