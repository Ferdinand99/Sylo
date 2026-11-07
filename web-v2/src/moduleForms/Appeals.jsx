import { Link } from 'react-router-dom';
import AutoGrowTextarea from '../components/AutoGrowTextarea.jsx';
import Callout from '../components/Callout.jsx';
import HowItWorks from '../components/HowItWorks.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { useOperator } from '../useOperator.js';
import UnitInput from '../components/UnitInput.jsx';

const QUESTION_SLOTS = 5;

function padQuestions(questions) {
  const padded = [...questions];
  while (padded.length < QUESTION_SLOTS) padded.push('');
  return padded.slice(0, QUESTION_SLOTS);
}

/** The questions with the one at `index` swapped with its neighbour (`by` is -1 or 1). */
export function moveQuestion(questions, index, by) {
  const to = index + by;
  if (index < 0 || index >= questions.length || to < 0 || to >= questions.length) return questions;
  const next = [...questions];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** The questions without the one at `index`; the ones below move up and the slots stay five. */
export function removeQuestion(questions, index) {
  return padQuestions(questions.filter((_, i) => i !== index));
}

// A question is one line: a pasted line break becomes a space, and Enter does not add one.
const oneLine = (text) => text.replace(/\s*[\r\n]+\s*/g, ' ');

const toForm = (config) => ({ ...config, questions: padQuestions(config.questions) });

export default function Appeals() {
  const limits = useModuleLimits('appeals');
  const { guildId, data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm(
    'appeals',
    {
      toForm,
    }
  );

  const operator = useOperator();

  if (status === 'error') return <LoadError error={error} what="Ban appeals settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setQuestion = (i, value) =>
    setForm((f) => ({ ...f, questions: f.questions.map((q, idx) => (idx === i ? value : q)) }));
  const move = (i, by) => setForm((f) => ({ ...f, questions: moveQuestion(f.questions, i, by) }));
  const remove = (i) => setForm((f) => ({ ...f, questions: removeQuestion(f.questions, i) }));

  return (
    <>
      <h1 className="v2-section-title">Ban appeals</h1>
      <p className="v2-field-hint">
        When a member is banned, Sylo DMs them a private link to an appeal form. Their answers show up on the{' '}
        <Link to={`/guilds/${guildId}/appeals`}>Appeals page</Link>.
      </p>
      <HowItWorks title="Why a link?">
        <p>
          A bot can't message someone it no longer shares a server with, so the decision can't be sent to a
          banned member as a DM. Instead the appeal link shows the decision (and, when an appeal is accepted,
          a single-use rejoin invite) every time they reopen it.
        </p>
      </HowItWorks>
      {!data.dashboardUrlSet ? (
        <Callout tone="warning">
          <p>
            Appeal links can't be created yet: this Sylo doesn't know the web address members should use. The
            bot owner needs to set it.
          </p>
          {operator ? (
            <p className="v2-callout-owner">
              For the bot owner: set <code>DASHBOARD_URL</code> to an address your members can reach.
            </p>
          ) : null}
        </Callout>
      ) : null}

      <form onSubmit={save} data-savebar>
        <div className="v2-field">
          <label>
            Appeal form questions <span className="v2-field-hint">— 1 to 5; blank rows are dropped</span>
          </label>
          {form.questions.map((q, i) => (
            <div className="v2-question-row" key={i}>
              <AutoGrowTextarea
                aria-label={`Question ${i + 1}`}
                maxLength={limitOf(limits, 'questions[]').maxLength}
                placeholder={`Question ${i + 1}${i === 0 ? ' (required)' : ' (optional)'}`}
                value={q}
                onChange={(e) => setQuestion(i, oneLine(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.preventDefault();
                }}
              />
              <div className="v2-question-actions">
                <button
                  type="button"
                  className="v2-btn-ghost"
                  title="Move up"
                  aria-label={`Move question ${i + 1} up`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <span aria-hidden="true">↑</span>
                </button>
                <button
                  type="button"
                  className="v2-btn-ghost"
                  title="Move down"
                  aria-label={`Move question ${i + 1} down`}
                  disabled={i === form.questions.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <span aria-hidden="true">↓</span>
                </button>
                <button
                  type="button"
                  className="v2-btn-ghost"
                  title="Remove question"
                  aria-label={`Remove question ${i + 1}`}
                  disabled={!q.trim()}
                  onClick={() => remove(i)}
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.autoUnbanOnAccept}
              onChange={(e) => set({ autoUnbanOnAccept: e.target.checked })}
            />
            Lift the ban automatically when an appeal is accepted
          </label>
        </div>

        <div className="v2-field">
          <label htmlFor="reviewChannelId">
            Staff review channel{' '}
            <span className="v2-field-hint">— optional; gets new-appeal and decision notices</span>
          </label>
          <select
            id="reviewChannelId"
            value={form.reviewChannelId}
            onChange={(e) => set({ reviewChannelId: e.target.value })}
          >
            <option value="">— none —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="v2-field">
          <label htmlFor="cooldownDays">Cooldown after a denied appeal</label>
          <UnitInput
            id="cooldownDays"
            unit="days"
            min={limitOf(limits, 'cooldownDays').min}
            max={limitOf(limits, 'cooldownDays').max}
            value={form.cooldownDays}
            onChange={(e) => set({ cooldownDays: Number(e.target.value) })}
          />
          <p className="v2-field-hint">0 lets them appeal again straight away.</p>
        </div>

        <div className="v2-field">
          <label htmlFor="appealMessage">
            Extra line in the ban DM <span className="v2-field-hint">— optional</span>
          </label>
          <textarea
            id="appealMessage"
            rows={2}
            maxLength={limitOf(limits, 'appealMessage').maxLength}
            placeholder="e.g. Appeals are reviewed within 48 hours."
            value={form.appealMessage}
            onChange={(e) => set({ appealMessage: e.target.value })}
          />
        </div>

        <div className="v2-field">
          <label htmlFor="appealServerInvite">
            Appeals server invite <span className="v2-field-hint">— optional</span>
          </label>
          <input
            id="appealServerInvite"
            type="text"
            maxLength={limitOf(limits, 'appealServerInvite').maxLength}
            placeholder="https://discord.gg/…"
            value={form.appealServerInvite}
            onChange={(e) => set({ appealServerInvite: e.target.value })}
          />
          <p className="v2-field-hint">
            A permanent invite to another server Sylo is in. If the banned user joins it, Sylo shares a server
            with them and can also DM the decision.
          </p>
        </div>
      </form>

      <p className="v2-field-hint v2-section-gap">
        Sylo needs <strong>Ban Members</strong> to read ban reasons and auto-unban on accept, and{' '}
        <strong>Create Invite</strong> to mint the rejoin link. The review channel post always includes the
        appeal link so you can share it manually if a member's DMs are closed.
      </p>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
