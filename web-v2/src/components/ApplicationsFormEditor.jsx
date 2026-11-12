import { useMemo, useState } from 'react';
import { deleteApplicationForm, saveApplicationForm } from '../api.js';
import { notify } from '../notify.js';
import ChipPicker from './ChipPicker.jsx';
import PlaceholderHint from './PlaceholderHint.jsx';
import ApplicationQuestion from './ApplicationQuestion.jsx';
import { confirmDialog } from './ConfirmDialog.jsx';
import { limitOf } from './useModuleLimits.js';
import { tokensFor } from '../placeholders.js';
import { emptyAnswers } from '../applicationAnswers.js';

const newKey = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());

export const QUESTION_TYPE_LABELS = { text: 'Text', choice: 'Choice', role: 'Role', yesno: 'Yes / no' };

/** A form from the server as the editor's draft: question and option rows get a key for React. */
export function toDraft(form) {
  return {
    ...form,
    questions: form.questions.map((q) => ({
      ...q,
      key: newKey(),
      options: q.options.map((o) => ({ ...o, key: newKey() })),
    })),
  };
}

/** The draft as the body of a save: the keys come off (a new question has no id yet, the server gives one). */
export function fromDraft(draft) {
  const out = { ...draft };
  for (const key of ['version', 'problems', 'id', 'createdAt']) delete out[key];
  out.questions = draft.questions.map((q) => {
    const { options, ...rest } = q;
    delete rest.key;
    return { ...rest, options: options.map((o) => ({ id: o.id, label: o.label })) };
  });
  return out;
}

export function newDraft(data) {
  return toDraft({
    id: null,
    name: '',
    description: '',
    enabled: false,
    fillMode: 'both',
    timeoutMinutes: 30,
    questions: [],
    requiredRoleIds: [],
    requiredRolesMode: 'all',
    restrictedRoleIds: [],
    restrictedRolesMode: 'any',
    minAccountDays: 0,
    minServerDays: 0,
    cooldownHours: 0,
    pendingChannelId: '',
    acceptedChannelId: '',
    deniedChannelId: '',
    decidedPost: 'move',
    pingRoleIds: [],
    managerRoleIds: [],
    staffThread: false,
    pendingRoleId: '',
    removeOnSubmitRoleIds: [],
    acceptAddRoleIds: [],
    acceptRemoveRoleIds: [],
    denyAddRoleIds: [],
    denyRemoveRoleIds: [],
    onLeave: 'keep',
    messages: { ...data.defaultMessages },
    problems: { setup: null, roles: null },
  });
}

const blankQuestion = (type = 'text') => ({
  key: newKey(),
  id: '',
  type,
  label: '',
  help: '',
  required: false,
  long: false,
  minLength: 0,
  maxLength: 300,
  options: [],
  multiple: false,
  minChoices: 0,
  maxChoices: 1,
  grant: 'never',
});

function NumberField({ id, label, value, onChange, limit, hint }) {
  return (
    <div className="v2-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        min={limit?.min}
        max={limit?.max}
        value={value}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
      />
      {hint ? <p className="v2-field-hint">{hint}</p> : null}
    </div>
  );
}

function ChannelSelect({ id, label, value, onChange, channels, hint }) {
  return (
    <div className="v2-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— none —</option>
        {channels.map((c) => (
          <option key={c.id} value={c.id}>
            #{c.name}
          </option>
        ))}
      </select>
      {hint ? <p className="v2-field-hint">{hint}</p> : null}
    </div>
  );
}

function RolePicker({ label, value, onChange, roles, hint, id }) {
  return (
    <div className="v2-field">
      <label htmlFor={id}>{label}</label>
      <ChipPicker id={id} kind="role" items={roles} value={value} onChange={onChange} />
      {hint ? <p className="v2-field-hint">{hint}</p> : null}
    </div>
  );
}

/** One question's settings. */
function QuestionEditor({ q, index, count, onChange, onMove, onRemove, limits, roles, maxShort }) {
  const label = limitOf(limits, 'questions[].label');
  const help = limitOf(limits, 'questions[].help');
  const lengthLimit = limitOf(limits, 'questions[].maxLength');
  const optionLabel = limitOf(limits, 'questions[].options[].label');
  const optionsLimit = limitOf(limits, 'questions[].options');
  const optionsFull = q.options.length >= (optionsLimit.maxItems ?? Infinity);
  const cap = q.long ? lengthLimit.max : maxShort;
  const set = (patch) => onChange(q.key, patch);
  const setOption = (key, patch) =>
    set({ options: q.options.map((o) => (o.key === key ? { ...o, ...patch } : o)) });
  const asRole = q.type === 'role';

  return (
    <div className="v2-rule-card">
      <div className="v2-rule-head">
        <span className="v2-rule-title">
          {q.label || `Question ${index + 1}`}{' '}
          <span className="v2-field-hint">· {QUESTION_TYPE_LABELS[q.type]}</span>
        </span>
        <span>
          <button
            type="button"
            className="v2-btn-ghost"
            aria-label={`Move question ${index + 1} up`}
            disabled={index === 0}
            onClick={() => onMove(q.key, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="v2-btn-ghost"
            aria-label={`Move question ${index + 1} down`}
            disabled={index === count - 1}
            onClick={() => onMove(q.key, 1)}
          >
            ↓
          </button>
          <button type="button" className="v2-btn-danger-ghost" onClick={() => onRemove(q.key)}>
            Remove
          </button>
        </span>
      </div>
      <div className="v2-field">
        <label htmlFor={`aq-type-${q.key}`}>Type</label>
        <select id={`aq-type-${q.key}`} value={q.type} onChange={(e) => set({ type: e.target.value })}>
          {Object.entries(QUESTION_TYPE_LABELS).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      </div>
      <div className="v2-field">
        <label htmlFor={`aq-label-${q.key}`}>Question</label>
        <input
          id={`aq-label-${q.key}`}
          type="text"
          maxLength={label.maxLength}
          value={q.label}
          onChange={(e) => set({ label: e.target.value })}
        />
      </div>
      <div className="v2-field">
        <label htmlFor={`aq-help-${q.key}`}>Help text (optional)</label>
        <input
          id={`aq-help-${q.key}`}
          type="text"
          maxLength={help.maxLength}
          value={q.help}
          onChange={(e) => set({ help: e.target.value })}
        />
      </div>
      <label className="v2-check">
        <input type="checkbox" checked={q.required} onChange={(e) => set({ required: e.target.checked })} />
        Required
      </label>

      {q.type === 'text' ? (
        <>
          <label className="v2-check">
            <input type="checkbox" checked={q.long} onChange={(e) => set({ long: e.target.checked })} />
            Long answer (a text box instead of one line)
          </label>
          <div className="v2-field-row">
            <NumberField
              id={`aq-min-${q.key}`}
              label="Shortest answer (characters)"
              value={q.minLength}
              limit={{ min: limitOf(limits, 'questions[].minLength').min, max: cap }}
              onChange={(minLength) => set({ minLength })}
            />
            <NumberField
              id={`aq-max-${q.key}`}
              label="Longest answer (characters)"
              value={q.maxLength}
              limit={{ min: lengthLimit.min, max: cap }}
              onChange={(maxLength) => set({ maxLength })}
            />
          </div>
        </>
      ) : null}

      {q.type === 'choice' || asRole ? (
        <>
          <label className="v2-check">
            <input
              type="checkbox"
              checked={q.multiple}
              onChange={(e) => set({ multiple: e.target.checked })}
            />
            Allow more than one
          </label>
          {q.multiple ? (
            <div className="v2-field-row">
              <NumberField
                id={`aq-minc-${q.key}`}
                label="At least"
                value={q.minChoices}
                limit={{ min: 0, max: q.options.length }}
                onChange={(minChoices) => set({ minChoices })}
              />
              <NumberField
                id={`aq-maxc-${q.key}`}
                label="At most"
                value={q.maxChoices}
                limit={{ min: 1, max: Math.max(1, q.options.length) }}
                onChange={(maxChoices) => set({ maxChoices })}
              />
            </div>
          ) : null}
        </>
      ) : null}

      {q.type === 'choice' ? (
        <div className="v2-field">
          <span className="v2-field-label">Options</span>
          {q.options.map((o, i) => (
            <div className="v2-field-row" key={o.key}>
              <input
                type="text"
                aria-label={`Option ${i + 1}`}
                maxLength={optionLabel.maxLength}
                value={o.label}
                onChange={(e) => setOption(o.key, { label: e.target.value })}
              />
              <button
                type="button"
                className="v2-btn-danger-ghost"
                onClick={() => set({ options: q.options.filter((x) => x.key !== o.key) })}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={optionsFull}
            onClick={() => set({ options: [...q.options, { key: newKey(), id: '', label: '' }] })}
          >
            + Add option
          </button>
          <p className="v2-field-hint">
            On Fluxer a question has at most 10 options, and members answer with their numbers.
          </p>
        </div>
      ) : null}

      {asRole ? (
        <>
          <RolePicker
            id={`aq-roles-${q.key}`}
            label="Roles to choose from"
            roles={roles}
            value={q.options.map((o) => o.id)}
            onChange={(ids) =>
              set({
                options: ids.slice(0, optionsLimit.maxItems ?? ids.length).map(
                  (id) =>
                    q.options.find((o) => o.id === id) ?? {
                      key: newKey(),
                      id,
                      label: roles.find((r) => r.id === id)?.name ?? '',
                    }
                ),
              })
            }
            hint="Up to 10 roles. Sylo checks it can manage them before a member starts."
          />
          <div className="v2-field">
            <label htmlFor={`aq-grant-${q.key}`}>Give the chosen roles</label>
            <select id={`aq-grant-${q.key}`} value={q.grant} onChange={(e) => set({ grant: e.target.value })}>
              <option value="never">Never (just a question)</option>
              <option value="submit">When the application is submitted</option>
              <option value="accept">When the application is accepted</option>
            </select>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** What the member sees, with the questions as they are in the editor right now. */
function FormPreview({ draft, roles }) {
  const questions = useMemo(
    () =>
      draft.questions.map((q) => ({
        ...q,
        id: q.key,
        options: q.options.map((o) => ({
          id: o.id || o.key,
          label: o.label || roles.find((r) => r.id === o.id)?.name || '',
        })),
      })),
    [draft.questions, roles]
  );
  const [answers, setAnswers] = useState(() => emptyAnswers(questions));
  return (
    <div className="v2-group" aria-label="Preview of the form">
      <h3 className="v2-group-title">{draft.name || 'Untitled form'}</h3>
      {draft.description ? <p>{draft.description}</p> : null}
      {questions.length === 0 ? <p className="v2-field-hint">Add a question to see it here.</p> : null}
      {questions.map((q) => (
        <ApplicationQuestion
          key={q.id}
          idPrefix="preview"
          q={q}
          value={answers[q.id] ?? (q.type === 'choice' || q.type === 'role' ? [] : '')}
          onChange={(value) => setAnswers((a) => ({ ...a, [q.id]: value }))}
        />
      ))}
      <p className="v2-field-hint">This is a preview: nothing is sent.</p>
    </div>
  );
}

/**
 * The editor of one form: its settings, questions (reorderable), requirements, where the posts go, the
 * roles, the messages to the applicant, and a preview. Saving and deleting are the server's.
 */
export default function ApplicationsFormEditor({
  guildId,
  initial,
  data,
  limits,
  onSaved,
  onDeleted,
  onCancel,
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setMessage = (key, value) => setDraft((d) => ({ ...d, messages: { ...d.messages, [key]: value } }));
  const updateQuestion = (key, patch) =>
    setDraft((d) => ({ ...d, questions: d.questions.map((q) => (q.key === key ? { ...q, ...patch } : q)) }));
  const moveQuestion = (key, by) =>
    setDraft((d) => {
      const i = d.questions.findIndex((q) => q.key === key);
      const j = i + by;
      if (i < 0 || j < 0 || j >= d.questions.length) return d;
      const questions = [...d.questions];
      [questions[i], questions[j]] = [questions[j], questions[i]];
      return { ...d, questions };
    });

  const questionsLimit = limitOf(limits, 'questions').maxItems ?? Infinity;
  const tokens = tokensFor('applications', data.placeholders);
  const isNew = draft.id === null;

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const out = await saveApplicationForm(guildId, draft.id, fromDraft(draft));
      setDraft(toDraft(out.form));
      onSaved(out.form);
      notify('Form saved.', 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    const ok = await confirmDialog({
      title: `Delete ${draft.name || 'this form'}?`,
      body: 'Submissions already received stay and can still be decided. The panel message must be published again.',
      confirmLabel: 'Delete form',
    });
    if (!ok) return;
    try {
      await deleteApplicationForm(guildId, draft.id);
      onDeleted(draft.id);
    } catch (err) {
      notify(err.message);
    }
  }

  const nameLimit = limitOf(limits, 'name');
  const descLimit = limitOf(limits, 'description');
  const msgLimit = (key) => limitOf(limits, `messages.${key}`);

  return (
    <form onSubmit={onSave} className="v2-section-gap" data-testid="application-form-editor">
      <div className="v2-group">
        <h2 className="v2-group-title">{isNew ? 'New form' : draft.name || 'Form'}</h2>
        {draft.problems?.setup ? (
          <p className="v2-note v2-row-warn">Not ready: {draft.problems.setup}</p>
        ) : null}
        {draft.problems?.roles ? <p className="v2-note v2-row-warn">Roles: {draft.problems.roles}</p> : null}
        <div className="v2-field">
          <label htmlFor="af-name">Name</label>
          <input
            id="af-name"
            type="text"
            maxLength={nameLimit.maxLength}
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div className="v2-field">
          <label htmlFor="af-desc">Description (optional)</label>
          <textarea
            id="af-desc"
            rows={2}
            maxLength={descLimit.maxLength}
            value={draft.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </div>
        <label className="v2-check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          Open for applications
        </label>
        <div className="v2-field">
          <label htmlFor="af-mode">Where members fill it in</label>
          <select id="af-mode" value={draft.fillMode} onChange={(e) => set({ fillMode: e.target.value })}>
            <option value="both">In DM or on the web (the member chooses)</option>
            <option value="discord">In DM only</option>
            <option value="web">On the web only</option>
          </select>
          {data.webAddress ? (
            <p className="v2-field-hint">
              The web form is at <code>{data.webAddress}</code>. Only signed-in members of this server can
              open it.
            </p>
          ) : (
            <p className="v2-field-hint">
              This Sylo has no public web address, so the web form cannot be linked.
            </p>
          )}
        </div>
        <NumberField
          id="af-timeout"
          label="Time to answer in DM (minutes)"
          value={draft.timeoutMinutes}
          limit={limitOf(limits, 'timeoutMinutes')}
          onChange={(timeoutMinutes) => set({ timeoutMinutes })}
        />
      </div>

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">Questions</h2>
        {draft.questions.length === 0 ? <p className="v2-field-hint">No questions yet.</p> : null}
        {draft.questions.map((q, i) => (
          <QuestionEditor
            key={q.key}
            q={q}
            index={i}
            count={draft.questions.length}
            limits={limits}
            roles={data.roles}
            maxShort={data.shortTextMax}
            onChange={updateQuestion}
            onMove={moveQuestion}
            onRemove={(key) =>
              setDraft((d) => ({ ...d, questions: d.questions.filter((x) => x.key !== key) }))
            }
          />
        ))}
        <button
          type="button"
          className="v2-btn-ghost"
          disabled={draft.questions.length >= questionsLimit}
          onClick={() => setDraft((d) => ({ ...d, questions: [...d.questions, blankQuestion()] }))}
        >
          + Add question
        </button>
        <button
          type="button"
          className="v2-btn-ghost"
          onClick={() => setPreview((p) => !p)}
          aria-pressed={preview}
        >
          {preview ? 'Hide preview' : 'Preview the form'}
        </button>
        {preview ? <FormPreview draft={draft} roles={data.roles} /> : null}
      </div>

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">Who may apply</h2>
        <RolePicker
          id="af-req"
          label="Required roles"
          roles={data.roles}
          value={draft.requiredRoleIds}
          onChange={(requiredRoleIds) => set({ requiredRoleIds })}
        />
        <div className="v2-field">
          <label htmlFor="af-reqmode">The member needs</label>
          <select
            id="af-reqmode"
            value={draft.requiredRolesMode}
            onChange={(e) => set({ requiredRolesMode: e.target.value })}
          >
            <option value="all">all of the required roles</option>
            <option value="any">any one of the required roles</option>
          </select>
        </div>
        <RolePicker
          id="af-res"
          label="Restricted roles"
          roles={data.roles}
          value={draft.restrictedRoleIds}
          onChange={(restrictedRoleIds) => set({ restrictedRoleIds })}
        />
        <div className="v2-field">
          <label htmlFor="af-resmode">The member is turned away with</label>
          <select
            id="af-resmode"
            value={draft.restrictedRolesMode}
            onChange={(e) => set({ restrictedRolesMode: e.target.value })}
          >
            <option value="any">any one of the restricted roles</option>
            <option value="all">all of the restricted roles</option>
          </select>
        </div>
        <NumberField
          id="af-acc"
          label="Account age (days, 0 for none)"
          value={draft.minAccountDays}
          limit={limitOf(limits, 'minAccountDays')}
          onChange={(minAccountDays) => set({ minAccountDays })}
        />
        <NumberField
          id="af-srv"
          label="Time in this server (days, 0 for none)"
          value={draft.minServerDays}
          limit={limitOf(limits, 'minServerDays')}
          onChange={(minServerDays) => set({ minServerDays })}
        />
        <NumberField
          id="af-cool"
          label="Cooldown after a denial (hours, 0 for none)"
          value={draft.cooldownHours}
          limit={limitOf(limits, 'cooldownHours')}
          onChange={(cooldownHours) => set({ cooldownHours })}
          hint="Only one application per form can wait for a decision at a time."
        />
      </div>

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">Where the applications go</h2>
        <ChannelSelect
          id="af-pending"
          label="Channel for new applications"
          value={draft.pendingChannelId}
          onChange={(pendingChannelId) => set({ pendingChannelId })}
          channels={data.channels}
          hint="Required. Sylo needs View Channel, Read Message History, Send Messages and Embed Links there."
        />
        <ChannelSelect
          id="af-accepted"
          label="Channel for accepted applications (optional)"
          value={draft.acceptedChannelId}
          onChange={(acceptedChannelId) => set({ acceptedChannelId })}
          channels={data.channels}
        />
        <ChannelSelect
          id="af-denied"
          label="Channel for denied applications (optional)"
          value={draft.deniedChannelId}
          onChange={(deniedChannelId) => set({ deniedChannelId })}
          channels={data.channels}
        />
        <div className="v2-field">
          <label htmlFor="af-post">A decided application is</label>
          <select
            id="af-post"
            value={draft.decidedPost}
            onChange={(e) => set({ decidedPost: e.target.value })}
          >
            <option value="move">moved to that channel</option>
            <option value="copy">copied there (the original stays)</option>
          </select>
        </div>
        <RolePicker
          id="af-ping"
          label="Roles to ping for a new application"
          roles={data.roles}
          value={draft.pingRoleIds}
          onChange={(pingRoleIds) => set({ pingRoleIds })}
          hint="The only mention Sylo makes."
        />
        <RolePicker
          id="af-mgr"
          label="Roles that may decide"
          roles={data.roles}
          value={draft.managerRoleIds}
          onChange={(managerRoleIds) => set({ managerRoleIds })}
          hint="Members with Manage Server may always decide."
        />
        <label className="v2-check">
          <input
            type="checkbox"
            checked={draft.staffThread}
            onChange={(e) => set({ staffThread: e.target.checked })}
          />
          Open a staff thread on each application (Discord only)
        </label>
      </div>

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">Roles</h2>
        <p className="v2-field-hint">
          Sylo checks it can manage these roles before a member starts. If a role change fails later, the
          decision still stands and you can retry it from the application.
        </p>
        <div className="v2-field">
          <label htmlFor="af-pendrole">Role while waiting for a decision</label>
          <select
            id="af-pendrole"
            value={draft.pendingRoleId}
            onChange={(e) => set({ pendingRoleId: e.target.value })}
          >
            <option value="">— none —</option>
            {data.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
        <RolePicker
          id="af-rsub"
          label="Roles taken away on submit"
          roles={data.roles}
          value={draft.removeOnSubmitRoleIds}
          onChange={(removeOnSubmitRoleIds) => set({ removeOnSubmitRoleIds })}
        />
        <RolePicker
          id="af-aadd"
          label="Roles given on accept"
          roles={data.roles}
          value={draft.acceptAddRoleIds}
          onChange={(acceptAddRoleIds) => set({ acceptAddRoleIds })}
        />
        <RolePicker
          id="af-arem"
          label="Roles taken away on accept"
          roles={data.roles}
          value={draft.acceptRemoveRoleIds}
          onChange={(acceptRemoveRoleIds) => set({ acceptRemoveRoleIds })}
        />
        <RolePicker
          id="af-dadd"
          label="Roles given on deny"
          roles={data.roles}
          value={draft.denyAddRoleIds}
          onChange={(denyAddRoleIds) => set({ denyAddRoleIds })}
        />
        <RolePicker
          id="af-drem"
          label="Roles taken away on deny"
          roles={data.roles}
          value={draft.denyRemoveRoleIds}
          onChange={(denyRemoveRoleIds) => set({ denyRemoveRoleIds })}
        />
      </div>

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">Messages to the applicant</h2>
        <p className="v2-field-hint">Sent by DM. Leave one empty to send nothing.</p>
        {[
          ['start', 'When they start (shown before the first question)'],
          ['completed', 'When they have submitted'],
          ['accepted', 'When accepted'],
          ['denied', 'When denied'],
        ].map(([key, label]) => (
          <div className="v2-field" key={key}>
            <label htmlFor={`af-msg-${key}`}>{label}</label>
            <textarea
              id={`af-msg-${key}`}
              rows={2}
              maxLength={msgLimit(key).maxLength}
              value={draft.messages[key]}
              onChange={(e) => setMessage(key, e.target.value)}
            />
            <PlaceholderHint
              fieldId={`af-msg-${key}`}
              tokens={tokens}
              value={draft.messages[key]}
              onChange={(value) => setMessage(key, value)}
            />
          </div>
        ))}
      </div>

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">When a member leaves while waiting</h2>
        <div className="v2-field">
          <select
            id="af-leave"
            aria-label="When a member leaves while waiting"
            value={draft.onLeave}
            onChange={(e) => set({ onLeave: e.target.value })}
          >
            <option value="keep">Keep the application</option>
            <option value="deny">Deny it (reason: Left the server)</option>
          </select>
        </div>
      </div>

      <div className="v2-field-row v2-section-gap">
        <button type="submit" className="v2-btn-primary" disabled={saving}>
          {isNew ? 'Create form' : 'Save form'}
        </button>
        <button type="button" className="v2-btn-ghost" onClick={onCancel}>
          Close
        </button>
        {!isNew ? (
          <button type="button" className="v2-btn-danger-ghost" onClick={onDelete}>
            Delete form
          </button>
        ) : null}
      </div>
    </form>
  );
}
