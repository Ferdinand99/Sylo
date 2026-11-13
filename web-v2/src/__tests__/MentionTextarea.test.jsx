import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MentionTextarea from '../components/MentionTextarea.jsx';

vi.mock('../api.js', () => ({ searchMembers: vi.fn() }));
const { searchMembers } = await import('../api.js');

const GUILD = '123456789012345678';
const CH = '100000000000000021';
const ROLE = '200000000000000031';
const channels = [
  { id: CH, name: 'welcome' },
  { id: '100000000000000022', name: 'rules' },
];
const roles = [{ id: ROLE, name: 'Verified' }];

function Harness({ start = '' }) {
  const [value, setValue] = useState(start);
  return (
    <MemoryRouter initialEntries={[`/guilds/${GUILD}`]}>
      <Routes>
        <Route
          path="/guilds/:guildId"
          element={
            <MentionTextarea
              id="msg"
              aria-label="Message"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              channels={channels}
              roles={roles}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

// jsdom has no execCommand, so the component falls back to setting the value and firing an input event.
function type(el, text) {
  fireEvent.change(el, { target: { value: text } });
  el.setSelectionRange(text.length, text.length);
  fireEvent.input(el);
}

beforeEach(() => {
  vi.resetAllMocks();
  searchMembers.mockResolvedValue({ members: [] });
});

describe('MentionTextarea', () => {
  it('opens the channels when # is typed and writes the channel token when one is picked', async () => {
    render(<Harness />);
    const field = screen.getByLabelText('Message');
    type(field, 'Say hi in #wel');
    const option = await screen.findByRole('option', { name: /welcome/ });
    fireEvent.mouseDown(option);
    expect(field.value).toBe(`Say hi in <#${CH}> `);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows the name of a mention as a chip, not its id', () => {
    render(<Harness start={`Hello <#${CH}> and <@&${ROLE}> and <#999999999999999999>`} />);
    const chips = screen.getByRole('list', { name: 'Mentions in this text' });
    expect(chips.textContent).toContain('#welcome');
    expect(chips.textContent).toContain('@Verified');
    expect(chips.textContent).toContain('#deleted-channel');
    expect(chips.textContent).not.toContain(CH);
  });

  it('offers roles and @everyone for @, and picks with the keyboard', async () => {
    render(<Harness />);
    const field = screen.getByLabelText('Message');
    type(field, 'Hi @ve');
    expect(await screen.findByRole('option', { name: /Verified/ })).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field.value).toBe(`Hi <@&${ROLE}> `);
  });

  it('moves with the arrow keys and closes with Escape without changing the text', async () => {
    render(<Harness />);
    const field = screen.getByLabelText('Message');
    type(field, '#');
    await screen.findByRole('listbox');
    const options = () => screen.getAllByRole('option');
    expect(options()[0].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(options()[1].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(field.value).toBe('#');
  });

  it('searches members after @ and writes a member mention', async () => {
    searchMembers.mockResolvedValue({
      members: [{ id: '300000000000000041', name: 'Mara', username: 'mara' }],
    });
    render(<Harness />);
    const field = screen.getByLabelText('Message');
    type(field, 'Thanks @ma');
    await waitFor(() => expect(searchMembers).toHaveBeenCalledWith(GUILD, 'ma'));
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Mara/ }));
    expect(field.value).toBe('Thanks <@300000000000000041> ');
    expect(screen.getByRole('list', { name: 'Mentions in this text' }).textContent).toContain('@Mara');
  });

  it('does nothing for a # inside a word', () => {
    render(<Harness />);
    type(screen.getByLabelText('Message'), 'issue#12');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
