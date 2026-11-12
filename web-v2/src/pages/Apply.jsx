import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, getWebApply, submitWebApply, withdrawWebApply } from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import ApplicationQuestion from '../components/ApplicationQuestion.jsx';
import Time from '../components/Time.jsx';
import {
  answerProblems,
  clearDraft,
  emptyAnswers,
  loadDraft,
  restoreDraft,
  saveDraft,
} from '../applicationAnswers.js';

/** The one answer for every visitor who may not use the page: nothing here, and no hint why. */
function Nothing() {
  return (
    <div className="v2-state v2-route-error" role="status">
      <p>Nothing here</p>
      <p className="v2-field-hint">There is nothing at this address. The link may be old or mistyped.</p>
    </div>
  );
}

/**
 * The web form of an application (/apply/<server>/<form>): the member's answers, checked on the server
 * with the same code as the DM questionnaire. A draft is kept in this browser only (localStorage),
 * never on the server, and removed once the form is submitted.
 */
export default function Apply() {
  const { guildId, formId } = useParams();
  const { data, error, setData } = useApiData(() => getWebApply(guildId, formId), [guildId, formId]);
  const [answers, setAnswers] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [withdrawn, setWithdrawn] = useState(false);
  const loadedFor = useRef(null);

  // Once the form is here: start from the draft of this browser, if there is one.
  useEffect(() => {
    if (!data || data.problem || data.pending || loadedFor.current === `${data.form.id}:${data.form.version}`)
      return;
    loadedFor.current = `${data.form.id}:${data.form.version}`;
    const draft = loadDraft(guildId, data.viewer, formId);
    setAnswers(draft ? restoreDraft(data.questions, draft) : emptyAnswers(data.questions));
    setNote(
      draft && draft.version !== data.form.version
        ? 'The form was changed since you saved this draft. Check your answers.'
        : draft
          ? 'Your draft from this browser was restored.'
          : ''
    );
  }, [data, guildId, formId]);

  // Save the draft as it changes (in this browser only).
  useEffect(() => {
    if (data && answers && !data.problem) saveDraft(guildId, data.viewer, formId, data.form.version, answers);
  }, [answers, data, guildId, formId]);

  if (error) {
    if (error instanceof ApiError && error.notAuthenticated) {
      return (
        <p className="v2-state">
          Your session expired — <a href="/auth/login">sign in again</a>.
        </p>
      );
    }
    // 404 (and every other refusal) reads the same.
    return <Nothing />;
  }
  if (!data) return <p className="v2-state">Loading…</p>;

  async function onSubmit(e) {
    e.preventDefault();
    const local = answerProblems(data.questions, answers);
    setErrors(local);
    if (Object.keys(local).length) {
      notify('Some answers need a look.');
      return;
    }
    setBusy(true);
    try {
      const out = await submitWebApply(guildId, formId, answers, data.form.version);
      clearDraft(guildId, data.viewer, formId);
      loadedFor.current = null;
      setData(out.view);
      setAnswers(null);
      notify('Your application was submitted.', 'info');
    } catch (err) {
      if (err.view) setData(err.view);
      setErrors(err.errors ?? {});
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onWithdraw() {
    const ok = await confirmDialog({
      title: 'Withdraw your application?',
      body: 'Staff will see it as withdrawn. You can apply again afterwards.',
      confirmLabel: 'Withdraw',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const out = await withdrawWebApply(guildId, formId);
      // a closed form has no page to go back to
      if (out.view) setData(out.view);
      else setWithdrawn(true);
      notify('Your application was withdrawn.', 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (withdrawn) return <p className="v2-state">Your application was withdrawn.</p>;
  const { form, pending, problem } = data;
  return (
    <>
      <h1 className="v2-section-title">{form.name}</h1>
      <p className="v2-field-hint">in {data.guild.name}</p>
      {form.description ? <p>{form.description}</p> : null}

      {pending ? (
        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">Waiting for a decision</h2>
          <p>
            Your application <strong>#{pending.id}</strong> was sent <Time value={pending.createdAt} />. Staff
            will decide on it.
          </p>
          <button type="button" className="v2-btn-danger-ghost" disabled={busy} onClick={onWithdraw}>
            Withdraw my application
          </button>
        </div>
      ) : null}

      {problem && !pending ? (
        <p className="v2-note" role="status">
          {problem.text}
        </p>
      ) : null}

      {!problem && !pending && answers ? (
        <form onSubmit={onSubmit} className="v2-section-gap" noValidate>
          {form.intro ? <p className="v2-field-hint">{form.intro}</p> : null}
          {note ? (
            <p className="v2-note" role="status">
              {note}
            </p>
          ) : null}
          {data.questions.map((q) => (
            <ApplicationQuestion
              key={q.id}
              q={q}
              value={answers[q.id]}
              error={errors[q.id]}
              disabled={busy}
              onChange={(value) => {
                setAnswers((a) => ({ ...a, [q.id]: value }));
                setErrors((er) => ({ ...er, [q.id]: undefined }));
              }}
            />
          ))}
          <p className="v2-field-hint">Your draft is saved in this browser only, not on the server.</p>
          <button type="submit" className="v2-btn-primary" disabled={busy}>
            Submit application
          </button>
        </form>
      ) : null}
    </>
  );
}
