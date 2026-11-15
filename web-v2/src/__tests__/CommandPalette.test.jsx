import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommandPalette, { isApplePlatform, isPaletteShortcut } from '../components/CommandPalette.jsx';

vi.mock('../OverviewContext.jsx', () => ({ useOverview: vi.fn() }));
vi.mock('../useOperator.js', () => ({ useOperator: vi.fn() }));
vi.mock('../api.js', () => ({ searchMembers: vi.fn(), searchInbox: vi.fn() }));
vi.mock('../moduleForms/index.js', () => ({
  v2Href: (card, guildId) => `/guilds/${guildId}/m/${card.id}`,
}));
const { useOverview } = await import('../OverviewContext.jsx');
const { useOperator } = await import('../useOperator.js');
const { searchMembers, searchInbox } = await import('../api.js');

const G = '111111111111111111';
const data = {
  attention: { waiting: {}, problems: [] },
  groups: [
    {
      title: 'Engagement',
      cards: [
        { id: 'welcome', name: 'Welcome', hasToggle: true, enabled: true, lines: [], icon: 'users' },
        { id: 'leveling', name: 'Leveling', hasToggle: true, enabled: false, lines: [], icon: 'star' },
      ],
    },
  ],
};
const guilds = [
  { id: G, name: 'Home' },
  { id: '222222222222222222', name: 'Other base' },
];

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
}
function setup(onClose = vi.fn(), path = `/guilds/${G}/audit`) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <CommandPalette open onClose={onClose} guildId={G} guilds={guilds} />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
  return onClose;
}
const field = () => screen.getByRole('combobox');
const type = (value) => fireEvent.change(field(), { target: { value } });

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  useOverview.mockReturnValue({ data, dataGuildId: G });
  useOperator.mockReturnValue(false);
  searchMembers.mockResolvedValue({ members: [] });
  searchInbox.mockResolvedValue({ items: [] });
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: true, addEventListener: vi.fn() }));
});
afterEach(() => {
  delete window.matchMedia;
  vi.useRealTimers();
});

describe('isPaletteShortcut', () => {
  const platform = (value) => vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue(value);
  afterEach(() => vi.restoreAllMocks());

  it('is Ctrl+K elsewhere, and nothing with Alt, Shift or the Command key', () => {
    platform('Win32');
    expect(isPaletteShortcut({ key: 'k', ctrlKey: true })).toBe(true);
    expect(isPaletteShortcut({ key: 'K', ctrlKey: true })).toBe(true);
    expect(isPaletteShortcut({ key: 'k' })).toBe(false);
    expect(isPaletteShortcut({ key: 'k', metaKey: true })).toBe(false);
    expect(isPaletteShortcut({ key: 'k', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isPaletteShortcut({ key: 'k', ctrlKey: true, altKey: true })).toBe(false);
    expect(isPaletteShortcut({ key: 'j', ctrlKey: true })).toBe(false);
  });

  it('is only Command+K on a Mac: Ctrl+K stays "delete to the end of the line" in a text field', () => {
    platform('MacIntel');
    expect(isApplePlatform()).toBe(true);
    expect(isPaletteShortcut({ key: 'k', metaKey: true })).toBe(true);
    expect(isPaletteShortcut({ key: 'k', ctrlKey: true })).toBe(false);
    expect(isPaletteShortcut({ key: 'k', ctrlKey: true, metaKey: true })).toBe(false);
  });
});

describe('CommandPalette', () => {
  it('renders nothing while closed', () => {
    render(
      <MemoryRouter>
        <CommandPalette open={false} onClose={() => {}} guildId={G} guilds={guilds} />
      </MemoryRouter>
    );
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('is a dialog with a combobox that controls a listbox of options', () => {
    setup();
    const input = field();
    expect(screen.getByRole('dialog', { hidden: true })).toBeTruthy();
    const list = screen.getByRole('listbox', { name: 'Results' });
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('option').length).toBeGreaterThan(3);
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0].id);
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true');
  });

  it('moves with the arrow keys, wraps round and opens the active item with Enter', () => {
    const onClose = setup();
    vi.useFakeTimers();
    const options = () => screen.getAllByRole('option');
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(options()[1].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(options().at(-1).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(screen.getByTestId('where').textContent).toBe(`/guilds/${G}`);
    act(() => vi.runAllTimers());
    expect(onClose).toHaveBeenCalled();
  });

  it('finds a module by name, also one that is switched off, and opens it', () => {
    setup();
    type('level');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('option', { name: /Leveling/ }));
    expect(screen.getByTestId('where').textContent).toBe(`/guilds/${G}/m/leveling`);
  });

  it('closes on Escape', () => {
    vi.useFakeTimers();
    const onClose = setup();
    fireEvent.keyDown(field(), { key: 'Escape' });
    act(() => vi.runAllTimers());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('remembers a place that was opened', () => {
    setup();
    type('audit');
    fireEvent.click(screen.getByRole('option', { name: /Audit log/ }));
    expect(JSON.parse(localStorage.getItem('sylo:v2:paletteRecent'))).toEqual(['page:audit']);
  });

  it('shows the recent items first when it opens', () => {
    localStorage.setItem('sylo:v2:paletteRecent', JSON.stringify(['module:leveling']));
    setup();
    expect(screen.getByRole('group', { name: 'Recent' })).toBeTruthy();
    expect(screen.getAllByRole('option')[0].textContent).toContain('Leveling');
  });

  it('switches server on the same page', () => {
    setup(vi.fn(), `/guilds/${G}/audit`);
    type('other');
    fireEvent.click(screen.getByRole('option', { name: /Switch to Other base/ }));
    expect(screen.getByTestId('where').textContent).toBe('/guilds/222222222222222222/audit');
  });

  it('says so when nothing matches', () => {
    setup();
    type('qqqq');
    expect(screen.getByText('Nothing matches "qqqq".')).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(field().getAttribute('aria-activedescendant')).toBeNull();
  });

  it('finds members through the member search and opens their data', async () => {
    searchMembers.mockResolvedValue({
      members: [{ id: '100000000000000021', name: 'Alice', username: 'alice' }],
    });
    setup();
    type('ali');
    const option = await screen.findByRole('option', { name: /Open member data for Alice/ });
    expect(searchMembers).toHaveBeenCalledWith(G, 'ali');
    fireEvent.click(option);
    expect(screen.getByTestId('where').textContent).toBe(`/guilds/${G}/member-data?user=100000000000000021`);
    // A member is not a place to come back to: it stays out of the recent list.
    expect(localStorage.getItem('sylo:v2:paletteRecent')).toBeNull();
  });

  it('opens member data for a pasted member id without asking the server', () => {
    setup();
    type('<@100000000000000021>');
    fireEvent.click(screen.getByRole('option', { name: /member id 100000000000000021/ }));
    expect(screen.getByTestId('where').textContent).toContain('member-data?user=100000000000000021');
    expect(searchMembers).not.toHaveBeenCalled();
  });

  it('finds an inbox item by its number', async () => {
    searchInbox.mockResolvedValue({
      items: [{ kind: 'ticket', number: 12, status: 'open', href: `/guilds/${G}/tickets/12` }],
    });
    setup();
    type('ticket #12');
    const option = await screen.findByRole('option', { name: /Ticket #12/ });
    expect(searchInbox).toHaveBeenCalledWith(G, 'ticket #12');
    // "ticket #12" names a kind: it is not also a member name.
    expect(searchMembers).not.toHaveBeenCalled();
    fireEvent.click(option);
    expect(screen.getByTestId('where').textContent).toBe(`/guilds/${G}/tickets/12`);
    // An inbox item is not a place to come back to: it stays out of the recent list, like a member.
    expect(localStorage.getItem('sylo:v2:paletteRecent')).toBeNull();
  });

  it('leaves the keys to the input method while a composition is on (Enter, arrows and Esc)', () => {
    vi.useFakeTimers();
    const onClose = setup();
    const options = () => screen.getAllByRole('option');
    // Enter that confirms a composition: it neither opens the item nor leaves the page.
    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(field(), { key: 'Enter', keyCode: 229 });
    expect(screen.getByTestId('where').textContent).toBe(`/guilds/${G}/audit`);
    // The arrows pick a candidate of the input method, not an option.
    fireEvent.keyDown(field(), { key: 'ArrowDown', isComposing: true });
    expect(options()[0].getAttribute('aria-selected')).toBe('true');
    // Esc cancels the composition, not the palette.
    fireEvent.keyDown(field(), { key: 'Escape', isComposing: true });
    act(() => vi.runAllTimers());
    expect(onClose).not.toHaveBeenCalled();
    // After the composition the same keys work again.
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(options()[1].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(screen.getByTestId('where').textContent).not.toBe(`/guilds/${G}/audit`);
  });

  it('asks nothing for one letter, and survives a failing search', async () => {
    searchMembers.mockRejectedValue(new Error('403'));
    setup();
    type('a');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(searchMembers).not.toHaveBeenCalled();
    type('alic');
    await waitFor(() => expect(searchMembers).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
