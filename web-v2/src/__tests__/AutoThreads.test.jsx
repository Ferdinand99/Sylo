import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AutoThreads from '../moduleForms/AutoThreads.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
  getModuleLimits: vi.fn(),
}));
const { getModuleConfig, saveModuleConfig, getModuleLimits } = await import('../api.js');

const GUILD = '123456789012345678';
const CHANNEL = '555555555555555555';
const STAFF = '777777777777777777';

// What GET /api/v2/modules/limits answers for the module (src/modules/autoThreads.js, LIMITS).
const limits = {
  'auto-threads': {
    rules: { maxItems: 25 },
    'rules[].nameTemplate': { maxLength: 100 },
    'rules[].staffRoleIds': { maxItems: 25 },
    'rules[].firstMessage': { maxLength: 2000 },
    'rules[].slowmodeSeconds': { min: 0, max: 21600 },
  },
  _embed: {},
};

const rule = {
  id: 'r1',
  channelId: CHANNEL,
  nameTemplate: '{author}: {words}',
  archiveMinutes: 1440,
  onlyWithAttachments: false,
  onlyWithLinks: false,
  skipBots: true,
  skipStaff: false,
  staffRoleIds: [],
  firstMessage: '',
  slowmodeSeconds: 0,
};
const channels = [
  { id: CHANNEL, name: 'questions' },
  { id: '555555555555555556', name: 'announcements' },
];
const roles = [{ id: STAFF, name: 'Moderators' }];

beforeEach(() => {
  vi.resetAllMocks();
  resetModuleLimits();
  getModuleLimits.mockResolvedValue(limits);
  getModuleConfig.mockResolvedValue({ config: { rules: [rule] }, channels, roles });
});

describe('Auto threads form', () => {
  it('shows the saved rule with its channel, template and the limits from the server', async () => {
    renderAtGuild(<AutoThreads />, GUILD);

    expect(await screen.findByRole('heading', { name: 'Auto threads' })).toBeTruthy();
    expect(getModuleConfig).toHaveBeenCalledWith(GUILD, 'auto-threads');
    expect(screen.getByRole('option', { name: '#questions' }).selected).toBe(true);
    const template = screen.getByLabelText('Thread name');
    expect(template.value).toBe('{author}: {words}');
    await waitFor(() => expect(template.maxLength).toBe(100));
    expect(screen.getByLabelText(/First message in the thread/).maxLength).toBe(2000);
    const slowmode = screen.getByLabelText(/Slowmode in the thread/);
    expect(slowmode.max).toBe('21600');
    expect(slowmode.min).toBe('0');
  });

  it('offers only the channels the server sent (forums are left out there)', async () => {
    renderAtGuild(<AutoThreads />, GUILD);
    const picker = await screen.findByLabelText('Channel');
    const names = within(picker)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(names).toEqual(['— channel —', '#questions', '#announcements']);
  });

  it('previews the thread name from a sample post and follows the template', async () => {
    renderAtGuild(<AutoThreads />, GUILD);
    const preview = await screen.findByTestId('at-preview-0');
    const today = new Date().toISOString().slice(0, 10);
    expect(preview.textContent).toContain('Alex: Anyone up for a raid tonight?');

    fireEvent.change(screen.getByLabelText('Thread name'), { target: { value: '{date} {author}' } });
    expect(screen.getByTestId('at-preview-0').textContent).toContain(`${today} Alex`);

    fireEvent.change(screen.getByLabelText('Sample post for the previews'), {
      target: { value: '<@123456789012345678> **big** news today' },
    });
    fireEvent.change(screen.getByLabelText('Thread name'), { target: { value: '{words}' } });
    expect(screen.getByTestId('at-preview-0').textContent).toContain('big news today');

    fireEvent.change(screen.getByLabelText('Sample post for the previews'), { target: { value: '' } });
    expect(screen.getByTestId('at-preview-0').textContent).toContain('Alex (4/100)');
    expect(saveModuleConfig).not.toHaveBeenCalled();
  });

  it('cuts the preview at 100 characters', async () => {
    renderAtGuild(<AutoThreads />, GUILD);
    const preview = await screen.findByTestId('at-preview-0');
    fireEvent.change(screen.getByLabelText('Thread name'), { target: { value: 'x'.repeat(100) } });
    expect(preview.textContent).toContain('(100/100)');
  });

  it('offers the four archive times', async () => {
    renderAtGuild(<AutoThreads />, GUILD);
    const archive = await screen.findByLabelText('Archive after');
    expect(
      within(archive)
        .getAllByRole('option')
        .map((o) => o.value)
    ).toEqual(['60', '1440', '4320', '10080']);
    expect(archive.value).toBe('1440');
  });

  it('shows the staff role picker only while "Skip staff" is on', async () => {
    renderAtGuild(<AutoThreads />, GUILD);
    await screen.findByLabelText('Thread name');
    expect(screen.queryByText(/Staff roles/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Skip staff'));
    expect(screen.getByText(/Staff roles/)).toBeTruthy();
  });

  it('saves the edited rule in the shape the server expects', async () => {
    saveModuleConfig.mockResolvedValue({ config: { rules: [rule] } });
    renderAtGuild(<AutoThreads />, GUILD);
    await screen.findByLabelText('Thread name');
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Archive after'), { target: { value: '10080' } });
    fireEvent.click(screen.getByLabelText('Only posts with an attachment'));
    fireEvent.click(screen.getByLabelText('Skip bots and webhooks'));
    fireEvent.change(screen.getByLabelText(/First message in the thread/), {
      target: { value: 'Hi {author}' },
    });
    fireEvent.change(screen.getByLabelText(/Slowmode in the thread/), { target: { value: '30' } });

    const save = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(saveModuleConfig).toHaveBeenCalledTimes(1));
    expect(saveModuleConfig).toHaveBeenCalledWith(GUILD, 'auto-threads', {
      rules: [
        {
          id: 'r1',
          channelId: CHANNEL,
          nameTemplate: '{author}: {words}',
          archiveMinutes: 10080,
          onlyWithAttachments: true,
          onlyWithLinks: false,
          skipBots: false,
          skipStaff: false,
          staffRoleIds: [],
          firstMessage: 'Hi {author}',
          slowmodeSeconds: 30,
        },
      ],
    });
  });

  it('adds a rule with the defaults and removes one', async () => {
    saveModuleConfig.mockResolvedValue({ config: { rules: [] } });
    renderAtGuild(<AutoThreads />, GUILD);
    await screen.findByLabelText('Thread name');
    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }));
    expect(screen.getAllByLabelText('Thread name')).toHaveLength(2);
    const added = screen.getAllByLabelText('Thread name')[1];
    expect(added.value).toBe('{words}');
    expect(screen.getAllByLabelText('Archive after')[1].value).toBe('1440');

    fireEvent.click(screen.getAllByRole('button', { name: 'remove rule' })[0]);
    expect(screen.getAllByLabelText('Thread name')).toHaveLength(1);
    expect(screen.getByLabelText('Skip bots and webhooks').checked).toBe(true);
  });

  it('stops adding rules at the limit and still works when the limits cannot be loaded', async () => {
    getModuleLimits.mockResolvedValue({
      ...limits,
      'auto-threads': { ...limits['auto-threads'], rules: { maxItems: 1 } },
    });
    renderAtGuild(<AutoThreads />, GUILD);
    await screen.findByLabelText('Thread name');
    await waitFor(() => expect(screen.getByRole('button', { name: '+ Add rule' }).disabled).toBe(true));
  });

  it('renders and edits without limits', async () => {
    getModuleLimits.mockRejectedValue(new Error('offline'));
    renderAtGuild(<AutoThreads />, GUILD);
    const template = await screen.findByLabelText('Thread name');
    expect(template.hasAttribute('maxlength')).toBe(false);
    expect(screen.getByRole('button', { name: '+ Add rule' }).disabled).toBe(false);
  });
});
