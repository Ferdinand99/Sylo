import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Automod, { paramSummary } from '../moduleForms/Automod.jsx';
import { PlatformContext, DISCORD } from '../platformContext.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
  getModuleLimits: vi.fn(),
  saveAutomodImmunity: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
const api = await import('../api.js');

const GUILD = '123456789012345678';
const ROLE_A = '555555555555555551';
const ROLE_B = '555555555555555552';

const config = (over = {}) => ({
  timeoutMinutes: 10,
  exemptChannels: [],
  exemptRoles: [ROLE_A],
  native: { enabled: false, links: false, words: false, presets: [] },
  rules: {
    links: { enabled: false, action: 'delete', allowed: [] },
    spam: { enabled: true, action: 'warn', max: 5, seconds: 5 },
    words: { enabled: true, action: 'delete', list: ['one', 'two'] },
  },
  ...over,
});

function respond(cfg = config()) {
  api.getModuleConfig.mockResolvedValue({
    config: cfg,
    channels: [],
    roles: [
      { id: ROLE_A, name: 'Mods' },
      { id: ROLE_B, name: 'Helpers' },
    ],
    automodRules: [
      ['links', 'Links', 'Block links'],
      ['spam', 'Spam', 'Block floods'],
      ['words', 'Bad words', 'Block listed words'],
    ],
    automodActions: ['delete', 'warn', 'timeout'],
    nativeMappable: [['links', 'Links']],
    presetKeys: ['profanity'],
    modlogChannelId: '',
  });
}

const renderForm = () =>
  renderAtGuild(
    <PlatformContext.Provider value={DISCORD}>
      <Automod />
    </PlatformContext.Provider>,
    GUILD
  );

beforeEach(() => {
  vi.resetAllMocks();
  resetModuleLimits();
  api.getModuleLimits.mockResolvedValue({ _embed: {} });
  respond();
});

describe('paramSummary', () => {
  it('reads the current values in a few words', () => {
    expect(paramSummary('spam', { max: 5, seconds: 10 })).toBe('max 5 messages per 10 s');
    expect(paramSummary('mentions', { max: 1 })).toBe('max 1 mention');
    expect(paramSummary('caps', { minLength: 8, percent: 70 })).toBe('8 letters or more, 70% uppercase');
    expect(paramSummary('links', { allowed: '' })).toBe('all links blocked');
    expect(paramSummary('links', { allowed: 'a.com, b.com' })).toBe('2 allowed domains');
    expect(paramSummary('words', { list: 'x\ny, z' })).toBe('3 words or phrases');
  });
});

describe('Automod form', () => {
  it('shows the options summary, an Off badge on disabled rules, and the timeout under the rules', async () => {
    renderForm();
    expect(await screen.findByRole('heading', { name: 'Auto-moderation' })).toBeTruthy();
    expect(screen.getByText(/max 5 messages per 5 s/)).toBeTruthy();
    expect(screen.queryByText('Settings')).toBeNull();
    const links = screen.getByText('Links', { selector: 'strong' }).closest('.v2-am-rule');
    expect(links.classList.contains('is-off')).toBe(true);
    expect(within(links).getByText('Off')).toBeTruthy();
    const spam = screen.getByText('Spam', { selector: 'strong' }).closest('.v2-am-rule');
    expect(spam.classList.contains('is-off')).toBe(false);
    // The timeout sits before the native section and the exemptions.
    const timeout = screen.getByLabelText(/Timeout length/);
    const native = screen.getByRole('heading', { name: 'Native Discord AutoMod' });
    expect(timeout.compareDocumentPosition(native) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the native sub-options disabled until "Enforce natively" is on', async () => {
    renderForm();
    const preset = await screen.findByLabelText('Profanity');
    expect(preset.disabled).toBe(true);
    expect(screen.getByLabelText(/^Links/, { selector: 'input[type=checkbox]' }).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Enforce natively'));
    expect(screen.getByLabelText('Profanity').disabled).toBe(false);
  });

  it('has no separate immunity save button; the roles are saved with the form', async () => {
    api.saveModuleConfig.mockImplementation(async (_g, _id, body) => ({ config: body }));
    renderForm();
    expect(await screen.findByText('Mods')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Save immunity roles/ })).toBeNull();

    // Changing only the immunity roles makes the page "dirty" so the Save bar (and the leave guard) wakes up.
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    fireEvent.change(screen.getByLabelText('Add a role'), { target: { value: ROLE_B } });
    expect(await screen.findByText(/Unsaved changes/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveModuleConfig).toHaveBeenCalledTimes(1));
    const [guild, id, body] = api.saveModuleConfig.mock.calls[0];
    expect([guild, id]).toEqual([GUILD, 'automod']);
    expect(body.exemptRoles).toEqual([ROLE_A, ROLE_B]);
    expect(body.rules.words.list).toBe('one, two');
    expect(api.saveAutomodImmunity).not.toHaveBeenCalled();
  });

  it('removing the last immunity role is saved as an empty list', async () => {
    api.saveModuleConfig.mockImplementation(async (_g, _id, body) => ({ config: body }));
    renderForm();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Mods' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveModuleConfig).toHaveBeenCalled());
    expect(api.saveModuleConfig.mock.calls[0][2].exemptRoles).toEqual([]);
  });
});
