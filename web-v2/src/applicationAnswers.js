// The member's side of an application form: what an empty answer is, and a first check in the browser
// that gives instant feedback. The server checks everything again (src/modules/lib/applicationsForm.js,
// the same code the DM questionnaire uses); nothing here decides anything.

/** The starting value of an answer: a list of option ids for choices and roles, text otherwise. */
export const emptyAnswer = (q) => (q.type === 'choice' || q.type === 'role' ? [] : '');

export const emptyAnswers = (questions) => Object.fromEntries(questions.map((q) => [q.id, emptyAnswer(q)]));

export const isEmptyAnswer = (value) =>
  Array.isArray(value) ? value.length === 0 : String(value ?? '').trim() === '';

/** What is wrong with an answer, in words, or null. */
export function answerProblem(q, value) {
  if (isEmptyAnswer(value)) return q.required ? 'This question is required.' : null;
  if (q.type === 'text') {
    const text = String(value).trim();
    if (text.length > q.maxLength)
      return `That is ${text.length} characters, and the limit is ${q.maxLength}.`;
    if (text.length < q.minLength) {
      return `That is ${text.length} characters, and at least ${q.minLength} are needed.`;
    }
    return null;
  }
  if (q.type === 'choice' || q.type === 'role') {
    if (q.multiple) {
      if (value.length > q.maxChoices) return `Choose at most ${q.maxChoices}.`;
      if (value.length < q.minChoices) return `Choose at least ${q.minChoices}.`;
    } else if (value.length > 1) return 'Choose only one option.';
  }
  return null;
}

/** The problem of every answer that has one, by question id. */
export function answerProblems(questions, answers) {
  const out = {};
  for (const q of questions) {
    const problem = answerProblem(q, answers[q.id]);
    if (problem) out[q.id] = problem;
  }
  return out;
}

const draftKey = (guildId, formId) => `sylo-apply-draft:${guildId}:${formId}`;

/** A draft saved in this browser, or null. Drafts never leave the browser; storage may be blocked. */
export function loadDraft(guildId, formId) {
  try {
    const raw = window.localStorage.getItem(draftKey(guildId, formId));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && parsed.answers ? parsed : null;
  } catch {
    return null;
  }
}

export function saveDraft(guildId, formId, version, answers) {
  try {
    window.localStorage.setItem(draftKey(guildId, formId), JSON.stringify({ version, answers }));
  } catch {
    // storage blocked or full: the draft is a convenience
  }
}

export function clearDraft(guildId, formId) {
  try {
    window.localStorage.removeItem(draftKey(guildId, formId));
  } catch {
    // nothing to clear
  }
}

/** The saved answers that still fit the questions as they are now (same id and type). */
export function restoreDraft(questions, draft) {
  const out = emptyAnswers(questions);
  for (const q of questions) {
    const saved = draft?.answers?.[q.id];
    if (saved === undefined) continue;
    if (Array.isArray(out[q.id])) {
      if (Array.isArray(saved)) out[q.id] = saved.filter((id) => q.options.some((o) => o.id === id));
    } else if (typeof saved === 'string') out[q.id] = saved;
  }
  return out;
}
