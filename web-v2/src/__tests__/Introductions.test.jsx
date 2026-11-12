import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Introductions from '../moduleForms/Introductions.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
  getModuleLimits: vi.fn(),
  publishIntroPrompt: vi.fn(),
  unpublishIntroPrompt: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const { getModuleConfig, saveModuleConfig, getModuleLimits, publishIntroPrompt, unpublishIntroPrompt } =
  await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');
const { notify } = await import('../notify.js');

const GUILD = '123456789012345678';
const CHANNEL = '222222222222222222';
const ROLE_A = '555555555555555551';
const ROLE_B = '555555555555555552';

// What GET /api/v2/modules/limits answers for introductions (src/modules/introductions.js, LIMITS).
const limits = {
  introductions: {
    questions: { maxItems: 8 },
    'questions[].label': { maxLength: 45 },
    'questions[].prompt': { maxLength: 300 },
    'questions[].maxLength': { min: 1, max: 1024 },
    roleGroups: { maxItems: 10 },
    'roleGroups[].name': { maxLength: 45 },
    'roleGroups[].roleIds': { maxItems: 25 },
    description: { maxLength: 1000 },
    footer: { maxLength: 200 },
    promptText: { maxLength: 500 },
  },
  _embed: {},
};

const question = (over = {}) => ({
  id: 'about',
  label: 'About me',
  prompt: 'Tell us about you.',
  required: true,
  maxLength: 500,
  inline: false,
  ...over,
});

const baseConfig = (over = {}) => ({
  channelId: CHANNEL,
  questions: [question(), question({ id: 'likes', label: 'Likes', required: false, maxLength: 300 })],
  roleGroups: [],
  showRoles: false,
  colorMode: 'fixed',
  color: '',
  description: '',
  footer: '',
  deleteOnLeave: true,
  promptText: '',
  promptChannelId: '',
  promptMessageId: '',
  ...over,
});

const answer = (config = baseConfig(), over = {}) => ({
  config,
  channels: [
    { id: CHANNEL, name: 'introductions' },
    { id: '333333333333333333', name: 'general' },
  ],
  roles: [
    { id: ROLE_A, name: 'Norway' },
    { id: ROLE_B, name: 'Sweden' },
  ],
  placeholders: ['{user}', '{user.name}', '{server}', '{rolegroup:<name>}'],
  introductions: 3,
  ...over,
});

const saveButton = () => screen.getAllByRole('button', { name: /Save/ })[0];

beforeEach(() => {
  vi.resetAllMocks();
  confirmDialog.mockResolvedValue(true);
  resetModuleLimits();
  getModuleLimits.mockResolvedValue(limits);
  getModuleConfig.mockResolvedValue(answer());
  saveModuleConfig.mockImplementation(async (_guild, _id, body) => ({
    config: { ...baseConfig(), ...body },
  }));
});

describe('Introductions form', () => {
  it('shows the channel, the questions in order, and how many members have a card', async () => {
    renderAtGuild(<Introductions />, GUILD);
    expect(await screen.findByRole('heading', { name: 'Introductions' })).toBeTruthy();
    expect(getModuleConfig).toHaveBeenCalledWith(GUILD, 'introductions');
    expect(screen.getByLabelText('Introductions channel').value).toBe(CHANNEL);
    const labels = screen.getAllByLabelText('Label on the card').map((el) => el.value);
    expect(labels).toEqual(['About me', 'Likes']);
    expect(screen.getByText('3 members have an introduction.')).toBeTruthy();
  });

  it('takes the field limits from the server', async () => {
    renderAtGuild(<Introductions />, GUILD);
    await screen.findByRole('heading', { name: 'Introductions' });
    await waitFor(() => expect(screen.getAllByLabelText('Label on the card')[0].maxLength).toBe(45));
    expect(screen.getAllByLabelText('Question asked in DM')[0].maxLength).toBe(300);
    const longest = screen.getAllByLabelText('Longest answer (characters)')[0];
    expect(longest.min).toBe('1');
    expect(longest.max).toBe('1024');
    expect(screen.getByLabelText('Description (optional)').maxLength).toBe(1000);
  });

  it('adds a question without an id (the server gives it one) and saves the cleaned body', async () => {
    renderAtGuild(<Introductions />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add question' }));
    const labels = screen.getAllByLabelText('Label on the card');
    expect(labels).toHaveLength(3);
    fireEvent.change(labels[2], { target: { value: 'Favourite game' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveModuleConfig).toHaveBeenCalledTimes(1));
    const body = saveModuleConfig.mock.calls[0][2];
    expect(saveModuleConfig.mock.calls[0].slice(0, 2)).toEqual([GUILD, 'introductions']);
    expect(body.questions.map((q) => q.label)).toEqual(['About me', 'Likes', 'Favourite game']);
    expect(body.questions[2]).toEqual({
      id: '',
      label: 'Favourite game',
      prompt: '',
      required: false,
      maxLength: 300,
      inline: false,
    });
    expect(body.questions[0].id).toBe('about');
    expect(body.questions.every((q) => !('key' in q))).toBe(true);
    expect(body).toMatchObject({ channelId: CHANNEL, colorMode: 'fixed', color: '', deleteOnLeave: true });
  });

  it('stops at 8 questions', async () => {
    getModuleConfig.mockResolvedValue(
      answer(
        baseConfig({
          questions: Array.from({ length: 8 }, (_, i) => question({ id: `q${i}`, label: `Q${i}` })),
        })
      )
    );
    renderAtGuild(<Introductions />, GUILD);
    await screen.findByRole('button', { name: '+ Add question' });
    // the limit arrives with the module limits, a moment after the form
    await waitFor(() => expect(screen.getByRole('button', { name: '+ Add question' }).disabled).toBe(true));
  });

  it('removes and reorders questions', async () => {
    renderAtGuild(<Introductions />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Move question 2 up' }));
    expect(screen.getAllByLabelText('Label on the card').map((el) => el.value)).toEqual([
      'Likes',
      'About me',
    ]);
    expect(screen.getByRole('button', { name: 'Move question 1 up' }).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    expect(screen.getAllByLabelText('Label on the card').map((el) => el.value)).toEqual(['About me']);
  });

  it('builds a role group and offers its placeholder', async () => {
    renderAtGuild(<Introductions />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add role group' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Country' } });
    const group = screen.getByLabelText('Name').closest('.v2-rule-card');
    fireEvent.change(within(group).getByLabelText('Add a role'), { target: { value: ROLE_A } });
    fireEvent.click(within(group).getByLabelText('Hide the field when the member has none of these roles'));
    expect(screen.getByRole('button', { name: 'Insert {rolegroup:Country}' })).toBeTruthy();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveModuleConfig).toHaveBeenCalled());
    expect(saveModuleConfig.mock.calls[0][2].roleGroups).toEqual([
      { name: 'Country', roleIds: [ROLE_A], hideWhenEmpty: true },
    ]);
  });

  it('the colour choice becomes colorMode and color', async () => {
    renderAtGuild(<Introductions />, GUILD);
    const select = await screen.findByLabelText('Colour');
    expect(select.value).toBe('default');
    fireEvent.change(select, { target: { value: 'role' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveModuleConfig).toHaveBeenCalledTimes(1));
    expect(saveModuleConfig.mock.calls[0][2]).toMatchObject({ colorMode: 'role', color: '' });
  });

  it('a saved custom colour is shown as custom and sent back', async () => {
    getModuleConfig.mockResolvedValue(answer(baseConfig({ color: '#112233' })));
    renderAtGuild(<Introductions />, GUILD);
    expect((await screen.findByLabelText('Colour')).value).toBe('custom');
    fireEvent.click(
      screen.getByLabelText(
        "Show the member's other roles (top 10, without the roles already shown in a group)"
      )
    );
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveModuleConfig).toHaveBeenCalled());
    expect(saveModuleConfig.mock.calls[0][2]).toMatchObject({
      colorMode: 'fixed',
      color: '#112233',
      showRoles: true,
    });
  });

  it('the prompt message: publish needs a channel, then it can be updated and removed', async () => {
    getModuleConfig.mockResolvedValue(answer(baseConfig({ channelId: '' })));
    publishIntroPrompt.mockResolvedValue({ config: baseConfig() });
    unpublishIntroPrompt.mockResolvedValue({ config: baseConfig() });
    renderAtGuild(<Introductions />, GUILD);
    const publish = await screen.findByRole('button', { name: 'Publish prompt message' });
    expect(publish.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Introductions channel'), { target: { value: CHANNEL } });
    fireEvent.change(screen.getByLabelText('Message text'), { target: { value: 'Say hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish prompt message' }));
    await waitFor(() =>
      expect(publishIntroPrompt).toHaveBeenCalledWith(GUILD, { channelId: CHANNEL, promptText: 'Say hi' })
    );
    expect(await screen.findByRole('button', { name: 'Update prompt message' })).toBeTruthy();
    expect(notify).toHaveBeenCalledWith('Prompt message published and pinned.', 'info');

    fireEvent.click(screen.getByRole('button', { name: 'Remove prompt message' }));
    await waitFor(() => expect(unpublishIntroPrompt).toHaveBeenCalledWith(GUILD));
    expect(await screen.findByRole('button', { name: 'Publish prompt message' })).toBeTruthy();
  });

  it('a prompt that is already published starts as "Update"', async () => {
    getModuleConfig.mockResolvedValue(
      answer(baseConfig({ promptChannelId: CHANNEL, promptMessageId: '800000000000000001' }))
    );
    renderAtGuild(<Introductions />, GUILD);
    expect(await screen.findByRole('button', { name: 'Update prompt message' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove prompt message' })).toBeTruthy();
  });

  it('shows the server error when publishing fails', async () => {
    publishIntroPrompt.mockRejectedValue(new Error('Sylo needs View Channel in that channel.'));
    renderAtGuild(<Introductions />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish prompt message' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Sylo needs View Channel in that channel.'));
  });
});
