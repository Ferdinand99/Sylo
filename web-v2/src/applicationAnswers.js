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

// A draft belongs to a person (their id in that server), a server and a form, so on a shared computer
// the next person to sign in never sees it.
const DRAFT_PREFIX = 'sylo-apply-draft:';
const draftKey = (guildId, viewer, formId) => `${DRAFT_PREFIX}${guildId}:${viewer}:${formId}`;

/** A draft saved in this browser, or null. Drafts never leave the browser; storage may be blocked. */
export function loadDraft(guildId, viewer, formId) {
  try {
    const raw = window.localStorage.getItem(draftKey(guildId, viewer, formId));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && parsed.answers ? parsed : null;
  } catch {
    return null;
  }
}

export function saveDraft(guildId, viewer, formId, version, answers) {
  try {
    window.localStorage.setItem(draftKey(guildId, viewer, formId), JSON.stringify({ version, answers }));
  } catch {
    // storage blocked or full: the draft is a convenience
  }
}

export function clearDraft(guildId, viewer, formId) {
  try {
    window.localStorage.removeItem(draftKey(guildId, viewer, formId));
  } catch {
    // nothing to clear
  }
}

/** Remove every draft of this browser (signing out). */
export function clearAllDrafts() {
  try {
    const keys = [];
    for (let i = 0; i < window.localStorage.length; i += 1) keys.push(window.localStorage.key(i));
    for (const key of keys) if (key?.startsWith(DRAFT_PREFIX)) window.localStorage.removeItem(key);
  } catch {
    // storage blocked: there is nothing stored to clear
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
