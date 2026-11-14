import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MentionTextarea from '../components/MentionTextarea.jsx';
import { syncMirror } from '../components/MentionMirror.jsx';

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

describe('mentions drawn as names inside the field', () => {
  const token = `<#${CH}>`;
  const mirrorOf = () => screen.queryByTestId('mention-mirror');
  const namesOf = () => screen.queryByTestId('mention-names');
  const nameTexts = () => [...namesOf().querySelectorAll('.v2-mm-name')].map((n) => n.textContent);
  /** Put the caret (or a range) in the field the way a click or a key would. */
  const caretAt = (el, start, end = start) => {
    el.focus();
    el.setSelectionRange(start, end);
  };

  it('draws no layer, and leaves the field as it is, while the text has no mention', () => {
    render(<Harness start="Plain text, issue#12 and a@b.c" />);
    expect(mirrorOf()).toBeNull();
    expect(screen.getByLabelText('Message').className).not.toContain('is-mirrored');
  });

  it('draws the names over the field, with the raw text kept so every letter keeps its width', () => {
    const value = `Hi ${token} and <@&${ROLE}> and <#999999999999999999> @everyone!`;
    render(<Harness start={value} />);
    const mirror = mirrorOf();
    // The layer holds exactly the letters of the field; the names are in a layer of their own.
    expect(mirror.textContent).toBe(value);
    expect(nameTexts()).toEqual(['#welcome', '@Verified', '#deleted-channel']);
    expect(namesOf().querySelector('.is-missing').textContent).toBe('#deleted-channel');
    expect(mirror.querySelector('.is-missing')).not.toBeNull();
    expect(mirror.querySelector('.is-special').textContent).toBe('@everyone');
    expect(screen.getByLabelText('Message').className).toContain('is-mirrored');
    // The field's own value is never touched.
    expect(screen.getByLabelText('Message').value).toBe(value);
  });

  it('follows the text as it changes and goes away with the last mention', () => {
    render(<Harness start={`a ${token}`} />);
    const field = screen.getByLabelText('Message');
    expect(mirrorOf()).not.toBeNull();
    type(field, `a ${token} b`);
    expect(mirrorOf().textContent).toBe(`a ${token} b`);
    type(field, 'a b');
    expect(mirrorOf()).toBeNull();
    expect(field.className).not.toContain('is-mirrored');
  });

  it('keeps its label and combobox semantics, and the layer is hidden from assistive technology', () => {
    render(<Harness start={`a ${token}`} />);
    const field = screen.getByRole('combobox', { name: 'Message' });
    expect(field.getAttribute('aria-expanded')).toBe('false');
    expect(mirrorOf().getAttribute('aria-hidden')).toBe('true');
    expect(namesOf().getAttribute('aria-hidden')).toBe('true');
    // Nothing of the layer is in the accessibility tree: still exactly one text field.
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(mirrorOf().querySelector('[tabindex],button,a,input')).toBeNull();
  });

  it('renders names as text, never as markup', () => {
    render(
      <MemoryRouter initialEntries={[`/guilds/${GUILD}`]}>
        <Routes>
          <Route
            path="/guilds/:guildId"
            element={
              <MentionTextarea
                aria-label="Message"
                value={`x <#${CH}> <@&${ROLE}>`}
                onChange={() => {}}
                channels={[{ id: CH, name: '</div><b>boom</b><img src=x onerror=alert(1)>' }]}
                roles={[{ id: ROLE, name: '<script>alert(1)</script>' }]}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    );
    for (const layer of [mirrorOf(), namesOf()]) {
      expect(layer.querySelector('img, b, script')).toBeNull();
      expect(layer.innerHTML).not.toContain('<img');
      expect(layer.innerHTML).not.toContain('<script');
    }
    expect(nameTexts()).toEqual([
      '#</div><b>boom</b><img src=x onerror=alert(1)>',
      '@<script>alert(1)</script>',
    ]);
  });

  it('takes its font, padding and wrapping from the field, so the lines break at the same letter', () => {
    render(<Harness start={`a ${token}`} />);
    const field = screen.getByLabelText('Message');
    field.style.fontFamily = 'Georgia, serif';
    field.style.fontSize = '17px';
    field.style.letterSpacing = '0.4px';
    field.style.lineHeight = '1.7';
    field.style.padding = '11px 13px';
    field.style.borderStyle = 'solid';
    field.style.borderWidth = '3px';
    field.style.whiteSpace = 'pre-wrap';
    field.style.overflowWrap = 'anywhere';
    // A new render syncs the layer again (here: a change of the text).
    type(field, `a ${token} b`);
    const m = mirrorOf().style;
    expect(m.fontFamily).toContain('Georgia');
    expect(m.fontSize).toBe('17px');
    expect(m.letterSpacing).toBe('0.4px');
    expect(m.lineHeight).toBe(window.getComputedStyle(field).lineHeight);
    expect(m.lineHeight).not.toBe('');
    expect(m.paddingLeft).toBe('13px');
    expect(m.paddingTop).toBe('11px');
    expect(m.borderLeftWidth).toBe('3px');
    expect(m.whiteSpace).toBe('pre-wrap');
    expect(m.overflowWrap).toBe('anywhere');
    expect(m.color).toBe(window.getComputedStyle(field).color);
  });

  it('places each name over its token from where the browser laid the token out, and slides it with the scroll', () => {
    const rect = (left, top, width, height) => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    });
    const clientRects = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function () {
      return this.hasAttribute('data-token') ? [rect(40, 12, 150, 19)] : [];
    });
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return this.classList.contains('v2-mention-mirror') ? rect(10, 2, 300, 90) : rect(0, 0, 0, 0);
    });
    try {
      render(<Harness start={`a ${token}`} />);
      const name = namesOf().querySelector('.v2-mm-name');
      expect(name.style.left).toBe('30px');
      expect(name.style.top).toBe('10px');
      expect(name.style.width).toBe('150px');
      expect(name.style.height).toBe('19px');
      expect(name.style.visibility).toBe('');
      const field = screen.getByLabelText('Message');
      field.scrollTop = 25;
      fireEvent.scroll(field);
      expect(namesOf().querySelector('.v2-mm-names-inner').style.transform).toBe(
        `translate(${-mirrorOf().scrollLeft}px, ${-mirrorOf().scrollTop}px)`
      );
    } finally {
      clientRects.mockRestore();
      bounds.mockRestore();
    }
  });

  it('keeps a name out of sight until the browser has laid its token out', () => {
    render(<Harness start={`a ${token}`} />);
    expect(namesOf().querySelector('.v2-mm-name').style.visibility).toBe('hidden');
  });

  it('keeps the layer at the same scroll position as the field', () => {
    render(<Harness start={`a ${token}`} />);
    const field = screen.getByLabelText('Message');
    field.scrollTop = 42;
    fireEvent.scroll(field);
    expect(mirrorOf().scrollTop).toBe(field.scrollTop);
  });

  it('keeps the layer at the same horizontal scroll position as the field', () => {
    render(<Harness start={`a ${token}`} />);
    const field = screen.getByLabelText('Message');
    field.scrollLeft = 17;
    fireEvent.scroll(field);
    expect(mirrorOf().scrollLeft).toBe(field.scrollLeft);
    // (jsdom writes a zero as nothing, so only the horizontal part is pinned)
    expect(namesOf().querySelector('.v2-mm-names-inner').style.transform).toMatch(/^translate\(-17px/);
  });

  it('lays a stored Windows line break out as the one line feed the field holds', () => {
    render(<Harness start={`a ${token}\r\nb\rc`} />);
    expect(mirrorOf().textContent).toBe(`a ${token}\nb\nc`);
    expect(nameTexts()).toEqual(['#welcome']);
  });

  describe('when the theme switches', () => {
    afterEach(() => {
      document.documentElement.removeAttribute('data-theme');
      delete window.matchMedia;
    });

    it('copies the field text colour again when the page changes its data-theme', async () => {
      render(<Harness start={`a ${token}`} />);
      const field = screen.getByLabelText('Message');
      field.style.color = 'rgb(20, 20, 20)';
      type(field, `a ${token} b`);
      expect(mirrorOf().style.color).toBe('rgb(20, 20, 20)');
      // The toggle sets the attribute and the stylesheet gives the field another colour; nothing re-renders.
      field.style.color = 'rgb(235, 235, 235)';
      document.documentElement.setAttribute('data-theme', 'dark');
      await waitFor(() => expect(mirrorOf().style.color).toBe('rgb(235, 235, 235)'));
    });

    it('copies it again when the system switches between light and dark', () => {
      const listeners = new Set();
      window.matchMedia = vi.fn(() => ({
        matches: false,
        addEventListener: (_type, fn) => listeners.add(fn),
        removeEventListener: (_type, fn) => listeners.delete(fn),
      }));
      render(<Harness start={`a ${token}`} />);
      const field = screen.getByLabelText('Message');
      field.style.color = 'rgb(20, 20, 20)';
      type(field, `a ${token} b`);
      expect(mirrorOf().style.color).toBe('rgb(20, 20, 20)');
      expect(listeners.size).toBe(1);
      field.style.color = 'rgb(235, 235, 235)';
      act(() => listeners.forEach((fn) => fn()));
      expect(mirrorOf().style.color).toBe('rgb(235, 235, 235)');
    });
  });

  it('does not lay the layers out again for a render that changes nothing they show', () => {
    const { rerender } = render(<Harness start={`a ${token}`} />);
    const field = screen.getByLabelText('Message');
    const read = vi.spyOn(window, 'getComputedStyle');
    try {
      rerender(<Harness start={`a ${token}`} />);
      rerender(<Harness start={`a ${token}`} />);
      expect(read.mock.calls.filter(([el]) => el === field)).toHaveLength(0);
      // A change of the text does.
      type(field, `a ${token} b`);
      expect(read.mock.calls.filter(([el]) => el === field).length).toBeGreaterThan(0);
    } finally {
      read.mockRestore();
    }
  });

  it('adds a zero-width letter after a final line break, so the empty last line exists in the layer too', () => {
    render(<Harness start={`${token}\n`} />);
    expect(mirrorOf().textContent).toBe(`${token}\n\u200b`);
  });

  describe('alignment, as invariants jsdom can check without a layout engine', () => {
    const values = [
      `${token}`,
      `Hi ${token} and <@&${ROLE}> and @everyone`,
      `line one\n${token}\n\nline four ${token}`,
      `${token}\n`,
      `a ${token}\r\nb`,
      `<#12`,
    ];

    it.each(values)('the layer holds the field letters, one for one, for %j', (value) => {
      render(<Harness start={value} />);
      const mirror = mirrorOf();
      if (!mirror) {
        // No stored token (`<#12` is not one): no layer, and the field draws its own text.
        expect(screen.getByLabelText('Message').className).not.toContain('is-mirrored');
        return;
      }
      const field = screen.getByLabelText('Message');
      const expected = value.replace(/\r\n?/g, '\n');
      // Same letters in the same order (the one zero-width letter after a final break is not a letter of
      // the field); the tokens are inside spans and are never cut, replaced or reordered.
      expect(mirror.textContent.replace(/\u200b$/, '')).toBe(expected);
      expect(field.value.replace(/\r\n?/g, '\n')).toBe(expected);
      const tokens = [...mirror.querySelectorAll('[data-token]')].map((t) => t.textContent);
      expect(tokens).toEqual(expected.match(/<[#@]&?\d{17,20}>/g) ?? []);
      // One name per token, in the same order.
      expect(namesOf().querySelectorAll('.v2-mm-name')).toHaveLength(tokens.length);
    });

    it('syncMirror gives the layer the field box and every metric that decides where a letter lands', () => {
      const field = document.createElement('textarea');
      const mirror = document.createElement('div');
      document.body.append(field, mirror);
      Object.assign(field.style, {
        fontFamily: 'Georgia, serif',
        fontSize: '15px',
        fontWeight: '500',
        letterSpacing: '0.3px',
        wordSpacing: '1px',
        lineHeight: '22px',
        textIndent: '4px',
        textAlign: 'left',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        wordBreak: 'normal',
        padding: '9px 12px 7px 10px',
        borderStyle: 'solid',
        borderWidth: '1px 2px 3px 4px',
        color: 'rgb(1, 2, 3)',
      });
      try {
        syncMirror(field, mirror);
        const cs = window.getComputedStyle(field);
        for (const prop of [
          'fontFamily',
          'fontSize',
          'fontWeight',
          'letterSpacing',
          'wordSpacing',
          'lineHeight',
          'textIndent',
          'textAlign',
          'whiteSpace',
          'overflowWrap',
          'wordBreak',
          'paddingTop',
          'paddingLeft',
          'paddingBottom',
          'borderTopWidth',
          'borderLeftWidth',
          'borderBottomWidth',
          'color',
        ]) {
          expect(mirror.style[prop], prop).toBe(cs[prop]);
        }
        expect(mirror.style.width).toBe(`${field.offsetWidth}px`);
        expect(mirror.style.height).toBe(`${field.offsetHeight}px`);
        expect(mirror.style.left).toBe(`${field.offsetLeft}px`);
        expect(mirror.style.top).toBe(`${field.offsetTop}px`);
      } finally {
        field.remove();
        mirror.remove();
      }
    });

    it('the layer of names has no padding and no border, so its origin is the mirror outer corner', () => {
      const field = document.createElement('textarea');
      const names = document.createElement('div');
      document.body.append(field, names);
      field.style.padding = '9px 12px';
      field.style.border = '2px solid';
      try {
        syncMirror(field, names, { bare: true });
        expect(names.style.paddingTop).toBe('0px');
        expect(names.style.paddingLeft).toBe('0px');
        expect(names.style.borderLeftWidth).toBe('0px');
      } finally {
        field.remove();
        names.remove();
      }
    });
  });

  it('is not used for a single-line input', () => {
    function One() {
      const [value, setValue] = useState(`a ${token}`);
      return (
        <MemoryRouter initialEntries={[`/guilds/${GUILD}`]}>
          <Routes>
            <Route
              path="/guilds/:guildId"
              element={
                <MentionTextarea
                  as="input"
                  aria-label="Line"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  channels={channels}
                />
              }
            />
          </Routes>
        </MemoryRouter>
      );
    }
    render(<One />);
    expect(mirrorOf()).toBeNull();
  });

  describe('a token is one unit for the caret', () => {
    it('Backspace right after a token removes all of it and puts the caret where it was', () => {
      render(<Harness start={`hi ${token}`} />);
      const field = screen.getByLabelText('Message');
      caretAt(field, field.value.length);
      fireEvent.keyDown(field, { key: 'Backspace' });
      expect(field.value).toBe('hi ');
      expect(field.selectionStart).toBe(3);
      expect(mirrorOf()).toBeNull();
    });

    it('Delete right before a token removes all of it', () => {
      render(<Harness start={`${token} there`} />);
      const field = screen.getByLabelText('Message');
      caretAt(field, 0);
      fireEvent.keyDown(field, { key: 'Delete' });
      expect(field.value).toBe(' there');
    });

    it('Backspace elsewhere is left to the browser', () => {
      render(<Harness start={`hi ${token}`} />);
      const field = screen.getByLabelText('Message');
      caretAt(field, 2);
      expect(fireEvent.keyDown(field, { key: 'Backspace' })).toBe(true);
      expect(field.value).toBe(`hi ${token}`);
    });

    it('Backspace with a selection, or with Ctrl, is left to the browser', () => {
      render(<Harness start={`hi ${token}`} />);
      const field = screen.getByLabelText('Message');
      caretAt(field, 0, field.value.length);
      expect(fireEvent.keyDown(field, { key: 'Backspace' })).toBe(true);
      caretAt(field, field.value.length);
      expect(fireEvent.keyDown(field, { key: 'Backspace', ctrlKey: true })).toBe(true);
      expect(field.value).toBe(`hi ${token}`);
    });

    it('the arrow keys step over a token, and Shift selects all of it', () => {
      render(<Harness start={`a${token}b`} />);
      const field = screen.getByLabelText('Message');
      const end = 1 + token.length;
      caretAt(field, end);
      expect(fireEvent.keyDown(field, { key: 'ArrowLeft' })).toBe(false);
      expect([field.selectionStart, field.selectionEnd]).toEqual([1, 1]);
      expect(fireEvent.keyDown(field, { key: 'ArrowRight' })).toBe(false);
      expect([field.selectionStart, field.selectionEnd]).toEqual([end, end]);
      caretAt(field, end);
      fireEvent.keyDown(field, { key: 'ArrowLeft', shiftKey: true });
      expect([field.selectionStart, field.selectionEnd]).toEqual([1, end]);
      caretAt(field, 1);
      fireEvent.keyDown(field, { key: 'ArrowRight', shiftKey: true });
      expect([field.selectionStart, field.selectionEnd]).toEqual([1, end]);
    });

    it('plain arrows next to ordinary text are left to the browser', () => {
      render(<Harness start={`a${token}b`} />);
      const field = screen.getByLabelText('Message');
      caretAt(field, 0);
      expect(fireEvent.keyDown(field, { key: 'ArrowRight' })).toBe(true);
    });

    it('a click or a key that leaves the caret inside a token moves it to the nearer edge', () => {
      render(<Harness start={`a${token}b`} />);
      const field = screen.getByLabelText('Message');
      const end = 1 + token.length;
      caretAt(field, 4);
      fireEvent.mouseUp(field);
      expect(field.selectionStart).toBe(1);
      caretAt(field, end - 3);
      fireEvent.keyUp(field, { key: 'ArrowDown' });
      expect([field.selectionStart, field.selectionEnd]).toEqual([end, end]);
    });

    it('a selection that cuts a token takes all of it', () => {
      render(<Harness start={`a${token}b`} />);
      const field = screen.getByLabelText('Message');
      caretAt(field, 4, field.value.length);
      fireEvent.mouseUp(field);
      expect([field.selectionStart, field.selectionEnd]).toEqual([1, field.value.length]);
    });

    it('typing around a token leaves the caret where the typing put it', () => {
      render(<Harness start={token} />);
      const field = screen.getByLabelText('Message');
      field.focus();
      type(field, `${token} x`);
      fireEvent.keyUp(field, { key: 'x' });
      expect(field.selectionStart).toBe(token.length + 2);
      type(field, `y${token} x`);
      field.setSelectionRange(1, 1);
      fireEvent.keyUp(field, { key: 'y' });
      expect(field.selectionStart).toBe(1);
      expect(field.value).toBe(`y${token} x`);
    });

    it('does not move the caret or remove anything while an IME composes', () => {
      render(<Harness start={`a${token}`} />);
      const field = screen.getByLabelText('Message');
      const end = field.value.length;
      caretAt(field, end);
      fireEvent.compositionStart(field);
      expect(fireEvent.keyDown(field, { key: 'Backspace', isComposing: true })).toBe(true);
      expect(fireEvent.keyDown(field, { key: 'Backspace' })).toBe(true);
      caretAt(field, 4);
      fireEvent.keyUp(field, { key: 'a', isComposing: true });
      fireEvent.mouseUp(field);
      expect(field.value).toBe(`a${token}`);
      expect(field.selectionStart).toBe(4);
      // After the composition the guard is off again.
      fireEvent.compositionEnd(field);
      caretAt(field, end);
      fireEvent.keyDown(field, { key: 'Backspace' });
      expect(field.value).toBe('a');
    });

    it('removes a token for a delete intent from a keyboard that sends no key (a phone)', () => {
      render(<Harness start={`hi ${token}`} />);
      const field = screen.getByLabelText('Message');
      caretAt(field, field.value.length);
      const intent = new InputEvent('beforeinput', {
        inputType: 'deleteContentBackward',
        bubbles: true,
        cancelable: true,
      });
      field.dispatchEvent(intent);
      expect(intent.defaultPrevented).toBe(true);
      expect(field.value).toBe('hi ');
    });

    it('leaves a delete intent alone during composition and away from a token', () => {
      render(<Harness start={`hi ${token}`} />);
      const field = screen.getByLabelText('Message');
      caretAt(field, field.value.length);
      const inComposition = new InputEvent('beforeinput', {
        inputType: 'deleteContentBackward',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      field.dispatchEvent(inComposition);
      expect(inComposition.defaultPrevented).toBe(false);
      caretAt(field, 1);
      const away = new InputEvent('beforeinput', {
        inputType: 'deleteContentBackward',
        bubbles: true,
        cancelable: true,
      });
      field.dispatchEvent(away);
      expect(away.defaultPrevented).toBe(false);
      expect(field.value).toBe(`hi ${token}`);
    });
  });

  it('keeps the field readable in forced colours mode, and the layer never takes a click', () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'mention-mirror.css'),
      'utf8'
    );
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(forced).toMatch(/text-fill-color: currentColor/);
    expect(forced).toMatch(/\.v2-mention-mirror,\s*\.v2-mention-names \{\s*display: none/);
    expect(css).toMatch(/\.v2-mention-mirror \{[^}]*pointer-events: none/);
    expect(css).toMatch(/\.v2-mention-names \{[^}]*pointer-events: none/);
  });
});
