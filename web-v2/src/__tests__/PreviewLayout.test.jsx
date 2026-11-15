import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PreviewLayout from '../components/PreviewLayout.jsx';
import MessagePreview from '../components/MessagePreview.jsx';

const CH = '100000000000000021';
const ROLE = '200000000000000031';
const lookup = { channels: [{ id: CH, name: 'general' }], roles: [{ id: ROLE, name: 'Verified' }] };

function stubMedia(matches) {
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}
afterEach(() => {
  delete window.matchMedia;
});

const wrap = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('MessagePreview', () => {
  it('fills placeholders with sample data and shows mentions as names', () => {
    wrap(<MessagePreview content={`Welcome {user} to **{server}**, say hi in <#${CH}>`} lookup={lookup} />);
    const text = screen.getByText((_, el) => el?.className === 'v2-msg-text');
    expect(text.textContent).toBe('Welcome @Mara to Your server, say hi in #general');
    expect(text.querySelector('strong').textContent).toBe('Your server');
    expect(text.textContent).not.toContain(CH);
    expect(screen.getByText('Sylo')).toBeTruthy();
  });

  it('draws an embed with its description and fields', () => {
    wrap(
      <MessagePreview
        embed={{
          title: 'Mara',
          description: 'Hello {user.name}',
          fields: [{ name: 'Craft', value: 'Pixel art', inline: true }],
          footer: 'Say hi',
        }}
      />
    );
    expect(screen.getByText('Hello Mara')).toBeTruthy();
    expect(screen.getByText('Craft')).toBeTruthy();
    expect(screen.getByText('Say hi')).toBeTruthy();
  });

  it('says so when there is nothing to send', () => {
    wrap(<MessagePreview content="  " />);
    expect(screen.getByText('Nothing to send yet.')).toBeTruthy();
  });
});

describe('PreviewLayout', () => {
  const previews = [
    { key: 'join', title: 'Welcome message', content: 'Hi {user}' },
    { key: 'leave', title: 'Leave message', content: 'Bye', hidden: true },
  ];

  it('puts the previews in a column next to the form on a wide screen, leaving out hidden ones', () => {
    stubMedia(true);
    wrap(
      <PreviewLayout previews={previews} lookup={lookup}>
        <p>the form</p>
      </PreviewLayout>
    );
    const aside = screen.getByRole('complementary', { name: 'Preview' });
    expect(within(aside).getByText('Welcome message')).toBeTruthy();
    expect(aside.textContent).toContain('Hi @Mara');
    expect(within(aside).queryByText('Leave message')).toBeNull();
    expect(screen.getByText('the form')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show preview' })).toBeNull();
  });

  it('folds the preview behind a button on a narrow screen', () => {
    stubMedia(false);
    wrap(
      <PreviewLayout previews={previews} lookup={lookup}>
        <p>the form</p>
      </PreviewLayout>
    );
    expect(screen.queryByRole('complementary')).toBeNull();
    const button = screen.getByRole('button', { name: 'Show preview' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(screen.getByRole('complementary', { name: 'Preview' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide preview' })).toBeTruthy();
  });

  for (const [name, wide] of [
    ['wide', true],
    ['narrow', false],
  ]) {
    it(`never remounts the form when a preview appears or goes away (${name}): the field keeps its focus`, () => {
      stubMedia(wide);
      const form = (
        <>
          <h1>Title</h1>
          <p>Intro</p>
          <input id="field" aria-label="field" defaultValue="typed" />
        </>
      );
      const shown = [{ key: 'a', title: 'A', content: 'hi' }];
      const hidden = [{ key: 'a', title: 'A', content: 'hi', hidden: true }];
      const { rerender } = wrap(
        <PreviewLayout previews={hidden} lookup={lookup}>
          {form}
        </PreviewLayout>
      );
      const field = screen.getByLabelText('field');
      field.focus();
      field.value = 'half-typed';
      expect(document.activeElement).toBe(field);

      rerender(
        <MemoryRouter>
          <PreviewLayout previews={shown} lookup={lookup}>
            {form}
          </PreviewLayout>
        </MemoryRouter>
      );
      expect(screen.getByLabelText('field')).toBe(field);
      expect(document.activeElement).toBe(field);
      expect(field.value).toBe('half-typed');

      rerender(
        <MemoryRouter>
          <PreviewLayout previews={hidden} lookup={lookup}>
            {form}
          </PreviewLayout>
        </MemoryRouter>
      );
      expect(screen.getByLabelText('field')).toBe(field);
      expect(document.activeElement).toBe(field);
    });
  }

  it('puts the "Show preview" button after the introduction, not above the title', () => {
    stubMedia(false);
    wrap(
      <PreviewLayout previews={previews} lookup={lookup}>
        <>
          <h1>Title</h1>
          <p>Intro</p>
          <form>the form</form>
        </>
      </PreviewLayout>
    );
    const order = [...document.querySelector('.v2-with-preview-main').children].map((el) => el.tagName);
    expect(order).toEqual(['H1', 'P', 'DIV', 'FORM']);
    expect(document.querySelector('.v2-with-preview-main > .v2-preview-toggle button').textContent).toBe(
      'Show preview'
    );
  });

  it('renders just the form when every preview is hidden', () => {
    stubMedia(true);
    wrap(
      <PreviewLayout previews={[{ key: 'a', title: 'A', content: 'x', hidden: true }]} lookup={lookup}>
        <p>the form</p>
      </PreviewLayout>
    );
    expect(screen.getByText('the form')).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('button', { name: /preview/i })).toBeNull();
  });
});
