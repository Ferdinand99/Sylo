import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PlaceholderHint from '../components/PlaceholderHint.jsx';
import {
  PLACEHOLDER_SETS,
  closestToken,
  findTokens,
  insertAtCursor,
  tokensFor,
  unknownTokens,
} from '../placeholders.js';

describe('findTokens', () => {
  it('lists each {token} once, in order', () => {
    expect(findTokens('Hi {user.name}, welcome to {server}! {user.name} again')).toEqual([
      '{user.name}',
      '{server}',
    ]);
  });

  it('ignores braces that are not tokens', () => {
    expect(findTokens('{} { user } {1} plain {')).toEqual([]);
  });
});

describe('unknownTokens', () => {
  const welcome = PLACEHOLDER_SETS.welcome;

  it('is empty when every token is supported', () => {
    expect(unknownTokens('{user} joined {server} ({memberCount})', welcome)).toEqual([]);
  });

  it('suggests the real name for a near miss', () => {
    expect(unknownTokens('{username}: {content}', welcome)).toEqual([
      { token: '{username}', suggestion: '{user.name}' },
      { token: '{content}', suggestion: null },
    ]);
  });

  it('is case sensitive unless asked otherwise', () => {
    expect(unknownTokens('{Author}', PLACEHOLDER_SETS.autoThreadsName)).toHaveLength(1);
    expect(unknownTokens('{Author}', PLACEHOLDER_SETS.autoThreadsName, { ignoreCase: true })).toEqual([]);
  });

  it('suggests {author} for a mistyped one', () => {
    expect(closestToken('{autor}', PLACEHOLDER_SETS.autoThreadsName)).toBe('{author}');
  });

  it('does not suggest something unrelated', () => {
    expect(closestToken('{zzzzzz}', welcome)).toBeNull();
  });
});

describe('tokensFor', () => {
  it('uses the built-in set when the server sends none', () => {
    expect(tokensFor('birthdays').map((t) => t.token)).toEqual(['{user}', '{age}']);
  });

  it('follows the list the server sends and keeps known hints', () => {
    const tokens = tokensFor('autoresponder', ['{user}', '{extra}']);
    expect(tokens.map((t) => t.token)).toEqual(['{user}', '{extra}']);
    expect(tokens[0].hint).not.toBe('');
  });
});

describe('insertAtCursor', () => {
  it('puts the token at the caret', () => {
    expect(insertAtCursor('Hello !', '{user}', 6, 6)).toEqual({ value: 'Hello {user}!', caret: 12 });
  });

  it('replaces the selection', () => {
    expect(insertAtCursor('Hello NAME!', '{user}', 6, 10)).toEqual({ value: 'Hello {user}!', caret: 12 });
  });

  it('appends when there is no caret', () => {
    expect(insertAtCursor('Welcome', ' {user}')).toEqual({ value: 'Welcome {user}', caret: 14 });
  });
});

function Harness({ initial = '', tokens = PLACEHOLDER_SETS.welcome, ignoreCase = false }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <textarea id="msg" aria-label="Message" value={value} onChange={(e) => setValue(e.target.value)} />
      <PlaceholderHint
        fieldId="msg"
        tokens={tokens}
        value={value}
        onChange={setValue}
        ignoreCase={ignoreCase}
      />
    </>
  );
}

describe('PlaceholderHint', () => {
  it('offers one chip per supported token and says how to use them', () => {
    render(<Harness />);
    for (const tk of PLACEHOLDER_SETS.welcome) {
      expect(screen.getByRole('button', { name: `Insert ${tk.token}` })).toBeTruthy();
    }
    expect(screen.getByText('Click one to insert it at the cursor.')).toBeTruthy();
  });

  it('inserts at the caret and keeps the rest of the text', async () => {
    render(<Harness initial="Welcome to !" />);
    const field = screen.getByLabelText('Message');
    field.focus();
    field.setSelectionRange(11, 11);
    fireEvent.click(screen.getByRole('button', { name: 'Insert {server}' }));
    expect(field.value).toBe('Welcome to {server}!');
    await waitFor(() => expect(field.selectionStart).toBe(19));
  });

  it('replaces the selected text', () => {
    render(<Harness initial="Hi NAME" />);
    const field = screen.getByLabelText('Message');
    field.focus();
    field.setSelectionRange(3, 7);
    fireEvent.click(screen.getByRole('button', { name: 'Insert {user.name}' }));
    expect(field.value).toBe('Hi {user.name}');
  });

  it('warns about a token that is not a placeholder and offers the close match', () => {
    render(<Harness initial="Hi {username}" />);
    const warning = screen.getByRole('status');
    expect(warning.textContent).toContain("{username} isn't a placeholder here");
    expect(warning.textContent).toContain('did you mean {user.name}?');
  });

  it('has no warning for supported tokens, and the warning goes away when fixed', () => {
    render(<Harness initial="Hi {user.name}" />);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi {nope}' } });
    expect(screen.getByRole('status').textContent).toContain('it will show up exactly as typed');
  });

  it('never blocks anything: unknown tokens leave the value alone', () => {
    render(<Harness initial="{username}" />);
    expect(screen.getByLabelText('Message').value).toBe('{username}');
  });

  it('does not insert past the field limit', () => {
    function Limited() {
      const [value, setValue] = useState('12345');
      return (
        <>
          <input
            id="lim"
            aria-label="Limited"
            maxLength={8}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <PlaceholderHint
            fieldId="lim"
            tokens={PLACEHOLDER_SETS.serverStats}
            value={value}
            onChange={setValue}
          />
        </>
      );
    }
    render(<Limited />);
    fireEvent.click(screen.getByRole('button', { name: 'Insert {count}' }));
    expect(screen.getByLabelText('Limited').value).toBe('12345');
  });
});
