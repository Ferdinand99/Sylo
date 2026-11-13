import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MemberPicker from '../components/MemberPicker.jsx';
import MentionTextarea from '../components/MentionTextarea.jsx';
import MessagePreview from '../components/MessagePreview.jsx';
import OverflowMenu from '../components/OverflowMenu.jsx';
import { resetMemberNames } from '../memberNames.js';

vi.mock('../api.js', () => ({ searchMembers: vi.fn(), getMemberNames: vi.fn() }));
const { searchMembers, getMemberNames } = await import('../api.js');

const GUILD = '123456789012345678';
const USER = '300000000000000041';

const inGuild = (ui) =>
  render(
    <MemoryRouter initialEntries={[`/guilds/${GUILD}`]}>
      <Routes>
        <Route path="/guilds/:guildId" element={ui} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  vi.resetAllMocks();
  resetMemberNames();
  searchMembers.mockResolvedValue({ members: [] });
  getMemberNames.mockResolvedValue({ names: {} });
});

describe('a saved member mention', () => {
  it('shows the member name in the chips and the preview after a reload', async () => {
    getMemberNames.mockResolvedValue({ names: { [USER]: 'Mara' } });
    const text = `Thanks <@${USER}>!`;
    function Field() {
      const [value, setValue] = useState(text);
      return (
        <>
          <MentionTextarea aria-label="Message" value={value} onChange={(e) => setValue(e.target.value)} />
          <MessagePreview content={value} />
        </>
      );
    }
    inGuild(<Field />);
    await waitFor(() => expect(getMemberNames).toHaveBeenCalledTimes(1));
    expect(getMemberNames).toHaveBeenCalledWith(GUILD, [USER]);
    const chips = await screen.findByRole('list', { name: 'Mentions in this text' });
    await waitFor(() => expect(chips.textContent).toBe('@Mara'));
    expect(document.querySelector('.v2-msg-text').textContent).toBe('Thanks @Mara!');
  });

  it('reads @member when the server cannot name it, and asks only once for the same member', async () => {
    inGuild(
      <>
        <MentionTextarea aria-label="One" value={`<@${USER}>`} onChange={() => {}} />
        <MentionTextarea aria-label="Two" value={`hi <@${USER}>`} onChange={() => {}} />
      </>
    );
    await waitFor(() => expect(getMemberNames).toHaveBeenCalled());
    expect(getMemberNames).toHaveBeenCalledTimes(1);
    expect((await screen.findAllByRole('list', { name: 'Mentions in this text' }))[0].textContent).toBe(
      '@member'
    );
  });
});

describe('MentionTextarea as a combobox', () => {
  it('announces itself as a combobox and says when its list is open', async () => {
    function Field() {
      const [value, setValue] = useState('');
      return (
        <MentionTextarea
          aria-label="Message"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          channels={[{ id: '100000000000000021', name: 'welcome' }]}
        />
      );
    }
    inGuild(<Field />);
    const field = screen.getByRole('combobox', { name: 'Message' });
    expect(field.getAttribute('aria-expanded')).toBe('false');
    fireEvent.change(field, { target: { value: '#wel' } });
    field.setSelectionRange(4, 4);
    fireEvent.input(field);
    await screen.findByRole('listbox');
    expect(field.getAttribute('aria-expanded')).toBe('true');
    expect(field.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
    expect(field.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0].id);
  });
});

describe('MemberPicker', () => {
  it('searches by name from two letters, picks a member and shows the name with a way to clear it', async () => {
    searchMembers.mockResolvedValue({ members: [{ id: USER, name: 'Mara', username: 'mara' }] });
    const changes = [];
    function Host() {
      const [id, setId] = useState('');
      return (
        <MemberPicker
          id="m"
          value={id}
          onChange={(v) => {
            changes.push(v);
            setId(v);
          }}
        />
      );
    }
    inGuild(<Host />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'm' } });
    expect(screen.getByText(/at least two letters/)).toBeTruthy();
    expect(searchMembers).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'ma' } });
    await waitFor(() => expect(searchMembers).toHaveBeenCalledWith(GUILD, 'ma'));
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Mara/ }));
    expect(changes).toEqual([USER]);
    expect(screen.getByText('@Mara')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Clear the member filter/ }));
    expect(changes).toEqual([USER, '']);
    expect(screen.getByRole('combobox')).toBeTruthy();
  });

  it('announces the active option, and the chosen member sits in something the label can point at', async () => {
    searchMembers.mockResolvedValue({
      members: [
        { id: USER, name: 'Mara', username: 'mara' },
        { id: '300000000000000042', name: 'Marlin', username: 'marlin' },
      ],
    });
    function Host() {
      const [id, setId] = useState('');
      return (
        <>
          <label htmlFor="m">Member</label>
          <MemberPicker id="m" value={id} onChange={setId} />
        </>
      );
    }
    inGuild(<Host />);
    const input = screen.getByLabelText('Member');
    fireEvent.change(input, { target: { value: 'mar' } });
    await screen.findAllByRole('option');
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0].id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1].id);
    fireEvent.keyDown(input, { key: 'Enter' });
    // after the pick, the label still labels the element that shows the member
    expect(screen.getByLabelText('Member').textContent).toBe('@Marlin');
  });

  it('accepts a pasted member id, for a member who left or is not cached', async () => {
    const changes = [];
    function Host() {
      const [id, setId] = useState('');
      return (
        <MemberPicker
          id="m"
          value={id}
          onChange={(v) => {
            changes.push(v);
            setId(v);
          }}
        />
      );
    }
    inGuild(<Host />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: ` ${USER} ` } });
    expect(searchMembers).not.toHaveBeenCalled();
    fireEvent.mouseDown(await screen.findByRole('option', { name: `Use the member id ${USER}` }));
    expect(changes).toEqual([USER]);
    // nobody can name this member: it shows by the end of the id
    expect(screen.getByText(/@member …0041/)).toBeTruthy();
  });
});

describe('OverflowMenu', () => {
  it('opens a menu of actions, runs one and closes; Escape closes and gives the focus back', () => {
    const onPause = vi.fn();
    render(
      <OverflowMenu
        label="More actions for Anchor"
        items={[
          { label: 'Pause', onClick: onPause },
          { label: 'Delete', danger: true, onClick: () => {} },
          { label: 'Move up', disabled: true, onClick: () => {} },
        ]}
      />
    );
    const button = screen.getByRole('button', { name: 'More actions for Anchor' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Pause', 'Delete', 'Move up']);
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Pause' }));
    expect(screen.getByRole('menuitem', { name: 'Move up' }).disabled).toBe(true);
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pause' }));
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    // after an action the focus is back on the button, not lost
    expect(document.activeElement).toBe(button);
  });

  it('is drawn outside the row, so a list with overflow hidden cannot clip it', () => {
    render(
      <div className="v2-list" style={{ overflow: 'hidden' }}>
        <OverflowMenu label="More" items={[{ label: 'Pause', onClick: () => {} }]} />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const menu = screen.getByRole('menu');
    expect(menu.closest('.v2-list')).toBeNull();
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe('fixed');
    expect(menu.style.top).not.toBe('');
  });

  it('opens upward when there is no room below the button', () => {
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: window.innerHeight - 40,
      bottom: window.innerHeight - 4,
      left: 400,
      right: 440,
      width: 40,
      height: 36,
    });
    render(
      <OverflowMenu
        label="More"
        items={[
          { label: 'Pause', onClick: () => {} },
          { label: 'Delete', onClick: () => {} },
        ]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const menu = screen.getByRole('menu');
    expect(menu.style.bottom).toBe('44px');
    expect(menu.style.top).toBe('');
    rect.mockRestore();
  });

  it('closes on a press outside', () => {
    render(
      <div>
        <OverflowMenu label="More" items={[{ label: 'Pause', onClick: () => {} }]} />
        <p>outside</p>
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    act(() => {
      fireEvent.pointerDown(screen.getByText('outside'));
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('MessagePreview colour', () => {
  it('uses a custom #rrggbb colour for the embed bar and ignores anything else', () => {
    const { container, rerender } = inGuildRender(
      <MessagePreview embed={{ description: 'x', color: '#ff8800' }} />
    );
    expect(container.querySelector('.v2-embed-bar').style.background).toBe('rgb(255, 136, 0)');
    rerender(wrap(<MessagePreview embed={{ description: 'x', color: 'red; background: url(x)' }} />));
    expect(container.querySelector('.v2-embed-bar').style.background).toContain('var(--accent)');
  });
});

function wrap(ui) {
  return <MemoryRouter>{ui}</MemoryRouter>;
}
function inGuildRender(ui) {
  return render(wrap(ui));
}
