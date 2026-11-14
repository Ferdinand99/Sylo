import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PlaceholderBar, { insertIntoField } from '../components/PlaceholderBar.jsx';
import PlaceholderHint from '../components/PlaceholderHint.jsx';
import SectionIndex from '../components/SectionIndex.jsx';

const tokens = [
  { token: '{user}', hint: 'Mentions the member' },
  { token: '{server}', hint: 'The server name' },
];

function Two() {
  return (
    <>
      <PlaceholderBar
        fields={[
          { id: 'one', label: 'Welcome message', tokens },
          { id: 'two', label: 'Leave message', tokens: [tokens[1]] },
        ]}
      />
      <textarea id="one" aria-label="one" defaultValue="Hi " />
      <textarea id="two" aria-label="two" defaultValue="Bye" maxLength={8} />
    </>
  );
}

describe('PlaceholderBar', () => {
  it('inserts into the first field until another one is edited, and names the field', () => {
    render(<Two />);
    expect(screen.getByText(/Insert into “Welcome message”/)).toBeTruthy();
    const one = screen.getByLabelText('one');
    one.focus();
    one.setSelectionRange(3, 3);
    fireEvent.click(screen.getByRole('button', { name: 'Insert {user}' }));
    expect(one.value).toBe('Hi {user}');
  });

  it('follows the field that was edited last and offers only the tokens that field fills in', () => {
    render(<Two />);
    const two = screen.getByLabelText('two');
    two.focus();
    fireEvent.focusIn(two);
    expect(screen.getByText(/Insert into “Leave message”/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Insert {user}' })).toBeNull();
    two.setSelectionRange(0, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Insert {server}' }));
    // "{server}" does not fit a field limited to 8 characters that already holds "Bye"
    expect(two.value).toBe('Bye');
    expect(screen.getByRole('status').textContent).toContain('No room for {server}');
  });
});

describe('insertIntoField', () => {
  it('writes at the caret, replacing the selection, and refuses a token that does not fit', () => {
    const el = document.createElement('textarea');
    document.body.appendChild(el);
    el.value = 'Hello world';
    expect(insertIntoField(el, '{user}', { start: 6, end: 11 })).toBe(true);
    expect(el.value).toBe('Hello {user}');
    el.maxLength = 12;
    expect(insertIntoField(el, '{server}', { start: 0, end: 0 })).toBe(false);
    expect(el.value).toBe('Hello {user}');
    el.remove();
  });
});

describe('PlaceholderHint without chips', () => {
  it('still warns about a token the field does not fill in, but draws no chips', () => {
    render(
      <PlaceholderHint fieldId="x" chips={false} tokens={tokens} value="Hi {nope}" onChange={() => {}} />
    );
    expect(screen.queryByRole('group', { name: 'Insert a placeholder' })).toBeNull();
    expect(screen.getByText(/isn't a placeholder here/)).toBeTruthy();
  });
});

describe('SectionIndex', () => {
  afterEach(() => {
    delete Element.prototype.scrollIntoView;
  });

  it('scrolls to the section and moves focus to its heading', () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(
      <>
        <SectionIndex
          sections={[
            ['a', 'First'],
            ['b', 'Second'],
          ]}
        />
        <h2 id="a">First section</h2>
        <h2 id="b">Second section</h2>
      </>
    );
    const nav = screen.getByRole('navigation', { name: 'On this page' });
    expect(nav.querySelectorAll('button').length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Second' }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.getElementById('b'));
  });
});
