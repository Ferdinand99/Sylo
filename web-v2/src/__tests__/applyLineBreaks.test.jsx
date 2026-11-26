import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Apply from '../pages/Apply.jsx';

// A server admin writes a form's description, its questions and their help with line breaks. The web
// form must show them as lines (white-space: pre-line through .v2-pre-line), not joined into one.

vi.mock('../api.js', () => {
  class ApiError extends Error {}
  return { ApiError, getWebApply: vi.fn(), submitWebApply: vi.fn(), withdrawWebApply: vi.fn() };
});
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
const api = await import('../api.js');

const GUILD = '123456789012345678';
const question = {
  id: 'q_text',
  type: 'text',
  label: 'Why do you want to join?\nTell us about yourself.',
  help: 'Be honest.\nNo wrong answers.',
  required: true,
  long: true,
  minLength: 0,
  maxLength: 300,
  multiple: false,
  minChoices: 0,
  maxChoices: 1,
  options: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  api.getWebApply.mockResolvedValue({
    guild: { name: 'Hedgerow', id: GUILD },
    viewer: '700000000000000010',
    form: { id: 7, name: 'Staff', description: 'Join the team.\nWe meet on Fridays.', version: 1, intro: '' },
    pending: null,
    problem: null,
    questions: [question],
  });
});

function renderPage() {
  const router = createMemoryRouter([{ path: '/apply/:guildId/:formId', element: <Apply /> }], {
    initialEntries: [`/apply/${GUILD}/7`],
  });
  return render(<RouterProvider router={router} />);
}

const hasPreLine = (el) => el.classList.contains('v2-pre-line');
const exact = (text) => (_content, el) => el?.textContent === text && el.children.length === 0;

describe('line breaks on the web form of an application', () => {
  it('keeps them in the description, the question and its help', async () => {
    renderPage();
    const description = await screen.findByText(exact('Join the team.\nWe meet on Fridays.'));
    expect(hasPreLine(description)).toBe(true);

    // The questions come once the answers are set up (an effect after the data arrives).
    const help = await screen.findByText(exact('Be honest.\nNo wrong answers.'));
    expect(hasPreLine(help)).toBe(true);

    const label = document.getElementById('q-q_text-label');
    expect(label.textContent).toContain('Why do you want to join?\nTell us about yourself.');
    expect(hasPreLine(label)).toBe(true);
  });

  it('the stylesheet keeps line breaks for .v2-pre-line', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8');
    expect(css.replace(/\r\n/g, '\n')).toMatch(/\.v2-pre-line \{\n {2}white-space: pre-line;\n\}/);
  });
});
