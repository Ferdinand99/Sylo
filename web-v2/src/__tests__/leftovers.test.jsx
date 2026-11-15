import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Appeals, { moveQuestion, removeQuestion } from '../moduleForms/Appeals.jsx';
import AutoReact from '../moduleForms/AutoReact.jsx';
import { appendEmoji } from '../emojiText.js';
import ServerStats from '../moduleForms/ServerStats.jsx';
import EmbedEditor from '../components/EmbedEditor.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { resetOperatorCache } from '../useOperator.js';
import { DISCORD, PlatformContext } from '../platformContext.jsx';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
  getModuleLimits: vi.fn(),
  getAccount: vi.fn(),
  getGuildEmojis: vi.fn(),
}));
const { getModuleConfig, getModuleLimits, getAccount, getGuildEmojis } = await import('../api.js');
const { notify } = await import('../notify.js');

const GUILD = '123456789012345678';

beforeEach(() => {
  vi.resetAllMocks();
  resetModuleLimits();
  resetOperatorCache();
  getModuleLimits.mockResolvedValue({ _embed: {} });
  getAccount.mockResolvedValue({ open: true });
  getGuildEmojis.mockResolvedValue({ custom: [] });
});

describe('EmbedEditor variable chips', () => {
  const vars = [{ token: '{user}', label: 'User' }];

  function setup(spec) {
    const onChange = vi.fn();
    render(<EmbedEditor spec={spec} onChange={onChange} vars={vars} />);
    return onChange;
  }

  it('puts the variable at the caret of the field last edited, not at its end', () => {
    const onChange = setup({ title: 'Hello !' });
    const title = screen.getByLabelText('Embed title');
    title.focus();
    title.setSelectionRange(6, 6);
    fireEvent.click(screen.getByRole('button', { name: 'User' }));
    expect(title.value).toBe('Hello {user}!');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Hello {user}!' }));
  });

  it('uses the caret the field had when it lost focus (the chip took the focus)', () => {
    setup({ title: 'Hello !' });
    const title = screen.getByLabelText('Embed title');
    title.focus();
    title.setSelectionRange(6, 6);
    title.blur();
    fireEvent.click(screen.getByRole('button', { name: 'User' }));
    expect(title.value).toBe('Hello {user}!');
  });

  it('replaces a selection', () => {
    setup({ title: 'Hi NAME' });
    const title = screen.getByLabelText('Embed title');
    title.focus();
    title.setSelectionRange(3, 7);
    fireEvent.click(screen.getByRole('button', { name: 'User' }));
    expect(title.value).toBe('Hi {user}');
  });

  it('goes into the name or value of an extra field when that is where the cursor is', () => {
    const onChange = vi.fn();
    render(
      <EmbedEditor
        spec={{ title: 'Title', fields: [{ name: 'Name', value: 'Value !' }] }}
        onChange={onChange}
        vars={vars}
      />
    );
    const value = screen.getByLabelText('Field value');
    value.focus();
    value.setSelectionRange(6, 6);
    fireEvent.click(screen.getByRole('button', { name: 'User' }));
    expect(value.value).toBe('Value {user}!');
    expect(screen.getByLabelText('Embed title').value).toBe('Title');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ fields: [{ name: 'Name', value: 'Value {user}!', inline: false }] })
    );

    const name = screen.getByLabelText('Field name');
    name.focus();
    name.setSelectionRange(0, 0);
    fireEvent.click(screen.getByRole('button', { name: 'User' }));
    expect(name.value).toBe('{user}Name');
  });

  it('says so, and leaves the text alone, when the variable does not fit the field', () => {
    const onChange = vi.fn();
    render(
      <EmbedEditor
        spec={{ title: 'Hello' }}
        onChange={onChange}
        vars={vars}
        limits={{ title: { maxLength: 8 } }}
      />
    );
    const title = screen.getByLabelText('Embed title');
    title.focus();
    title.setSelectionRange(5, 5);
    fireEvent.click(screen.getByRole('button', { name: 'User' }));
    expect(title.value).toBe('Hello');
    expect(notify).toHaveBeenCalledWith('No room for {user}: the field is full.');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('adds it at the end, after a space, when no field was clicked into yet', () => {
    setup({ title: 'Hello' });
    fireEvent.click(screen.getByRole('button', { name: 'User' }));
    expect(screen.getByLabelText('Embed title').value).toBe('Hello {user}');
  });
});

describe('Auto-react emoji picker', () => {
  it('adds an emoji to the list with a space, and the text field still takes typing', async () => {
    getModuleConfig.mockResolvedValue({
      config: { cooldownSeconds: 5, logChannelId: '', rules: [{ targetUsers: ['1'], emojis: [] }] },
      channels: [],
      roles: [],
      modes: ['always', 'random'],
      roleActions: ['add', 'remove'],
    });
    renderAtGuild(<AutoReact />, GUILD);
    const field = await screen.findByLabelText('Emoji to react with');
    fireEvent.click(screen.getByRole('button', { name: '🔥' }));
    expect(field.value).toBe('🔥');
    fireEvent.click(screen.getByRole('button', { name: '👍' }));
    expect(field.value).toBe('🔥 👍');
    fireEvent.change(field, { target: { value: '🧟' } });
    expect(field.value).toBe('🧟');
  });

  it('appendEmoji separates with one space and starts clean', () => {
    expect(appendEmoji('', '🔥')).toBe('🔥');
    expect(appendEmoji(undefined, '🔥')).toBe('🔥');
    expect(appendEmoji('🧟 ', '🔥')).toBe('🧟 🔥');
    expect(appendEmoji('🧟', '<:pog:123>')).toBe('🧟 <:pog:123>');
  });
});

describe('Ban appeals questions', () => {
  it('moveQuestion swaps with the neighbour and stays put at the ends', () => {
    expect(moveQuestion(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveQuestion(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveQuestion(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveQuestion(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  it('removeQuestion closes the gap and keeps five slots', () => {
    expect(removeQuestion(['a', 'b', 'c', '', ''], 0)).toEqual(['b', 'c', '', '', '']);
    expect(removeQuestion(['a', 'b', 'c', 'd', 'e'], 4)).toEqual(['a', 'b', 'c', 'd', '']);
  });

  it('keeps a question on one line: Enter adds nothing, pasted line breaks become spaces', async () => {
    getModuleConfig.mockResolvedValue({
      config: {
        questions: ['First?'],
        autoUnbanOnAccept: false,
        reviewChannelId: '',
        cooldownDays: 7,
        appealMessage: '',
        appealServerInvite: '',
      },
      channels: [],
      dashboardUrlSet: true,
    });
    renderAtGuild(<Appeals />, GUILD);
    const first = await screen.findByLabelText('Question 1');
    // fireEvent returns false when the event's default was prevented.
    expect(fireEvent.keyDown(first, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(first, { key: 'a' })).toBe(true);
    fireEvent.change(first, { target: { value: 'Why\r\n  were you\nbanned?' } });
    expect(first.value).toBe('Why were you banned?');
  });

  it('shows each question in a growing box with move and remove buttons', async () => {
    getModuleConfig.mockResolvedValue({
      config: {
        questions: ['First?', 'Second?'],
        autoUnbanOnAccept: false,
        reviewChannelId: '',
        cooldownDays: 7,
        appealMessage: '',
        appealServerInvite: '',
      },
      channels: [],
      dashboardUrlSet: true,
    });
    renderAtGuild(<Appeals />, GUILD);
    const first = await screen.findByLabelText('Question 1');
    expect(first.tagName).toBe('TEXTAREA');
    expect(first.className).toContain('v2-autogrow');
    expect(screen.getByLabelText('Question 2').value).toBe('Second?');
    // The first cannot go up, an empty slot cannot be removed.
    expect(screen.getByRole('button', { name: 'Move question 1 up' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Remove question 3' }).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Move question 2 up' }));
    expect(screen.getByLabelText('Question 1').value).toBe('Second?');
    expect(screen.getByLabelText('Question 2').value).toBe('First?');

    fireEvent.click(screen.getByRole('button', { name: 'Remove question 1' }));
    expect(screen.getByLabelText('Question 1').value).toBe('First?');
    expect(screen.getByLabelText('Question 2').value).toBe('');
    expect(screen.getAllByLabelText(/^Question \d$/)).toHaveLength(5);
  });
});

describe('Server statistics refresh hint', () => {
  const answer = {
    config: { refreshMinutes: 10, channels: [] },
    statTypes: [['members', 'Members']],
    voiceChannels: [],
  };

  it('names Discord on Discord and stays neutral on Fluxer', async () => {
    getModuleConfig.mockResolvedValue(answer);
    const discord = renderAtGuild(<ServerStats />, GUILD);
    expect((await screen.findByText(/closer to/)).textContent).toContain("Discord's rename limit");
    discord.unmount();

    getModuleConfig.mockResolvedValue(answer);
    renderAtGuild(
      <PlatformContext.Provider value={{ ...DISCORD, platform: 'fluxer' }}>
        <ServerStats />
      </PlatformContext.Provider>,
      GUILD
    );
    const hint = await screen.findByText(/closer to/);
    expect(hint.textContent).toContain("the platform's rename limit");
    expect(hint.textContent).not.toContain('Discord');
  });
});
