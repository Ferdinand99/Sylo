import { beforeEach, describe, expect, it } from 'vitest';
import {
  answerProblem,
  answerProblems,
  clearDraft,
  emptyAnswers,
  isEmptyAnswer,
  loadDraft,
  restoreDraft,
  saveDraft,
} from '../applicationAnswers.js';

const text = { id: 't', type: 'text', required: true, minLength: 5, maxLength: 20, options: [] };
const one = {
  id: 'one',
  type: 'choice',
  required: true,
  multiple: false,
  options: [{ id: 'a' }, { id: 'b' }],
};
const many = {
  id: 'many',
  type: 'choice',
  required: false,
  multiple: true,
  minChoices: 1,
  maxChoices: 2,
  options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
};
const yes = { id: 'y', type: 'yesno', required: true, options: [] };

describe('answers in the browser', () => {
  it('starts empty: text as a string, choices and roles as lists', () => {
    expect(emptyAnswers([text, one, many, yes])).toEqual({ t: '', one: [], many: [], y: '' });
    expect(isEmptyAnswer('  ')).toBe(true);
    expect(isEmptyAnswer([])).toBe(true);
    expect(isEmptyAnswer(['a'])).toBe(false);
  });

  it('says what is wrong with an answer, and nothing about an optional one left empty', () => {
    expect(answerProblem(text, '')).toMatch(/required/);
    expect(answerProblem(text, 'abc')).toMatch(/at least 5/);
    expect(answerProblem(text, 'x'.repeat(21))).toMatch(/limit is 20/);
    expect(answerProblem(text, 'a good one')).toBeNull();
    expect(answerProblem(one, [])).toMatch(/required/);
    expect(answerProblem(one, ['a', 'b'])).toMatch(/only one/i);
    expect(answerProblem(many, [])).toBeNull();
    expect(answerProblem(many, ['a', 'b', 'c'])).toMatch(/at most 2/);
    expect(answerProblems([text, one, yes], { t: 'abc', one: ['a'], y: '' })).toEqual({
      t: expect.stringMatching(/at least 5/),
      y: expect.stringMatching(/required/),
    });
  });

  describe('drafts', () => {
    beforeEach(() => window.localStorage.clear());

    it('are kept in this browser, loaded back, and cleared', () => {
      expect(loadDraft('g', 1)).toBeNull();
      saveDraft('g', 1, 5, { t: 'half an ans' });
      expect(loadDraft('g', 1)).toEqual({ version: 5, answers: { t: 'half an ans' } });
      expect(loadDraft('g', 2)).toBeNull();
      clearDraft('g', 1);
      expect(loadDraft('g', 1)).toBeNull();
    });

    it('survive blocked storage without breaking the page', () => {
      const real = window.localStorage;
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new Error('blocked');
        },
      });
      try {
        expect(() => saveDraft('g', 1, 1, {})).not.toThrow();
        expect(loadDraft('g', 1)).toBeNull();
        expect(() => clearDraft('g', 1)).not.toThrow();
      } finally {
        Object.defineProperty(window, 'localStorage', { configurable: true, value: real });
      }
    });

    it('restore only the answers that still fit the questions as they are now', () => {
      const draft = {
        version: 1,
        answers: { t: 'kept text', one: ['gone', 'a'], many: 'not a list', old: 'removed question' },
      };
      expect(restoreDraft([text, one, many], draft)).toEqual({ t: 'kept text', one: ['a'], many: [] });
    });
  });
});
