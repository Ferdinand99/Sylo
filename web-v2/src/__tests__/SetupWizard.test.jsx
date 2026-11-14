import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SetupWizard from '../pages/SetupWizard.jsx';
import SetupOffer from '../components/SetupOffer.jsx';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getSetupSuggestion: vi.fn(),
  applySetup: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../moduleForms/index.js', () => ({ v2Href: (card, guildId) => `/guilds/${guildId}/m/${card.id}` }));
vi.mock('../OverviewContext.jsx', () => ({ useOverview: vi.fn() }));
vi.mock('../setupAccess.js', () => ({ useCanSetUp: vi.fn() }));
const api = await import('../api.js');
const { notify } = await import('../notify.js');
const { useOverview } = await import('../OverviewContext.jsx');
const { useCanSetUp } = await import('../setupAccess.js');

const GUILD = '123456789012345678';
const GENERAL = '100000000000000001';

const field = (over) => ({
  key: 'joinChannel',
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
const suggestion = (over = {}) => ({
  platform: 'discord',
  inspected: { channels: 12, roles: 4, members: 340 },
  botCan: { createChannels: true, createRoles: true },
  goals: [
    { id: 'welcome', label: 'Welcome new members', description: 'Greet people.' },
    { id: 'moderation', label: 'Moderation and logging', description: 'Logs.' },
  ],
  channels: [{ id: GENERAL, name: 'general', problem: null }],
  roles: [],
  items: [
    {
      id: 'welcome',
      goal: 'welcome',
      name: 'Welcome & leave',
      does: ['Posts a welcome message.'],
      configured: false,
      enabled: false,
      blocked: [],
      warnings: [],
      fields: [field()],
    },
    {
      id: 'modlog',
      goal: 'moderation',
      name: 'Mod-log channel',
      does: ['Every moderation action posts an embed.'],
      configured: true,
      enabled: null,
      blocked: [],
      warnings: [],
      fields: [
        field({
          key: 'channelId',
          label: 'Mod-log channel',
          match: { id: GENERAL, name: 'general' },
          create: { name: 'mod-log', kind: 'channel', private: true, readOnly: false },
        }),
      ],
    },
  ],
  ...over,
});

const reload = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  useOverview.mockReturnValue({ reload });
  useCanSetUp.mockReturnValue(true);
  api.getSetupSuggestion.mockResolvedValue(suggestion());
  api.applySetup.mockResolvedValue({
    results: [
      {
        id: 'welcome',
        name: 'Welcome & leave',
        status: 'applied',
        message: 'Set up. Created #welcome.',
        warnings: [],
        created: [],
      },
    ],
  });
});

async function toReview() {
  renderAtGuild(<SetupWizard />, GUILD);
  fireEvent.click(await screen.findByRole('button', { name: 'Choose goals' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Welcome new members/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  await screen.findByRole('heading', { name: 'Review' });
}

describe('SetupWizard', () => {
  it('first says what Sylo found and what it may do, and creates nothing yet', async () => {
    renderAtGuild(<SetupWizard />, GUILD);
    expect(await screen.findByText(/12 text channels, 4 roles and 340 members/)).toBeTruthy();
    expect(screen.getByText('Sylo can create channels here.')).toBeTruthy();
    expect(screen.getByText(/1 of 2 things are already set up/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Skip, I'll set things up myself/ }).getAttribute('href')).toBe(
      `/guilds/${GUILD}`
    );
    expect(api.applySetup).not.toHaveBeenCalled();
  });

  it('says plainly when Sylo may not create channels, or cannot tell', async () => {
    api.getSetupSuggestion.mockResolvedValue(
      suggestion({ botCan: { createChannels: false, createRoles: null } })
    );
    renderAtGuild(<SetupWizard />, GUILD);
    expect(await screen.findByText(/needs the Manage Channels permission/)).toBeTruthy();
    expect(screen.getByText(/can't tell whether it may create roles/)).toBeTruthy();
  });

  it('starts with no goal ticked, and marks a goal that is done "Already set up"', async () => {
    renderAtGuild(<SetupWizard />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose goals' }));
    expect(screen.getByRole('checkbox', { name: /Welcome new members/ }).checked).toBe(false);
    expect(screen.getByRole('checkbox', { name: /Moderation and logging/ }).checked).toBe(false);
    expect(screen.getByRole('button', { name: 'Review' }).disabled).toBe(true);
    expect(screen.getByText('Already set up')).toBeTruthy();
  });

  it('moves focus to the heading of the new step when the step changes', async () => {
    renderAtGuild(<SetupWizard />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose goals' }));
    const goals = screen.getByRole('heading', { name: 'What do you want Sylo to do here?' });
    await waitFor(() => expect(document.activeElement).toBe(goals));
    fireEvent.click(screen.getByRole('checkbox', { name: /Welcome new members/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const review = await screen.findByRole('heading', { name: 'Review' });
    await waitFor(() => expect(document.activeElement).toBe(review));
  });

  it('does not apply an item with no channel, and a ticked Create fills it; nothing is created by default', async () => {
    await toReview();
    expect(screen.getByRole('button', { name: 'Apply' }).disabled).toBe(true);
    expect(screen.getByText('Welcome channel: pick one, or tick Create.')).toBeTruthy();
    const create = screen.getByRole('checkbox', { name: /Create #welcome/ });
    expect(create.checked).toBe(false);
    expect(screen.getByText(/Members see it like your other channels/)).toBeTruthy();

    fireEvent.click(create);
    expect(screen.getByRole('button', { name: 'Apply' }).disabled).toBe(false);
    expect(screen.getByText(/Applying will set up 1 item, and create #welcome/)).toBeTruthy();
  });

  it('can tick every missing Create at once, as one explicit click', async () => {
    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Tick Create for all of them' }));
    expect(screen.getByRole('checkbox', { name: /Create #welcome/ }).checked).toBe(true);
    expect(screen.queryByRole('button', { name: 'Tick Create for all of them' })).toBeNull();
  });

  it('sends only what is ticked, shows the result per item and tells the overview to read again', async () => {
    await toReview();
    fireEvent.click(screen.getByRole('checkbox', { name: /Create #welcome/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByRole('heading', { name: 'Done' });
    expect(api.applySetup).toHaveBeenCalledWith(GUILD, {
      items: [{ id: 'welcome', replace: false, fields: { joinChannel: { create: true } } }],
    });
    expect(screen.getByText('Set up. Created #welcome.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open its settings' }).getAttribute('href')).toBe(
      `/guilds/${GUILD}/m/welcome`
    );
    expect(reload).toHaveBeenCalled();
  });

  it('shows a failed item with its reason and lets the admin review again', async () => {
    api.applySetup.mockResolvedValue({
      results: [
        {
          id: 'welcome',
          name: 'Welcome & leave',
          status: 'failed',
          message: 'Sylo needs the Manage Channels permission to create a channel.',
          warnings: [],
          created: [],
        },
      ],
    });
    await toReview();
    fireEvent.click(screen.getByRole('checkbox', { name: /Create #welcome/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Some things were not set up')).toBeTruthy();
    expect(screen.getByText('Not set up')).toBeTruthy();
    expect(screen.getByText(/needs the Manage Channels permission to create a channel/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review again' }));
    await screen.findByRole('heading', { name: 'Review' });
  });

  it('puts an item that is already set up behind a tick, with the replace sentence', async () => {
    renderAtGuild(<SetupWizard />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose goals' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Welcome new members/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Moderation and logging/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const head = await screen.findByRole('checkbox', { name: /Replace Mod-log channel/ });
    expect(head.checked).toBe(false);
    expect(screen.getByText(/so it is left alone/)).toBeTruthy();
    fireEvent.click(head);
    fireEvent.click(screen.getByRole('checkbox', { name: /Create #welcome/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.applySetup).toHaveBeenCalled());
    expect(api.applySetup.mock.calls[0][1].items.map((i) => [i.id, i.replace])).toEqual([
      ['welcome', false],
      ['modlog', true],
    ]);
  });

  it('shows the error of a refused apply as a toast and stays on the review', async () => {
    api.applySetup.mockRejectedValue(new Error('The setup wizard ran several times just now.'));
    await toReview();
    fireEvent.click(screen.getByRole('checkbox', { name: /Create #welcome/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('The setup wizard ran several times just now.'));
    expect(screen.getByRole('heading', { name: 'Review' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply' }).disabled).toBe(false);
  });

  it('works the same on Fluxer, in the page, with no dialog', async () => {
    api.getSetupSuggestion.mockResolvedValue(suggestion({ platform: 'fluxer' }));
    await toReview();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/On Fluxer the wizard works the same way/)).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /Create #welcome/ })).toBeTruthy();
  });
});

describe('SetupWizard: staff-only channels and the staff role', () => {
  const gap = 'Members with the Verified role can see it.';
  const withUnsafe = () =>
    suggestion({
      channels: [{ id: GENERAL, name: 'logs', problem: null }],
      roles: [{ id: '200000000000000002', name: 'Support team', problem: null }],
      items: [
        {
          ...suggestion().items[0],
          fields: [
            field({
              match: null,
              unsafeMatch: { id: GENERAL, name: 'logs', gap },
              create: { name: 'server-log', kind: 'channel', private: true, readOnly: false, existing: null },
            }),
            field({
              key: 'viewRole',
              kind: 'role',
              label: 'Role that can see this channel',
              optional: true,
              post: false,
              viewer: true,
              viewerOnly: true,
              match: { id: '200000000000000002', name: 'Support team' },
              create: { name: 'Support team', kind: 'role' },
            }),
          ],
        },
      ],
    });

  it('does not pick a channel that others can see, says why, and offers the permission change when it is picked', async () => {
    api.getSetupSuggestion.mockResolvedValue(withUnsafe());
    await toReview();
    expect(screen.getByText(/logs exists, but members with the Verified role can see it\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply' }).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Welcome channel'), { target: { value: GENERAL } });
    const fix = screen.getByRole('checkbox', { name: /Change its permissions to private/ });
    expect(fix.checked).toBe(false);
    fireEvent.click(fix);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.applySetup).toHaveBeenCalled());
    const fields = api.applySetup.mock.calls[0][1].items[0].fields;
    expect(fields.joinChannel).toEqual({ id: GENERAL, fix: true });
    expect(fields.viewRole).toEqual({ id: '200000000000000002' });
  });

  it('says the staff role is not used while the channel is neither created nor changed, and sends nothing for it', async () => {
    api.getSetupSuggestion.mockResolvedValue(withUnsafe());
    await toReview();
    expect(
      screen.getByText(/Not used now\. This role gets access when Sylo creates the channel/)
    ).toBeTruthy();
    expect(screen.getByLabelText(/Role that can see this channel/).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /Create #server-log/ }));
    expect(screen.queryByText(/Not used now/)).toBeNull();
    expect(screen.getByLabelText(/Role that can see this channel/).disabled).toBe(false);
  });
});

describe('SetupWizard: a channel that already has the wanted name', () => {
  const existing = { id: GENERAL, name: 'general', gap: 'Everyone can see it.' };
  const withExisting = () =>
    suggestion({
      items: [
        {
          ...suggestion().items[0],
          fields: [
            field({
              match: { id: GENERAL, name: 'general' },
              create: { name: 'general', kind: 'channel', private: true, readOnly: false, existing },
            }),
          ],
        },
      ],
    });

  it('is not silently reused: it says how it differs, and changes its permissions only when ticked', async () => {
    api.getSetupSuggestion.mockResolvedValue(withExisting());
    await toReview();
    expect(screen.getByText(/#general already exists. Everyone can see it./)).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Create #general/ })).toBeNull();
    const fix = screen.getByRole('checkbox', { name: /Change its permissions to private/ });
    expect(fix.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.applySetup).toHaveBeenCalled());
    expect(api.applySetup.mock.calls[0][1].items[0].fields.joinChannel).toEqual({ id: GENERAL });
  });

  it('sends the tick, and the summary names the channel it will change', async () => {
    api.getSetupSuggestion.mockResolvedValue(withExisting());
    await toReview();
    fireEvent.click(screen.getByRole('checkbox', { name: /Change its permissions to private/ }));
    expect(screen.getByText(/change the permissions of #general/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.applySetup).toHaveBeenCalled());
    expect(api.applySetup.mock.calls[0][1].items[0].fields.joinChannel).toEqual({ id: GENERAL, fix: true });
  });

  it('shows what was made before a step failed, as the server wrote it', async () => {
    api.applySetup.mockResolvedValue({
      results: [
        {
          id: 'welcome',
          name: 'Welcome & leave',
          status: 'failed',
          message:
            'Could not save this: Missing Permissions Before it stopped, Sylo created Support team. That was left in place; remove it in your server if you do not want it.',
          warnings: [],
          created: [{ kind: 'role', name: 'Support team', id: '1' }],
          reused: [],
          changed: [],
        },
      ],
    });
    await toReview();
    fireEvent.click(screen.getByRole('checkbox', { name: /Create #welcome/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText(/Before it stopped, Sylo created Support team/)).toBeTruthy();
  });
});

describe('SetupOffer', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // storage is optional
    }
  });

  it('works when the browser blocks storage: it shows, and "Not now" hides it for this visit', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      renderAtGuild(<SetupOffer guildId={GUILD} />, GUILD);
      expect(screen.getByRole('link', { name: 'Set up Sylo' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
      expect(screen.queryByRole('link', { name: 'Set up Sylo' })).toBeNull();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('is not shown to someone who may not set the server up', () => {
    useCanSetUp.mockReturnValue(false);
    renderAtGuild(<SetupOffer guildId={GUILD} />, GUILD);
    expect(screen.queryByRole('link', { name: 'Set up Sylo' })).toBeNull();
  });

  it('links to the wizard, and "Not now" hides it for this server only', () => {
    const first = renderAtGuild(<SetupOffer guildId={GUILD} />, GUILD);
    expect(screen.getByRole('link', { name: 'Set up Sylo' }).getAttribute('href')).toBe(
      `/guilds/${GUILD}/setup`
    );
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('link', { name: 'Set up Sylo' })).toBeNull();
    first.unmount();
    const again = renderAtGuild(<SetupOffer guildId={GUILD} />, GUILD);
    expect(screen.queryByRole('link', { name: 'Set up Sylo' })).toBeNull();
    again.unmount();
    renderAtGuild(<SetupOffer guildId="223456789012345678" />, '223456789012345678');
    expect(screen.getByRole('link', { name: 'Set up Sylo' })).toBeTruthy();
  });
});
