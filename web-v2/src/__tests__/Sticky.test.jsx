import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Sticky from '../moduleForms/Sticky.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  // LoadError reads ApiError; the rest is the pair useModuleForm calls.
  ApiError: class ApiError extends Error {},
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
  getModuleLimits: vi.fn(),
}));
const { getModuleConfig, saveModuleConfig, getModuleLimits } = await import('../api.js');

const GUILD = '123456789012345678';
const CHANNEL = '555555555555555555';

// What GET /api/v2/modules/limits answers for the sticky module (src/modules/sticky.js, LIMITS).
const limits = {
  sticky: {
    stickies: { maxItems: 50 },
    'stickies[].content': { maxLength: 2000 },
    'stickies[].cooldownSeconds': { min: 0, max: 3600 },
  },
  _embed: {},
};

const config = {
  stickies: [
    {
      channelId: CHANNEL,
      content: 'Read the rules',
      embed: null,
      repostOnBots: false,
      cooldownSeconds: 0,
    },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  resetModuleLimits();
  getModuleLimits.mockResolvedValue(limits);
  getModuleConfig.mockResolvedValue({ config, channels: [{ id: CHANNEL, name: 'general' }] });
});

describe('Sticky form', () => {
  it('renders the saved sticky with the 2000 character limit on its message', async () => {
    renderAtGuild(<Sticky />, GUILD);

    expect(await screen.findByRole('heading', { name: 'Sticky messages' })).toBeTruthy();
    const message = screen.getByPlaceholderText(/Message to keep at the bottom/);
    expect(message.value).toBe('Read the rules');
    await waitFor(() => expect(message.maxLength).toBe(2000));
    expect(screen.getByRole('option', { name: '#general' }).selected).toBe(true);
    expect(getModuleConfig).toHaveBeenCalledWith(GUILD, 'sticky');
  });

  it('saves {stickies: [...]} with the edited message', async () => {
    saveModuleConfig.mockResolvedValue({ config });
    renderAtGuild(<Sticky />, GUILD);
    const message = await screen.findByPlaceholderText(/Message to keep at the bottom/);

    // Nothing to save yet.
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true);

    fireEvent.change(message, { target: { value: 'Read the rules first' } });
    const save = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    await waitFor(() => expect(saveModuleConfig).toHaveBeenCalledTimes(1));
    expect(saveModuleConfig).toHaveBeenCalledWith(GUILD, 'sticky', {
      stickies: [
        {
          channelId: CHANNEL,
          content: 'Read the rules first',
          embed: null,
          repostOnBots: false,
          cooldownSeconds: 0,
        },
      ],
    });
  });

  it('adds an empty row that saves as a new sticky', async () => {
    saveModuleConfig.mockResolvedValue({ config });
    renderAtGuild(<Sticky />, GUILD);
    await screen.findByPlaceholderText(/Message to keep at the bottom/);

    fireEvent.click(screen.getByRole('button', { name: '+ Add channel' }));
    const messages = screen.getAllByPlaceholderText(/Message to keep at the bottom/);
    expect(messages).toHaveLength(2);
    await waitFor(() => expect(messages[1].maxLength).toBe(2000));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveModuleConfig).toHaveBeenCalledTimes(1));
    const [, , body] = saveModuleConfig.mock.calls[0];
    expect(Object.keys(body)).toEqual(['stickies']);
    expect(body.stickies).toHaveLength(2);
    expect(body.stickies[1]).toEqual({
      channelId: '',
      content: '',
      embed: null,
      repostOnBots: false,
      cooldownSeconds: 0,
    });
  });
});

describe('Sticky form limits', () => {
  it('takes the cooldown range from the server limits', async () => {
    renderAtGuild(<Sticky />, GUILD);
    const cooldown = await screen.findByRole('spinbutton');
    await waitFor(() => expect(cooldown.max).toBe('3600'));
    expect(cooldown.min).toBe('0');
  });

  it('stops adding channels at the row limit', async () => {
    getModuleLimits.mockResolvedValue({
      ...limits,
      sticky: { ...limits.sticky, stickies: { maxItems: 1 } },
    });
    renderAtGuild(<Sticky />, GUILD);
    await screen.findByPlaceholderText(/Message to keep at the bottom/);
    await waitFor(() => expect(screen.getByRole('button', { name: '+ Add channel' }).disabled).toBe(true));
  });

  it('still renders and edits when the limits cannot be loaded', async () => {
    getModuleLimits.mockRejectedValue(new Error('offline'));
    renderAtGuild(<Sticky />, GUILD);
    const message = await screen.findByPlaceholderText(/Message to keep at the bottom/);
    expect(message.value).toBe('Read the rules');
    expect(message.hasAttribute('maxlength')).toBe(false);
    expect(screen.getByRole('button', { name: '+ Add channel' }).disabled).toBe(false);
  });
});
