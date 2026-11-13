import { useState } from 'react';
import { useCmd } from '../platformContext.jsx';
import { publishIntroPrompt, unpublishIntroPrompt } from '../api.js';
import { notify } from '../notify.js';
import ChipPicker from '../components/ChipPicker.jsx';
import ColorPicker from '../components/ColorPicker.jsx';
import HowItWorks from '../components/HowItWorks.jsx';
import LoadError from '../components/LoadError.jsx';
import PlaceholderHint from '../components/PlaceholderHint.jsx';
import MentionTextarea from '../components/MentionTextarea.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { tokensFor } from '../placeholders.js';

const FALLBACK_COLOR = '#7aa2f7';

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

// The colour is one choice in the form (the server's colour, a custom one, or the member's top role)
// and two fields on the server (colorMode, color).
function colorChoiceOf(config) {
  if (config.colorMode === 'role') return 'role';
  return config.color ? 'custom' : 'default';
}

const toForm = (config) => ({
  channelId: config.channelId,
  questions: config.questions.map((q) => ({ ...q, key: newKey() })),
  roleGroups: config.roleGroups.map((g) => ({ ...g, key: newKey() })),
  showRoles: config.showRoles,
  colorChoice: colorChoiceOf(config),
  color: config.color || FALLBACK_COLOR,
  description: config.description,
  footer: config.footer,
  deleteOnLeave: config.deleteOnLeave,
  promptText: config.promptText,
});

const fromForm = (form) => ({
  channelId: form.channelId,
  // A new question has no id yet: the server gives it one.
  questions: form.questions.map(({ key: _key, ...q }) => q),
  roleGroups: form.roleGroups.map(({ key: _key, ...g }) => g),
  showRoles: form.showRoles,
  colorMode: form.colorChoice === 'role' ? 'role' : 'fixed',
  color: form.colorChoice === 'custom' ? form.color : '',
  description: form.description,
  footer: form.footer,
  deleteOnLeave: form.deleteOnLeave,
  promptText: form.promptText,
});

export default function Introductions() {
  const cmd = useCmd();
  const limits = useModuleLimits('introductions');
  const { guildId, data, form, setForm, set, status, error, dirty, saving, save, reset } = useModuleForm(
    'introductions',
    { toForm, fromForm }
  );
  const [busy, setBusy] = useState(false);
  // Whether the prompt message is published; null until this page publishes or removes it.
  const [published, setPublished] = useState(null);

  if (status === 'error') return <LoadError error={error} what="Introductions settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const isPublished = published ?? Boolean(data.config.promptMessageId);
  const label = limitOf(limits, 'questions[].label');
  const prompt = limitOf(limits, 'questions[].prompt');
  const answerLength = limitOf(limits, 'questions[].maxLength');
  const groupName = limitOf(limits, 'roleGroups[].name');
  const questionsFull = form.questions.length >= (limitOf(limits, 'questions').maxItems ?? Infinity);
  const groupsFull = form.roleGroups.length >= (limitOf(limits, 'roleGroups').maxItems ?? Infinity);

  const updateQuestion = (key, patch) =>
    setForm((f) => ({ ...f, questions: f.questions.map((q) => (q.key === key ? { ...q, ...patch } : q)) }));
  const moveQuestion = (key, by) =>
    setForm((f) => {
      const i = f.questions.findIndex((q) => q.key === key);
      const j = i + by;
      if (i < 0 || j < 0 || j >= f.questions.length) return f;
      const questions = [...f.questions];
      [questions[i], questions[j]] = [questions[j], questions[i]];
      return { ...f, questions };
    });
  const updateGroup = (key, patch) =>
    setForm((f) => ({ ...f, roleGroups: f.roleGroups.map((g) => (g.key === key ? { ...g, ...patch } : g)) }));

  const tokens = [
    ...tokensFor('introductions', data.placeholders),
    ...form.roleGroups
      .filter((g) => g.name.trim())
      .map((g) => ({
        token: `{rolegroup:${g.name.trim()}}`,
        hint: `The roles of the group ${g.name.trim()}`,
      })),
  ];

  async function onPublish() {
    setBusy(true);
    try {
      const result = await publishIntroPrompt(guildId, {
        channelId: form.channelId,
        promptText: form.promptText,
      });
      setPublished(true);
      if (result?.warning) notify(result.warning);
      notify(isPublished ? 'Prompt message updated.' : 'Prompt message published and pinned.', 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onUnpublish() {
    const ok = await confirmDialog({
      title: 'Remove the prompt message?',
      body: 'The message is deleted from the channel. Members can still use the command.',
      confirmLabel: 'Remove message',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await unpublishIntroPrompt(guildId);
      setPublished(false);
      notify('Prompt message removed.', 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Introductions</h1>
      <p className="v2-field-hint">
        Members answer a few questions in DM and Sylo posts a membership card for them in the channel below.
        They start with <code>{cmd('/intro create')}</code> or the button on the prompt message. Running it
        again updates their card.
      </p>
      <HowItWorks>
        <p>
          Sylo asks the questions one at a time. A member can type <code>skip</code> to leave an optional
          question empty, <code>keep</code> to keep an earlier answer, and <code>cancel</code> to stop. They
          see a preview first. Mentions in answers (@everyone, @here and roles) are removed, and the card
          never pings anyone.
        </p>
      </HowItWorks>

      <form onSubmit={save} data-savebar>
        <div className="v2-field">
          <label htmlFor="intro-channel">Introductions channel</label>
          <select
            id="intro-channel"
            value={form.channelId}
            onChange={(e) => set({ channelId: e.target.value })}
          >
            <option value="">— select a channel —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
          <p className="v2-field-hint">
            Sylo needs View Channel, Send Messages and Embed Links there. Nothing works until a channel is
            chosen.
          </p>
        </div>

        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">Questions</h2>
          {form.questions.length === 0 ? (
            <p className="v2-field-hint">
              No questions: the card shows only the member's profile and role groups.
            </p>
          ) : null}
          {form.questions.map((q, i) => (
            <div className="v2-rule-card" key={q.key}>
              <div className="v2-rule-head">
                <span className="v2-rule-title">{q.label || `Question ${i + 1}`}</span>
                <span>
                  <button
                    type="button"
                    className="v2-btn-ghost"
                    aria-label={`Move question ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => moveQuestion(q.key, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="v2-btn-ghost"
                    aria-label={`Move question ${i + 1} down`}
                    disabled={i === form.questions.length - 1}
                    onClick={() => moveQuestion(q.key, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="v2-btn-danger-ghost"
                    onClick={() =>
                      setForm((f) => ({ ...f, questions: f.questions.filter((x) => x.key !== q.key) }))
                    }
                  >
                    Remove
                  </button>
                </span>
              </div>
              <div className="v2-field">
                <label htmlFor={`q-label-${q.key}`}>Label on the card</label>
                <input
                  id={`q-label-${q.key}`}
                  type="text"
                  maxLength={label.maxLength}
                  value={q.label}
                  onChange={(e) => updateQuestion(q.key, { label: e.target.value })}
                />
              </div>
              <div className="v2-field">
                <label htmlFor={`q-prompt-${q.key}`}>Question asked in DM</label>
                <textarea
                  id={`q-prompt-${q.key}`}
                  rows={2}
                  maxLength={prompt.maxLength}
                  value={q.prompt}
                  onChange={(e) => updateQuestion(q.key, { prompt: e.target.value })}
                />
              </div>
              <div className="v2-field">
                <label htmlFor={`q-max-${q.key}`}>Longest answer (characters)</label>
                <input
                  id={`q-max-${q.key}`}
                  type="number"
                  min={answerLength.min}
                  max={answerLength.max}
                  value={q.maxLength}
                  onChange={(e) => updateQuestion(q.key, { maxLength: Number(e.target.value) })}
                />
              </div>
              <div className="v2-field-row">
                <label className="v2-check">
                  <input
                    type="checkbox"
                    checked={q.required}
                    onChange={(e) => updateQuestion(q.key, { required: e.target.checked })}
                  />
                  Required
                </label>
                <label className="v2-check">
                  <input
                    type="checkbox"
                    checked={q.inline}
                    onChange={(e) => updateQuestion(q.key, { inline: e.target.checked })}
                  />
                  Short field (side by side with others)
                </label>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={questionsFull}
            onClick={() =>
              setForm((f) => ({
                ...f,
                questions: [
                  ...f.questions,
                  {
                    key: newKey(),
                    id: '',
                    label: '',
                    prompt: '',
                    required: false,
                    maxLength: 300,
                    inline: false,
                  },
                ],
              }))
            }
          >
            + Add question
          </button>
        </div>

        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">Role groups</h2>
          <p className="v2-field-hint">
            A group shows the roles a member has from a list (for example Country or Age) as one field on the
            card. In the description, <code>{'{rolegroup:Name}'}</code> inserts them.
          </p>
          {form.roleGroups.map((g) => (
            <div className="v2-rule-card" key={g.key}>
              <div className="v2-rule-head">
                <span className="v2-rule-title">{g.name || 'New group'}</span>
                <button
                  type="button"
                  className="v2-btn-danger-ghost"
                  onClick={() =>
                    setForm((f) => ({ ...f, roleGroups: f.roleGroups.filter((x) => x.key !== g.key) }))
                  }
                >
                  Remove
                </button>
              </div>
              <div className="v2-field">
                <label htmlFor={`g-name-${g.key}`}>Name</label>
                <input
                  id={`g-name-${g.key}`}
                  type="text"
                  maxLength={groupName.maxLength}
                  value={g.name}
                  onChange={(e) => updateGroup(g.key, { name: e.target.value })}
                />
              </div>
              <div className="v2-field">
                <label>Roles in this group</label>
                <ChipPicker
                  kind="role"
                  items={data.roles}
                  value={g.roleIds}
                  onChange={(roleIds) => updateGroup(g.key, { roleIds })}
                />
              </div>
              <label className="v2-check">
                <input
                  type="checkbox"
                  checked={g.hideWhenEmpty}
                  onChange={(e) => updateGroup(g.key, { hideWhenEmpty: e.target.checked })}
                />
                Hide the field when the member has none of these roles
              </label>
            </div>
          ))}
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={groupsFull}
            onClick={() =>
              setForm((f) => ({
                ...f,
                roleGroups: [...f.roleGroups, { key: newKey(), name: '', roleIds: [], hideWhenEmpty: false }],
              }))
            }
          >
            + Add role group
          </button>
        </div>

        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">Card</h2>
          <p className="v2-field-hint">
            The card shows the member's avatar, name, answers, role groups and when they joined.
          </p>
          <div className="v2-field">
            <label htmlFor="intro-description">Description (optional)</label>
            <MentionTextarea
              channels={data.channels}
              roles={data.roles}
              id="intro-description"
              rows={3}
              maxLength={limitOf(limits, 'description').maxLength}
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
            />
            <PlaceholderHint
              fieldId="intro-description"
              tokens={tokens}
              value={form.description}
              onChange={(description) => set({ description })}
            />
          </div>
          <div className="v2-field">
            <label htmlFor="intro-footer">Footer (optional)</label>
            <input
              id="intro-footer"
              type="text"
              maxLength={limitOf(limits, 'footer').maxLength}
              value={form.footer}
              onChange={(e) => set({ footer: e.target.value })}
            />
          </div>
          <div className="v2-field">
            <label htmlFor="intro-color">Colour</label>
            <select
              id="intro-color"
              value={form.colorChoice}
              onChange={(e) => set({ colorChoice: e.target.value })}
            >
              <option value="default">The server's embed colour</option>
              <option value="custom">A colour I pick</option>
              <option value="role">The member's top role colour</option>
            </select>
            {form.colorChoice === 'custom' ? (
              <ColorPicker value={form.color} onChange={(color) => set({ color })} title="Card colour" />
            ) : null}
          </div>
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.showRoles}
              onChange={(e) => set({ showRoles: e.target.checked })}
            />
            Show the member's other roles (top 10, without the roles already shown in a group)
          </label>
        </div>

        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">When a member leaves</h2>
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.deleteOnLeave}
              onChange={(e) => set({ deleteOnLeave: e.target.checked })}
            />
            Delete their card and answers
          </label>
        </div>

        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">Prompt message</h2>
          <p className="v2-field-hint">
            Post a pinned “Introduce yourself” message with a <strong>Create my intro</strong> button in the
            channel above. On Fluxer the button is shown as a reaction.
          </p>
          <div className="v2-field">
            <label htmlFor="intro-prompt">Message text</label>
            <MentionTextarea
              channels={data.channels}
              roles={data.roles}
              id="intro-prompt"
              rows={2}
              maxLength={limitOf(limits, 'promptText').maxLength}
              placeholder="Introduce yourself! Press the button and Sylo asks you a few questions in DM."
              value={form.promptText}
              onChange={(e) => set({ promptText: e.target.value })}
            />
          </div>
          <div className="v2-field-row">
            <button
              type="button"
              className="v2-btn-primary"
              disabled={busy || !form.channelId}
              onClick={onPublish}
            >
              {isPublished ? 'Update prompt message' : 'Publish prompt message'}
            </button>
            {isPublished ? (
              <button type="button" className="v2-btn-danger-ghost" disabled={busy} onClick={onUnpublish}>
                Remove prompt message
              </button>
            ) : null}
          </div>
        </div>
      </form>
      <p className="v2-field-hint">
        {data.introductions === 1 ? '1 member has' : `${data.introductions} members have`} an introduction.
      </p>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
