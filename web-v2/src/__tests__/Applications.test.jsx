import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Applications from '../moduleForms/Applications.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
  getModuleLimits: vi.fn(),
  saveApplicationForm: vi.fn(),
  deleteApplicationForm: vi.fn(),
  publishApplicationsPanel: vi.fn(),
  unpublishApplicationsPanel: vi.fn(),
  getApplicationSubmissions: vi.fn(),
  applicationsExportUrl: (guild, { formId, status, format }) =>
    `/api/v2/guilds/${guild}/applications/export?formId=${formId}&status=${status}&format=${format}`,
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const api = await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');
const { notify } = await import('../notify.js');

const GUILD = '123456789012345678';
const CHANNEL = '222222222222222222';
const ROLE_A = '555555555555555551';
const ROLE_B = '555555555555555552';

// What GET /api/v2/modules/limits answers for applications (src/modules/lib/applicationsForm.js, LIMITS).
const limits = {
  applications: {
    name: { maxLength: 60 },
    description: { maxLength: 500 },
    timeoutMinutes: { min: 1, max: 1440 },
    questions: { maxItems: 25 },
    'questions[].label': { maxLength: 100 },
    'questions[].help': { maxLength: 300 },
    'questions[].minLength': { min: 0, max: 4000 },
    'questions[].maxLength': { min: 1, max: 4000 },
    'questions[].options': { maxItems: 10 },
    'questions[].options[].label': { maxLength: 80 },
    minAccountDays: { min: 0, max: 3650 },
    minServerDays: { min: 0, max: 3650 },
    cooldownHours: { min: 0, max: 8760 },
    'messages.start': { maxLength: 1000 },
    'messages.completed': { maxLength: 1000 },
    'messages.accepted': { maxLength: 1000 },
    'messages.denied': { maxLength: 1000 },
    retentionDays: { min: 7, max: 3650 },
    panelText: { maxLength: 500 },
  },
  _embed: {},
};

const question = (over = {}) => ({
  id: 'q1',
  type: 'text',
  label: 'Why?',
  help: '',
  required: true,
  long: false,
  minLength: 0,
  maxLength: 300,
  options: [],
  multiple: false,
  minChoices: 0,
  maxChoices: 1,
  grant: 'never',
  ...over,
});

const form = (over = {}) => ({
  id: 3,
  name: 'Staff',
  description: 'Join the team',
  enabled: true,
  fillMode: 'both',
  timeoutMinutes: 30,
  questions: [
    question(),
    question({
      id: 'q2',
      type: 'choice',
      label: 'Colour',
      options: [
        { id: 'red', label: 'Red' },
        { id: 'blue', label: 'Blue' },
      ],
    }),
  ],
  requiredRoleIds: [],
  requiredRolesMode: 'all',
  restrictedRoleIds: [],
  restrictedRolesMode: 'any',
  minAccountDays: 0,
  minServerDays: 0,
  cooldownHours: 0,
  pendingChannelId: CHANNEL,
  acceptedChannelId: '',
  deniedChannelId: '',
  decidedPost: 'move',
  pingRoleIds: [],
  managerRoleIds: [],
  staffThread: false,
  pendingRoleId: '',
  removeOnSubmitRoleIds: [],
  acceptAddRoleIds: [],
  acceptRemoveRoleIds: [],
  denyAddRoleIds: [],
  denyRemoveRoleIds: [],
  onLeave: 'keep',
  messages: { start: 'Hello', completed: 'Thanks', accepted: 'Yay', denied: 'Sorry' },
  version: 1700000000000,
  createdAt: 1700000000000,
  problems: { setup: null, roles: null },
  ...over,
});

const answer = (over = {}) => ({
  config: { retentionDays: 180, panelChannelId: '', panelMessageId: '', panelText: '' },
  forms: [
    form(),
    form({
      id: 4,
      name: 'Moderator',
      enabled: false,
      fillMode: 'discord',
      problems: { setup: 'No channel is set for new applications.', roles: null },
    }),
  ],
  maxForms: 10,
  shortTextMax: 1024,
  defaultMessages: { start: 'S', completed: 'C', accepted: 'A', denied: 'D' },
  defaultPanelText: 'Apply here!',
  placeholders: ['{user}', '{server}', '{form}', '{reason}'],
  channels: [
    { id: CHANNEL, name: 'applications' },
    { id: '333333333333333333', name: 'general' },
  ],
  roles: [
    { id: ROLE_A, name: 'Reviewer' },
    { id: ROLE_B, name: 'Member' },
  ],
  pending: 2,
  webAddress: 'https://sylo.example/apply/123/<form>',
  threads: true,
  ...over,
});

const labelsOfQuestions = () => screen.getAllByLabelText('Question').map((el) => el.value);

beforeEach(() => {
  vi.resetAllMocks();
  confirmDialog.mockResolvedValue(true);
  resetModuleLimits();
  api.getModuleLimits.mockResolvedValue(limits);
  api.getModuleConfig.mockResolvedValue(answer());
  api.saveApplicationForm.mockImplementation(async (_g, id, body) => ({
    form: form({ ...body, id: id ?? 9 }),
  }));
  api.getApplicationSubmissions.mockResolvedValue({ submissions: [], total: 0, page: 1, pageSize: 25 });
});

const renderPage = () => renderAtGuild(<Applications />, GUILD);
const cardOf = (label) =>
  screen
    .getAllByLabelText('Question')
    .find((el) => el.value === label)
    .closest('.v2-rule-card');

describe('Applications form', () => {
  it('lists the forms with their state and what is missing, and counts the waiting applications on the tab', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Applications' })).toBeTruthy();
    expect(api.getModuleConfig).toHaveBeenCalledWith(GUILD, 'applications');
    expect(screen.getByText('Staff')).toBeTruthy();
    expect(screen.getByText('Moderator')).toBeTruthy();
    expect(screen.getByText(/Not ready: No channel is set/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Applications \(2\)/ })).toBeTruthy();
  });

  it('the new form button stops at the most forms a server may have', async () => {
    api.getModuleConfig.mockResolvedValue(answer({ maxForms: 2 }));
    renderPage();
    const button = await screen.findByRole('button', { name: 'New form' });
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/at most 2 forms/)).toBeTruthy();
  });

  it('opens a form with its questions in order, and takes the field limits from the server', async () => {
    renderPage();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);
    expect(await screen.findByTestId('application-form-editor')).toBeTruthy();
    expect(labelsOfQuestions()).toEqual(['Why?', 'Colour']);
    expect(screen.getByLabelText('Name').maxLength).toBe(60);
    expect(screen.getByLabelText('Description (optional)').maxLength).toBe(500);
    expect(screen.getAllByLabelText('Question')[0].maxLength).toBe(100);
    expect(screen.getByLabelText('Time to answer in DM (minutes)').max).toBe('1440');
    expect(screen.getByLabelText('Option 1').maxLength).toBe(80);
  });

  it("moves, adds and removes questions, and saves them in that order without the editor's own keys", async () => {
    renderPage();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);
    await screen.findByTestId('application-form-editor');
    fireEvent.click(screen.getByLabelText('Move question 1 down'));
    expect(labelsOfQuestions()).toEqual(['Colour', 'Why?']);
    expect(screen.getByLabelText('Move question 1 up').disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '+ Add question' }));
    fireEvent.change(screen.getAllByLabelText('Question')[2], { target: { value: 'Over 18?' } });
    fireEvent.change(screen.getAllByLabelText('Type')[2], { target: { value: 'yesno' } });
    fireEvent.click(within(cardOf('Why?')).getAllByRole('button', { name: 'Remove' })[0]);
    expect(labelsOfQuestions()).toEqual(['Colour', 'Over 18?']);

    fireEvent.click(screen.getByRole('button', { name: 'Save form' }));
    await waitFor(() => expect(api.saveApplicationForm).toHaveBeenCalled());
    const [guild, id, body] = api.saveApplicationForm.mock.calls[0];
    expect([guild, id]).toEqual([GUILD, 3]);
    expect(body.questions.map((q) => [q.id, q.label, q.type])).toEqual([
      ['q2', 'Colour', 'choice'],
      ['', 'Over 18?', 'yesno'],
    ]);
    expect(JSON.stringify(body)).not.toMatch(/"key"/);
    expect(body).not.toHaveProperty('version');
    expect(body).not.toHaveProperty('problems');
    expect(body.questions[0].options).toEqual([
      { id: 'red', label: 'Red' },
      { id: 'blue', label: 'Blue' },
    ]);
    expect(notify).toHaveBeenCalledWith('Form saved.', 'info');
  });

  it('shows the settings of the question type: a text length, options for a choice, roles for a role question', async () => {
    renderPage();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);
    await screen.findByTestId('application-form-editor');
    expect(screen.getByLabelText('Longest answer (characters)')).toBeTruthy();
    fireEvent.change(screen.getAllByLabelText('Type')[0], { target: { value: 'role' } });
    expect(screen.getByLabelText('Give the chosen roles')).toBeTruthy();
    expect(screen.queryByLabelText('Longest answer (characters)')).toBeNull();
    fireEvent.change(
      screen.getByLabelText('Roles to choose from').closest('.v2-field').querySelector('select'),
      {
        target: { value: ROLE_A },
      }
    );
    fireEvent.change(screen.getByLabelText('Give the chosen roles'), { target: { value: 'accept' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save form' }));
    await waitFor(() => expect(api.saveApplicationForm).toHaveBeenCalled());
    const q = api.saveApplicationForm.mock.calls[0][2].questions[0];
    expect([q.type, q.grant]).toEqual(['role', 'accept']);
    expect(q.options.map((o) => o.id)).toEqual([ROLE_A]);
  });

  it('previews the form as a member sees it, and sends nothing from the preview', async () => {
    renderPage();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);
    await screen.findByTestId('application-form-editor');
    fireEvent.click(screen.getByRole('button', { name: 'Preview the form' }));
    const preview = screen.getByLabelText('Preview of the form');
    expect(within(preview).getByText('Join the team')).toBeTruthy();
    expect(within(preview).getByLabelText('Blue')).toBeTruthy();
    fireEvent.click(within(preview).getByLabelText('Blue'));
    expect(api.saveApplicationForm).not.toHaveBeenCalled();
    expect(within(preview).getByText(/nothing is sent/)).toBeTruthy();
  });

  it('creates a new form with the default texts, and deletes one after a confirmation', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New form' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Events team' } });
    expect(screen.getByLabelText('When accepted').value).toBe('A');
    fireEvent.click(screen.getByRole('button', { name: 'Create form' }));
    await waitFor(() => expect(api.saveApplicationForm).toHaveBeenCalled());
    expect(api.saveApplicationForm.mock.calls[0][1]).toBeNull();
    expect(api.saveApplicationForm.mock.calls[0][2].name).toBe('Events team');
    expect(api.saveApplicationForm.mock.calls[0][2].fillMode).toBe('both');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete form' }));
    await waitFor(() => expect(api.deleteApplicationForm).toHaveBeenCalledWith(GUILD, 9));
    expect(confirmDialog).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'New form' })).toBeTruthy();
  });

  it('the submissions tab lists applications with filters and offers the export of one form', async () => {
    api.getApplicationSubmissions.mockResolvedValue({
      submissions: [
        {
          id: 12,
          formId: 3,
          formName: 'Staff',
          userId: '700000000000000010',
          userName: 'mira',
          status: 'pending',
          source: 'web',
          createdAt: 1700000000000,
          rolesPending: [],
          cleared: false,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: /Applications/ }));
    const link = await screen.findByRole('link', { name: /#12 · Staff/ });
    expect(link.getAttribute('href')).toBe(`/guilds/${GUILD}/applications/12`);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'denied' } });
    await waitFor(() =>
      expect(api.getApplicationSubmissions).toHaveBeenLastCalledWith(GUILD, {
        formId: '',
        status: 'denied',
        userId: '',
        page: 1,
      })
    );
    fireEvent.change(screen.getByLabelText('Form'), { target: { value: '4' } });
    await waitFor(() =>
      expect(api.getApplicationSubmissions).toHaveBeenLastCalledWith(GUILD, {
        formId: '4',
        status: 'denied',
        userId: '',
        page: 1,
      })
    );
    expect(screen.getByRole('link', { name: 'Download CSV' }).getAttribute('href')).toContain(
      '/applications/export?formId=3'
    );
    expect(screen.getByRole('link', { name: 'Download JSON' }).getAttribute('href')).toContain('format=json');
  });

  it('publishes, republishes and removes the panel message, and saves the retention', async () => {
    api.publishApplicationsPanel.mockImplementation(async (_g, body) => ({
      config: {
        retentionDays: 180,
        panelChannelId: body.channelId,
        panelMessageId: '999999999999999999',
        panelText: body.text,
      },
    }));
    api.unpublishApplicationsPanel.mockResolvedValue({
      config: { retentionDays: 180, panelChannelId: '', panelMessageId: '', panelText: '' },
    });
    api.saveModuleConfig.mockImplementation(async (_g, _id, body) => ({
      config: { panelChannelId: '', panelMessageId: '', ...body },
    }));
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Panel and settings' }));
    const publish = screen.getByRole('button', { name: 'Publish panel' });
    expect(publish.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: CHANNEL } });
    fireEvent.change(screen.getByLabelText('Message text'), { target: { value: 'Apply now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish panel' }));
    await waitFor(() =>
      expect(api.publishApplicationsPanel).toHaveBeenCalledWith(GUILD, {
        channelId: CHANNEL,
        text: 'Apply now',
      })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Republish panel' }));
    await waitFor(() => expect(api.publishApplicationsPanel).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Remove panel' }));
    await waitFor(() => expect(api.unpublishApplicationsPanel).toHaveBeenCalledWith(GUILD));
    expect(await screen.findByRole('button', { name: 'Publish panel' })).toBeTruthy();

    expect(screen.getByLabelText('Delete decided applications after (days)').min).toBe('7');
    fireEvent.change(screen.getByLabelText('Delete decided applications after (days)'), {
      target: { value: '30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(api.saveModuleConfig).toHaveBeenCalledWith(GUILD, 'applications', {
        retentionDays: 30,
        panelText: 'Apply now',
      })
    );
  });
});
