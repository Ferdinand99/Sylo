import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AutoGrowTextarea, { resizeToContent } from '../components/AutoGrowTextarea.jsx';

// jsdom does no layout, so scrollHeight is always 0: fake a height that follows the line count.
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
function fakeLineHeight(px) {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return (this.value ?? '').split('\n').length * px;
    },
  });
}
afterEach(() => {
  if (original) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original);
  else delete HTMLElement.prototype.scrollHeight;
});

describe('resizeToContent', () => {
  it('sets the height from scrollHeight', () => {
    fakeLineHeight(20);
    const el = document.createElement('textarea');
    el.value = 'one\ntwo\nthree';
    resizeToContent(el);
    expect(el.style.height).toBe('60px');
  });

  it('does nothing without an element', () => {
    expect(() => resizeToContent(null)).not.toThrow();
  });
});

describe('AutoGrowTextarea', () => {
  it('is tall enough for a multi-line value as soon as it renders', () => {
    fakeLineHeight(20);
    render(<AutoGrowTextarea aria-label="Description" value={'a\nb\nc\nd'} onChange={() => {}} />);
    expect(screen.getByLabelText('Description').style.height).toBe('80px');
  });

  it('grows when the value changes from outside and when typing', () => {
    fakeLineHeight(20);
    function Harness() {
      const [v, setV] = useState('one');
      return (
        <>
          <AutoGrowTextarea aria-label="Text" value={v} onChange={(e) => setV(e.target.value)} />
          <button type="button" onClick={() => setV('x\ny\nz')}>
            fill
          </button>
        </>
      );
    }
    render(<Harness />);
    const box = screen.getByLabelText('Text');
    expect(box.style.height).toBe('20px');
    fireEvent.change(box, { target: { value: 'one\ntwo' } });
    expect(box.style.height).toBe('40px');
    fireEvent.click(screen.getByText('fill'));
    expect(box.style.height).toBe('60px');
  });

  it('keeps the caller classes, rows and handlers', () => {
    let focused = false;
    render(
      <AutoGrowTextarea
        aria-label="Text"
        className="v2-embed-input"
        value=""
        onChange={() => {}}
        onFocus={() => {
          focused = true;
        }}
      />
    );
    const box = screen.getByLabelText('Text');
    expect(box.className).toBe('v2-autogrow v2-embed-input');
    expect(box.getAttribute('rows')).toBe('1');
    fireEvent.focus(box);
    expect(focused).toBe(true);
  });
});
