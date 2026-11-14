import { describe, expect, it } from 'vitest';
import {
  configuredModuleCount,
  goalDone,
  initialChoices,
  initialGoals,
  itemHref,
  itemProblems,
  missingCreates,
  needsSetupOffer,
  reviewSummary,
  toPayload,
  viewerActive,
  fixableChannel,
} from '../setupModel.js';

const field = (over) => ({
  key: 'channel',
  kind: 'channel',
  label: 'Welcome channel',
  optional: false,
  post: true,
  give: false,
  match: null,
  problem: null,
  warning: null,
  create: { name: 'welcome', kind: 'channel', private: false, readOnly: true },
  ...over,
});
const item = (over) => ({
  id: 'welcome',
  goal: 'welcome',
  name: 'Welcome & leave',
  does: [],
  configured: false,
  enabled: false,
  blocked: [],
  warnings: [],
  fields: [field()],
  ...over,
});
const data = (over = {}) => ({
  platform: 'discord',
  goals: [
    { id: 'welcome', label: 'Welcome', description: '' },
    { id: 'verify', label: 'Verify', description: '' },
  ],
  channels: [
    { id: '100000000000000001', name: 'welcome', problem: null },
    { id: '100000000000000002', name: 'quiet', problem: 'Sylo needs Send Messages in this channel.' },
  ],
  roles: [
    {
      id: '200000000000000001',
      name: 'Verified',
      problem: "Sylo can't give this role: move Sylo's role above it.",
    },
  ],
  items: [item()],
  ...over,
});

const card = (over) => ({
  id: 'afk',
  hasToggle: true,
  enabled: true,
  status: 'on',
  lines: [{ label: 'x', value: 'y', state: 'on' }],
  ...over,
});

describe('when the overview offers the wizard', () => {
  it('counts the modules that are on and set up, and offers below three', () => {
    const groups = (n) => [{ title: 'g', cards: Array.from({ length: n }, (_, i) => card({ id: `m${i}` })) }];
    expect(configuredModuleCount(groups(2))).toBe(2);
    expect(needsSetupOffer(groups(2))).toBe(true);
    expect(needsSetupOffer(groups(3))).toBe(false);
  });

  it('does not count a module that is off, a link without a switch or one that is on but not set up', () => {
    const groups = [
      {
        title: 'g',
        cards: [
          card({ id: 'a', enabled: false }),
          card({ id: 'b', hasToggle: false }),
          card({ id: 'c', lines: [{ label: 'x', value: 'none', state: 'off' }] }),
          card({ id: 'd' }),
        ],
      },
    ];
    expect(configuredModuleCount(groups)).toBe(1);
  });

  it('does not count a module the server reports as misconfigured', () => {
    const groups = [{ title: 'g', cards: [card({ id: 'a' })] }];
    expect(configuredModuleCount(groups, new Set(['a']))).toBe(0);
  });
});

describe('the first choices', () => {
  it('pick what was found by name and never tick Create', () => {
    const d = data({
      items: [item({ fields: [field({ match: { id: '100000000000000001', name: 'welcome' } })] })],
    });
    const c = initialChoices(d);
    expect(c.welcome).toEqual({
      on: true,
      fields: { channel: { mode: 'pick', id: '100000000000000001', fix: false } },
    });
    const none = initialChoices(data());
    expect(none.welcome.fields.channel).toEqual({ mode: 'pick', id: '', fix: false });
  });

  it('leave an item that is already set up, or cannot run, switched off', () => {
    const d = data({
      items: [item({ configured: true }), item({ id: 'verification', blocked: ['GuildMembers'] })],
    });
    const c = initialChoices(d);
    expect(c.welcome.on).toBe(false);
    expect(c.verification.on).toBe(false);
  });

  it('start with no goal ticked: the admin picks the goals', () => {
    const d = data({
      items: [item({ configured: true }), item({ id: 'verification', goal: 'verify' })],
    });
    expect(goalDone(d, 'welcome')).toBe(true);
    expect([...initialGoals(d)]).toEqual([]);
  });

  it('pick the channel that already has the name Create would give, when it is what the wizard promises', () => {
    const existing = { id: '100000000000000002', name: 'tickets', gap: null };
    const d = data({
      items: [
        item({ fields: [field({ create: { name: 'tickets', kind: 'channel', private: true, existing } })] }),
      ],
    });
    expect(initialChoices(d).welcome.fields.channel.id).toBe('100000000000000002');
  });

  it('do not pick a channel that others can see for a staff-only field', () => {
    const gap = 'Members with the Verified role can see it.';
    const existing = { id: '100000000000000002', name: 'tickets', gap };
    const d = data({
      items: [
        item({
          fields: [
            field({
              match: null,
              unsafeMatch: { id: '100000000000000003', name: 'logs', gap },
              create: { name: 'tickets', kind: 'channel', private: true, existing },
            }),
          ],
        }),
      ],
    });
    expect(initialChoices(d).welcome.fields.channel.id).toBe('');
  });
});

describe('what stops Apply', () => {
  it('asks for a channel, or a ticked Create, when nothing was found', () => {
    const d = data();
    const c = initialChoices(d);
    expect(itemProblems(d, d.items[0], c.welcome)).toEqual(['Welcome channel: pick one, or tick Create.']);
    c.welcome.fields.channel = { mode: 'create', id: '' };
    expect(itemProblems(d, d.items[0], c.welcome)).toEqual([]);
  });

  it('does not ask for an optional field, and does not look at an item that is switched off', () => {
    const optional = item({ fields: [field({ optional: true, create: null })] });
    const d = data({ items: [optional] });
    const c = initialChoices(d);
    expect(itemProblems(d, optional, c.welcome)).toEqual([]);
    const off = data();
    expect(itemProblems(off, off.items[0], { on: false, fields: {} })).toEqual([]);
  });

  it('reports a channel Sylo cannot post in, but only for a field where Sylo posts', () => {
    const d = data();
    const quiet = { on: true, fields: { channel: { mode: 'pick', id: '100000000000000002' } } };
    expect(itemProblems(d, d.items[0], quiet)[0]).toMatch(/Send Messages/);
    const noPost = item({ fields: [field({ post: false })] });
    expect(itemProblems(d, noPost, quiet)).toEqual([]);
  });

  it('reports a role Sylo cannot give, but a staff role it only pings is fine', () => {
    const give = item({
      id: 'verification',
      fields: [field({ key: 'role', kind: 'role', give: true, post: false })],
    });
    const staff = item({
      id: 'tickets',
      fields: [field({ key: 'role', kind: 'role', give: false, post: false })],
    });
    const d = data({ items: [give, staff] });
    const pick = { on: true, fields: { role: { mode: 'pick', id: '200000000000000001' } } };
    expect(itemProblems(d, give, pick)[0]).toMatch(/move Sylo's role above it/);
    expect(itemProblems(d, staff, pick)).toEqual([]);
  });

  it('reports a pick that is not on the server any more', () => {
    const d = data();
    const gone = { on: true, fields: { channel: { mode: 'pick', id: '999999999999999999' } } };
    expect(itemProblems(d, d.items[0], gone)[0]).toMatch(/not on this server any more/);
  });
});

describe('the summary and the request', () => {
  const two = () =>
    data({
      items: [
        item(),
        item({
          id: 'verification',
          goal: 'verify',
          fields: [
            field({
              key: 'channelId',
              create: { name: 'verify', kind: 'channel', private: false, readOnly: true },
            }),
            field({
              key: 'verifiedRoleId',
              kind: 'role',
              give: true,
              post: false,
              create: { name: 'Verified', kind: 'role' },
            }),
          ],
        }),
      ],
    });

  it('counts what applying would create, once per name, and what has no match', () => {
    const d = two();
    const goals = new Set(['welcome', 'verify']);
    const c = initialChoices(d);
    expect(missingCreates(d, goals, c)).toEqual([
      ['welcome', 'channel'],
      ['verification', 'channelId'],
      ['verification', 'verifiedRoleId'],
    ]);
    for (const [id, key] of missingCreates(d, goals, c)) c[id].fields[key] = { mode: 'create', id: '' };
    expect(reviewSummary(d, goals, c)).toEqual({
      items: 2,
      replaced: 0,
      channels: ['welcome', 'verify'],
      roles: ['Verified'],
      changed: [],
      problems: 0,
    });
  });

  it('only takes the items of the ticked goals that are switched on', () => {
    const d = two();
    const c = initialChoices(d);
    c.welcome.fields.channel = { mode: 'create', id: '' };
    const body = toPayload(d, new Set(['welcome']), c);
    expect(body).toEqual({
      items: [{ id: 'welcome', replace: false, fields: { channel: { create: true } } }],
    });
  });

  it('sends a picked id as an id, and replaces only an item that is set up and switched on', () => {
    const d = data({
      items: [
        item({ configured: true, fields: [field({ match: { id: '100000000000000001', name: 'welcome' } })] }),
      ],
    });
    const c = initialChoices(d);
    c.welcome.on = true;
    expect(toPayload(d, new Set(['welcome']), c)).toEqual({
      items: [{ id: 'welcome', replace: true, fields: { channel: { id: '100000000000000001' } } }],
    });
  });

  it('never sends create for a field the server offers no Create for', () => {
    const d = data({ items: [item({ fields: [field({ create: null })] })] });
    const c = initialChoices(d);
    c.welcome.fields.channel = { mode: 'create', id: '' };
    expect(toPayload(d, new Set(['welcome']), c).items[0].fields.channel).toEqual({});
  });
});

describe('a channel that already has the wanted name', () => {
  const existing = { id: '100000000000000002', name: 'tickets', gap: 'Everyone can see it.' };
  const make = () =>
    data({
      channels: [{ id: '100000000000000002', name: 'tickets', problem: null }],
      items: [
        item({
          fields: [
            field({
              match: { id: '100000000000000002', name: 'tickets' },
              create: { name: 'tickets', kind: 'channel', private: true, readOnly: false, existing },
            }),
          ],
        }),
      ],
    });

  it('is not offered as a Create, and its permissions are changed only when the admin ticked it', () => {
    const d = make();
    const goals = new Set(['welcome']);
    const c = initialChoices(d);
    expect(missingCreates(d, goals, c)).toEqual([]);
    expect(toPayload(d, goals, c).items[0].fields.channel).toEqual({ id: '100000000000000002' });
    expect(reviewSummary(d, goals, c).changed).toEqual([]);

    c.welcome.fields.channel.fix = true;
    expect(toPayload(d, goals, c).items[0].fields.channel).toEqual({ id: '100000000000000002', fix: true });
    expect(reviewSummary(d, goals, c).changed).toEqual(['tickets']);
  });

  it('never sends the tick for another channel than the one that exists', () => {
    const d = make();
    d.channels.push({ id: '100000000000000003', name: 'other', problem: null });
    const c = initialChoices(d);
    c.welcome.fields.channel = { mode: 'pick', id: '100000000000000003', fix: true };
    expect(toPayload(d, new Set(['welcome']), c).items[0].fields.channel).toEqual({
      id: '100000000000000003',
    });
  });
});

describe('a role that is only for who may see a channel', () => {
  const gap = 'Everyone can see it.';
  const make = () =>
    data({
      channels: [{ id: '100000000000000002', name: 'logs', problem: null }],
      roles: [{ id: '200000000000000002', name: 'Support team', problem: null }],
      items: [
        item({
          fields: [
            field({
              match: null,
              unsafeMatch: { id: '100000000000000002', name: 'logs', gap },
              create: { name: 'server-log', kind: 'channel', private: true, existing: null },
            }),
            field({
              key: 'viewRole',
              kind: 'role',
              optional: true,
              viewer: true,
              viewerOnly: true,
              post: false,
              match: { id: '200000000000000002', name: 'Support team' },
              create: { name: 'Support team', kind: 'role' },
            }),
          ],
        }),
      ],
    });

  it('does nothing unless the channel is created or its permissions are changed, and is then not sent', () => {
    const d = make();
    const c = initialChoices(d);
    expect(viewerActive(d.items[0], c.welcome)).toBe(false);
    expect(toPayload(d, new Set(['welcome']), c).items[0].fields.viewRole).toEqual({});

    c.welcome.fields.channel = { mode: 'create', id: '', fix: false };
    expect(viewerActive(d.items[0], c.welcome)).toBe(true);
    expect(toPayload(d, new Set(['welcome']), c).items[0].fields.viewRole).toEqual({
      id: '200000000000000002',
    });
  });

  it('is used when the admin ticks the permission change of the channel that others can see', () => {
    const d = make();
    const c = initialChoices(d);
    c.welcome.fields.channel = { mode: 'pick', id: '100000000000000002', fix: true };
    expect(fixableChannel(d.items[0].fields[0], '100000000000000002')?.name).toBe('logs');
    expect(viewerActive(d.items[0], c.welcome)).toBe(true);
    expect(toPayload(d, new Set(['welcome']), c).items[0].fields.channel).toEqual({
      id: '100000000000000002',
      fix: true,
    });
    expect(reviewSummary(d, new Set(['welcome']), c).changed).toEqual(['logs']);
  });

  it('is not counted in the summary while it is not used', () => {
    const d = make();
    const c = initialChoices(d);
    c.welcome.fields.viewRole = { mode: 'create', id: '', fix: false };
    expect(reviewSummary(d, new Set(['welcome']), c).roles).toEqual([]);
  });
});

describe('links', () => {
  it('opens the mod-log channel in the server settings and a module on its own page', () => {
    expect(itemHref('modlog', 'G')).toBe('/guilds/G/settings');
    expect(itemHref('tickets', 'G')).toBe('/guilds/G/m/tickets');
  });
});
