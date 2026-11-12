import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Apply from '../pages/Apply.jsx';

vi.mock('../api.js', () => {
  class ApiError extends Error {
    constructor(message, { status, notAuthenticated = false, body } = {}) {
      super(message);
      this.status = status;
      this.notAuthenticated = notAuthenticated;
      this.view = body?.view;
      this.errors = body?.errors;
    }
  }
  return { ApiError, getWebApply: vi.fn(), submitWebApply: vi.fn(), withdrawWebApply: vi.fn() };
});
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const api = await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');
const { notify } = await import('../notify.js');

const GUILD = '123456789012345678';
const FORM = 7;

const base = {
  long: false,
  minLength: 0,
  maxLength: 300,
  multiple: false,
  minChoices: 0,
  maxChoices: 1,
  options: [],
};
const questions = [
  {
    ...base,
    id: 'q_text',
    type: 'text',
    label: 'Why do you want to join?',
    help: 'Be honest',
    required: true,
    long: true,
    minLength: 5,
    maxLength: 200,
  },
  {
    ...base,
    id: 'q_pick',
    type: 'choice',
    label: 'Favourite colour',
    required: true,
    options: [
      { id: 'red', label: 'Red' },
      { id: 'blue', label: 'Blue' },
    ],
  },
  {
    ...base,
    id: 'q_multi',
    type: 'choice',
    label: 'Hobbies',
    required: false,
    multiple: true,
    minChoices: 1,
    maxChoices: 2,
    options: [
      { id: 'a', label: 'Chess' },
      { id: 'b', label: 'Go' },
      { id: 'c', label: 'Hiking' },
    ],
  },
  { ...base, id: 'q_yes', type: 'yesno', label: 'Over 18?', required: true },
];
const view = (over = {}) => ({
  guild: { name: 'Hedgerow', id: GUILD },
  form: {
    id: FORM,
    name: 'Staff',
    description: 'Join the team',
    version: 100,
    intro: 'Applying for Staff in Hedgerow.',
  },
  pending: null,
  problem: null,
  questions,
  ...over,
});

function renderPage() {
  const router = createMemoryRouter([{ path: '/apply/:guildId/:formId', element: <Apply /> }], {
    initialEntries: [`/apply/${GUILD}/${FORM}`],
  });
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  confirmDialog.mockResolvedValue(true);
  api.getWebApply.mockResolvedValue(view());
});

const fill = async () => {
  fireEvent.change(await screen.findByLabelText(/Why do you want to join/), {
    target: { value: 'I like hedges a lot' },
  });
  fireEvent.click(screen.getByLabelText('Blue'));
  fireEvent.click(screen.getByLabelText('Go'));
  fireEvent.click(screen.getByLabelText('Yes'));
};

describe('the web form of an application', () => {
  it('shows the form, its questions of every kind, and says the draft stays in the browser', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Staff' })).toBeTruthy();
    expect(api.getWebApply).toHaveBeenCalledWith(GUILD, String(FORM));
    expect(screen.getByText('Join the team')).toBeTruthy();
    expect(await screen.findByText('Be honest')).toBeTruthy();
    expect(screen.getAllByRole('radio').length).toBe(4); // two colours, yes and no
    expect(screen.getAllByRole('checkbox').length).toBe(3); // the hobbies
    expect(screen.getByText(/saved in this browser only/)).toBeTruthy();
    expect(screen.getByText('Hobbies').parentElement.textContent).toMatch(/optional/);
  });

  it('checks required answers in the browser first and sends nothing until they are fine', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Submit application' }));
    expect(api.submitWebApply).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').length).toBe(3);
    expect(notify).toHaveBeenCalled();
  });

  it('submits the answers as ids and lists, with the version it showed, and then shows the waiting application', async () => {
    api.submitWebApply.mockResolvedValue({
      ok: true,
      id: 9,
      view: view({ pending: { id: 9, createdAt: 1700000000000 }, questions: [] }),
    });
    renderPage();
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
    await waitFor(() => expect(api.submitWebApply).toHaveBeenCalled());
    expect(api.submitWebApply).toHaveBeenCalledWith(
      GUILD,
      String(FORM),
      { q_text: 'I like hedges a lot', q_pick: ['blue'], q_multi: ['b'], q_yes: 'yes' },
      100
    );
    expect(await screen.findByText(/Waiting for a decision/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit application' })).toBeNull();
    expect(window.localStorage.getItem(`sylo-apply-draft:${GUILD}:${FORM}`)).toBeNull();
  });

  it('keeps a draft in this browser only: it is saved as the member types, restored later, and never sent', async () => {
    const first = renderPage();
    fireEvent.change(await screen.findByLabelText(/Why do you want to join/), {
      target: { value: 'half an answer' },
    });
    await waitFor(() =>
      expect(window.localStorage.getItem(`sylo-apply-draft:${GUILD}:${FORM}`)).toContain('half an answer')
    );
    expect(api.submitWebApply).not.toHaveBeenCalled();
    first.unmount();
    renderPage();
    expect((await screen.findByLabelText(/Why do you want to join/)).value).toBe('half an answer');
    expect(screen.getByText(/draft from this browser was restored/)).toBeTruthy();
  });

  it("shows the server's messages under the questions when the answers are refused", async () => {
    const { ApiError } = api;
    api.submitWebApply.mockRejectedValue(
      new ApiError('Some answers are not valid.', {
        status: 400,
        body: { errors: { q_text: 'That is 5 characters, and at least 50 are needed.' }, view: view() },
      })
    );
    renderPage();
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
    expect(await screen.findByText(/at least 50 are needed/)).toBeTruthy();
    expect(notify).toHaveBeenCalledWith('Some answers are not valid.');
    // what was typed stays
    expect(screen.getByLabelText(/Why do you want to join/).value).toBe('I like hedges a lot');
  });

  it("keeps the member's answers when the form was changed, and says so", async () => {
    window.localStorage.setItem(
      `sylo-apply-draft:${GUILD}:${FORM}`,
      JSON.stringify({
        version: 100,
        answers: { q_text: 'typed before', q_pick: [], q_multi: [], q_yes: '' },
      })
    );
    api.getWebApply.mockResolvedValue(view({ form: { ...view().form, version: 200 } }));
    renderPage();
    expect(await screen.findByText(/form was changed since you saved this draft/)).toBeTruthy();
    expect(screen.getByLabelText(/Why do you want to join/).value).toBe('typed before');
  });

  it('tells a member who does not meet a requirement why, without the questions', async () => {
    api.getWebApply.mockResolvedValue(
      view({
        problem: { reason: 'account_age', text: 'Your account must be at least 30 days old.' },
        questions: [],
      })
    );
    renderPage();
    expect(await screen.findByText('Your account must be at least 30 days old.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit application' })).toBeNull();
  });

  it('lets a member withdraw a pending application after a confirmation', async () => {
    api.getWebApply.mockResolvedValue(
      view({
        pending: { id: 4, createdAt: 1700000000000 },
        problem: { reason: 'pending', text: 'You already have an application.' },
        questions: [],
      })
    );
    api.withdrawWebApply.mockResolvedValue({ ok: true, id: 4, view: view() });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw my application' }));
    await waitFor(() => expect(api.withdrawWebApply).toHaveBeenCalledWith(GUILD, String(FORM)));
    expect(confirmDialog).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Submit application' })).toBeTruthy();
  });

  it('shows the one "Nothing here" page for a 404, and a sign-in link for a signed-out visitor', async () => {
    const { ApiError } = api;
    api.getWebApply.mockRejectedValue(new ApiError('Not found', { status: 404 }));
    const first = renderPage();
    expect(await screen.findByText('Nothing here')).toBeTruthy();
    first.unmount();
    api.getWebApply.mockRejectedValue(new ApiError('Not signed in', { status: 401, notAuthenticated: true }));
    renderPage();
    expect(await screen.findByRole('link', { name: 'sign in again' })).toBeTruthy();
  });
});
