import { describe, expect, it, vi } from 'vitest';
import {
  attentionItems,
  cardSummary,
  cardSummaryParts,
  cardTone,
  navModel,
  problemIdsOf,
} from '../overviewModel.js';
import { readCollapsed, toggled, writeCollapsed } from '../collapsedGroups.js';

vi.mock('../moduleForms/index.js', () => ({
  v2Href: (card, guildId) =>
    card.id === 'general' ? `/guilds/${guildId}/settings` : `/guilds/${guildId}/m/${card.id}`,
}));

const G = '123456789012345678';
const card = (over) => ({
  id: 'logging',
  name: 'Server logging',
  description: 'Logs events',
  hasToggle: true,
  enabled: true,
  status: 'on',
  missingIntents: [],
  lines: [],
  ...over,
});
const line = (label, value, state) => ({ label, value, state });

describe('cardSummary', () => {
  it('shows the lines that are set, two at most', () => {
    const c = card({
      lines: [
        line('Log channel', '#server-log', 'on'),
        line('Events tracked', '8 of 12', 'on'),
        line('x', 'y', 'on'),
      ],
    });
    expect(cardSummary(c)).toBe('Log channel: #server-log · Events tracked: 8 of 12');
  });

  it('names a line by its label alone when its value is only "on"', () => {
    expect(cardSummary(card({ lines: [line('Welcome DM', 'on', 'on')] }))).toBe('Welcome DM');
  });

  it('says "Not set up" when every line is off, and "Off" for a module that is switched off', () => {
    const lines = [line('Log channel', 'not set', 'off'), line('Events tracked', '0 of 12', 'off')];
    expect(cardSummary(card({ lines }))).toBe('Not set up');
    expect(cardSummary(card({ lines, enabled: false }))).toBe('Off');
  });

  it('keeps one set line next to "Off", falls back to neutral lines, and then to "On"', () => {
    expect(cardSummary(card({ enabled: false, lines: [line('Channel', '#welcome', 'on')] }))).toBe(
      'Off · Channel: #welcome'
    );
    expect(
      cardSummary(card({ lines: [line('Mode', 'button', 'neutral'), line('Open', '0', 'neutral')] }))
    ).toBe('Mode: button · Open: 0');
    expect(cardSummary(card({ lines: [] }))).toBe('On');
  });

  it('says a blocked module needs a permission, and a link card shows its lines or its description', () => {
    expect(cardSummary(card({ status: 'blocked' }))).toMatch(/Blocked/);
    expect(
      cardSummary({
        hasToggle: false,
        description: 'Bot masters',
        lines: [line('Mod-log channel', '#mod-log', 'on')],
      })
    ).toBe('Mod-log channel: #mod-log');
    expect(cardSummary({ hasToggle: false, description: 'Bot masters', lines: [] })).toBe('Bot masters');
  });
});

describe('cardTone', () => {
  it('is green when set up, amber when on but not set up or blocked, grey when off', () => {
    expect(cardTone(card({ lines: [line('Log channel', '#a', 'on')] }))).toBe('ok');
    expect(cardTone(card({ lines: [line('Log channel', 'not set', 'off')] }))).toBe('warn');
    expect(cardTone(card({ status: 'blocked' }))).toBe('warn');
    expect(cardTone(card({ enabled: false }))).toBe('off');
    expect(cardTone(card({ hasToggle: false }))).toBe('link');
  });

  it('is amber for a module the server reports as misconfigured, even with lines that look fine', () => {
    const c = card({ lines: [line('Log channel', '#a', 'on')] });
    expect(cardTone(c, new Set(['logging']))).toBe('warn');
    expect(cardTone(card({ enabled: false }), new Set(['logging']))).toBe('off');
  });
});

describe('attentionItems', () => {
  const data = {
    openTickets: 2,
    openAppeals: 0,
    groups: [
      { title: 'x', cards: [card(), card({ id: 'verification', name: 'Verification', status: 'blocked' })] },
    ],
    attention: {
      problems: [{ id: 'logging', name: 'Server logging', issues: ['The log channel is not set'] }],
      missingPermissions: ['Ban Members', 'Manage Roles'],
      waiting: { tickets: 2, appeals: 0, applications: 3, suggestions: 1 },
    },
  };

  it('lists waiting work first, then setup problems, blocked modules and permissions, each with a place to fix it', () => {
    const items = attentionItems(data, G);
    expect(items.map((i) => i.key)).toEqual([
      'tickets',
      'applications',
      'suggestions',
      'setup-logging',
      'blocked-verification',
      'permissions',
    ]);
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey.tickets.title).toBe('2 open tickets');
    expect(byKey.tickets.href).toBe(`/guilds/${G}/tickets`);
    expect(byKey.applications.title).toBe('3 applications waiting');
    expect(byKey.applications.href).toBe(`/guilds/${G}/m/applications?tab=submissions`);
    expect(byKey.suggestions.title).toBe('1 open suggestion');
    expect(byKey['setup-logging'].detail).toBe('The log channel is not set');
    expect(byKey['setup-logging'].href).toBe(`/guilds/${G}/m/logging`);
    expect(byKey.permissions.detail).toContain('Ban Members, Manage Roles');
    expect(byKey.permissions.href).toBeNull();
  });

  it('is empty when nothing is waiting, and survives an overview without the attention data', () => {
    expect(attentionItems({ openTickets: 0, openAppeals: 0, groups: [] }, G)).toEqual([]);
    expect(attentionItems(null, G)).toEqual([]);
    expect(attentionItems({ openTickets: 1, openAppeals: 0, groups: [] }, G).map((i) => i.key)).toEqual([
      'tickets',
    ]);
  });

  it('drops a setup problem for a module that has been switched off since', () => {
    const off = { ...data, groups: [{ title: 'x', cards: [card({ enabled: false })] }] };
    expect(attentionItems(off, G).map((i) => i.key)).not.toContain('setup-logging');
    expect([...problemIdsOf(data)]).toEqual(['logging']);
  });
});

describe('navModel', () => {
  const data = {
    openTickets: 4,
    openAppeals: 0,
    attention: { waiting: { tickets: 4, appeals: 0, applications: 2, suggestions: 0 } },
    groups: [
      {
        title: 'Core',
        cards: [
          card({ id: 'general', name: 'Settings', hasToggle: false, enabled: null }),
          card({ id: 'commands', name: 'Commands', hasToggle: false, enabled: null }),
          card({ id: 'moderation', name: 'Moderation' }),
        ],
      },
      {
        title: 'Engagement',
        cards: [
          card({ id: 'welcome', name: 'Welcome & leave' }),
          card({ id: 'applications', name: 'Applications' }),
          card({ id: 'suggestions', name: 'Suggestions' }),
          card({ id: 'tickets', name: 'Tickets' }),
          card({ id: 'counting', name: 'Counting', enabled: false }),
        ],
      },
    ],
  };

  it('opens with an Overview link, then the inbox, members and moderation, and server links, with counts', () => {
    const nav = navModel({ guildId: G, data, operator: false });
    expect(nav.top.map((i) => [i.label, i.href])).toEqual([['Overview', `/guilds/${G}`]]);
    expect(nav.inbox.map((i) => [i.label, i.count])).toEqual([
      ['Tickets', 4],
      ['Appeals', 0],
      ['Applications', 2],
      ['Suggestions', 0],
    ]);
    expect(nav.people.map((i) => i.label)).toEqual([
      'Moderation hub',
      'Member data',
      'Leaderboard',
      'Audit log',
    ]);
    expect(nav.server.map((i) => i.label)).toEqual(['Server settings', 'Commands']);
  });

  it('opens the Applications entry on the queue when applications wait, and on the page default when none do', () => {
    const href = (d) => navModel({ guildId: G, data: d, operator: false }).inbox.find((i) => i.key === 'applications').href;
    expect(href(data)).toBe(`/guilds/${G}/m/applications?tab=submissions`);
    const none = { ...data, attention: { waiting: { ...data.attention.waiting, applications: 0 } } };
    expect(href(none)).toBe(`/guilds/${G}/m/applications`);
    // Suggestions open on the queue by themselves; their entry needs no query.
    const sug = navModel({ guildId: G, data, operator: false }).inbox.find((i) => i.key === 'suggestions');
    expect(sug.href).toBe(`/guilds/${G}/m/suggestions`);
  });

  it('takes the inbox counts from the attention data (a module that is off counts nothing), else from the totals', () => {
    const off = {
      ...data,
      attention: { waiting: { tickets: 0, appeals: 0, applications: 0, suggestions: 0 } },
    };
    expect(navModel({ guildId: G, data: off, operator: false }).inbox.map((i) => i.count)).toEqual([
      0, 0, 0, 0,
    ]);
    const old = { openTickets: 3, openAppeals: 1, groups: [] };
    expect(navModel({ guildId: G, data: old, operator: false }).inbox.map((i) => i.count)).toEqual([
      3, 1, 0, 0,
    ]);
  });

  it('lists each module once: no Settings, Commands or Moderation twin, and only modules that are on', () => {
    const nav = navModel({ guildId: G, data, operator: false });
    const names = nav.modules.flatMap((g) => g.cards.map((c) => c.name));
    expect(names).toEqual(['Welcome & leave', 'Tickets settings']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('hides every bot-owner page, the Bot personalizer included, from everyone but the bot owner', () => {
    const everyone = navModel({ guildId: G, data, operator: false });
    expect(everyone.bot).toEqual([]);
    const labels = (n) =>
      Object.values(n)
        .flat()
        .map((i) => i.label ?? '');
    expect(labels(everyone)).not.toContain('Bot personalizer');
    expect(navModel({ guildId: G, data, operator: true }).bot.map((i) => i.label)).toEqual([
      'Bot personalizer',
      'Health',
      'Roadmap admin',
      'Game stats cache',
    ]);
  });

  it('has no server addresses before a server is picked', () => {
    const nav = navModel({ guildId: null, data: null, operator: false });
    expect(nav.top[0].href).toBeNull();
    expect(nav.inbox.every((i) => i.href === null)).toBe(true);
    expect(nav.modules).toEqual([]);
  });
});

describe('cardSummaryParts', () => {
  it('uses the parts the server wrote, "Off" for a module that is off, and "On" when there is nothing to say', () => {
    expect(cardSummaryParts(card({ summaryParts: ['#welcome', 'Verified role'] }))).toEqual([
      '#welcome',
      'Verified role',
    ]);
    expect(cardSummary(card({ summaryParts: ['#welcome', 'Verified role'] }))).toBe(
      '#welcome · Verified role'
    );
    expect(cardSummaryParts(card({ enabled: false, summaryParts: ['#welcome', 'Verified role'] }))).toEqual([
      'Off',
      '#welcome',
    ]);
    expect(cardSummaryParts(card({ enabled: false, summaryParts: ['Not set up yet'] }))).toEqual(['Off']);
    expect(cardSummaryParts(card({ summaryParts: [] }))).toEqual(['On']);
    expect(cardSummaryParts(card({ summaryParts: ['x'], status: 'blocked' }))[0]).toMatch(/Blocked/);
    expect(cardSummaryParts({ hasToggle: false, description: 'Bot masters', summaryParts: [] })).toEqual([
      'Bot masters',
    ]);
  });

  it('builds the parts from the lines for a server that does not send them', () => {
    expect(cardSummaryParts(card({ lines: [line('Log channel', '#a', 'on')] }))).toEqual(['Log channel: #a']);
  });
});

describe('attentionItems with the attention data', () => {
  it('counts waiting work only from the attention data, and names the platform in the permission hint', () => {
    const base = {
      openTickets: 9,
      openAppeals: 9,
      groups: [],
      attention: {
        platform: 'fluxer',
        problems: [],
        missingPermissions: ['Ban Members'],
        waiting: { tickets: 0, appeals: 0, applications: 0, suggestions: 0 },
      },
    };
    const items = attentionItems(base, G);
    expect(items.map((i) => i.key)).toEqual(['permissions']);
    expect(items[0].detail).toBe("Give Sylo's role in Fluxer: Ban Members.");
    const discord = attentionItems({ ...base, attention: { ...base.attention, platform: 'discord' } }, G);
    expect(discord[0].detail).toContain('in Discord');
  });
});

describe('collapsed categories', () => {
  it('round-trips through localStorage and survives storage that throws', () => {
    writeCollapsed(new Set(['Utilities', 'Core']));
    expect([...readCollapsed()].sort()).toEqual(['Core', 'Utilities']);
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readCollapsed().size).toBe(0);
    spy.mockRestore();
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeCollapsed(new Set(['x']))).not.toThrow();
    set.mockRestore();
  });

  it('toggles a title without changing the set it was given', () => {
    const a = new Set(['Core']);
    const b = toggled(a, 'Utilities');
    expect([...b]).toEqual(['Core', 'Utilities']);
    expect([...toggled(b, 'Core')]).toEqual(['Utilities']);
    expect([...a]).toEqual(['Core']);
  });
});
