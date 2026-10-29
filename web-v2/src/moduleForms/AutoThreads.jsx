import { useState } from 'react';
import ChipPicker from '../components/ChipPicker.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import {
  ARCHIVE_MINUTES,
  DEFAULT_ARCHIVE_MINUTES,
  DEFAULT_TEMPLATE,
  renderThreadName,
} from '../../../src/lib/autoThreadName.js';

const ARCHIVE_LABELS = { 60: '1 hour', 1440: '24 hours', 4320: '3 days', 10080: '7 days' };
const SAMPLE_AUTHOR = 'Alex';
const SAMPLE_POST = 'Anyone up for a **raid** tonight? https://example.com/event';

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

function toFormRule(r = {}) {
  return {
    key: newKey(),
    id: r.id || '',
    channelId: r.channelId || '',
    nameTemplate: r.nameTemplate ?? DEFAULT_TEMPLATE,
    archiveMinutes: r.archiveMinutes || DEFAULT_ARCHIVE_MINUTES,
    onlyWithAttachments: Boolean(r.onlyWithAttachments),
    onlyWithLinks: Boolean(r.onlyWithLinks),
    skipBots: r.skipBots !== false,
    skipStaff: Boolean(r.skipStaff),
    staffRoleIds: r.staffRoleIds || [],
    firstMessage: r.firstMessage || '',
    slowmodeSeconds: r.slowmodeSeconds || 0,
  };
}

const toForm = (config) => ({ rules: config.rules.map(toFormRule) });
const fromForm = (form) => ({
  rules: form.rules.map(({ key: _key, ...rule }) => rule),
});

export default function AutoThreads() {
  const limits = useModuleLimits('auto-threads');
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('auto-threads', {
    toForm,
    fromForm,
  });
  const [sample, setSample] = useState(SAMPLE_POST);

  if (status === 'error') return <LoadError error={error} what="Auto threads settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const template = limitOf(limits, 'rules[].nameTemplate');
  const firstMessage = limitOf(limits, 'rules[].firstMessage');
  const slowmode = limitOf(limits, 'rules[].slowmodeSeconds');
  const staffRoles = limitOf(limits, 'rules[].staffRoleIds');
  const full = form.rules.length >= (limitOf(limits, 'rules').maxItems ?? Infinity);

  const updateRule = (key, patch) =>
    setForm((f) => ({ ...f, rules: f.rules.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const addRule = () => setForm((f) => ({ ...f, rules: [...f.rules, toFormRule()] }));
  const removeRule = (key) => setForm((f) => ({ ...f, rules: f.rules.filter((r) => r.key !== key) }));

  return (
    <>
      <h1 className="v2-section-title">Auto threads</h1>
      <p className="v2-field-hint">
        Every new post in a channel below gets its own thread. The <strong>first</strong> rule for a channel
        that fits the post is used. Forum channels are not listed: they already make a thread for every post.
        Sylo needs <strong>Create Public Threads</strong> and <strong>Send Messages in Threads</strong> in the
        channel.
      </p>

      <div className="v2-field">
        <label htmlFor="at-sample">Sample post for the previews</label>
        <input id="at-sample" type="text" value={sample} onChange={(e) => setSample(e.target.value)} />
        <p className="v2-field-hint">Only used on this page, to show what a thread name will look like.</p>
      </div>

      <form onSubmit={save} data-savebar>
        {form.rules.length === 0 ? (
          <p className="v2-field-hint">No rules yet — add a channel below.</p>
        ) : null}
        {form.rules.map((r, i) => {
          const preview = renderThreadName(r.nameTemplate, {
            author: SAMPLE_AUTHOR,
            createdAt: Date.now(),
            content: sample,
          });
          return (
            <div className="v2-rule-card" key={r.key}>
              <div className="v2-rule-head">
                <span className="v2-field-hint">Rule {i + 1}</span>
                <button type="button" className="v2-btn-ghost" onClick={() => removeRule(r.key)}>
                  remove rule
                </button>
              </div>

              <div className="v2-field">
                <label htmlFor={`at-ch-${r.key}`}>Channel</label>
                <select
                  id={`at-ch-${r.key}`}
                  value={r.channelId}
                  onChange={(e) => updateRule(r.key, { channelId: e.target.value })}
                >
                  <option value="">— channel —</option>
                  {data.channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="v2-field">
                <label htmlFor={`at-name-${r.key}`}>Thread name</label>
                <input
                  id={`at-name-${r.key}`}
                  type="text"
                  maxLength={template.maxLength}
                  value={r.nameTemplate}
                  onChange={(e) => updateRule(r.key, { nameTemplate: e.target.value })}
                />
                <p className="v2-field-hint">
                  <code>{'{author}'}</code> the poster, <code>{'{date}'}</code> the day (UTC),{' '}
                  <code>{'{words}'}</code> the first 6 words of the post (the poster if it has none). Cut at
                  100 characters.
                </p>
                <p className="v2-field-hint" data-testid={`at-preview-${i}`}>
                  Preview: <strong>{preview}</strong> ({[...preview].length}/100)
                </p>
              </div>

              <div className="v2-field">
                <label htmlFor={`at-arch-${r.key}`}>Archive after</label>
                <select
                  id={`at-arch-${r.key}`}
                  value={r.archiveMinutes}
                  onChange={(e) => updateRule(r.key, { archiveMinutes: Number(e.target.value) })}
                >
                  {ARCHIVE_MINUTES.map((m) => (
                    <option key={m} value={m}>
                      {ARCHIVE_LABELS[m]} without activity
                    </option>
                  ))}
                </select>
              </div>

              <div className="v2-field">
                <label>Which posts</label>
                <label className="v2-check">
                  <input
                    type="checkbox"
                    checked={r.onlyWithAttachments}
                    onChange={(e) => updateRule(r.key, { onlyWithAttachments: e.target.checked })}
                  />
                  Only posts with an attachment
                </label>
                <label className="v2-check">
                  <input
                    type="checkbox"
                    checked={r.onlyWithLinks}
                    onChange={(e) => updateRule(r.key, { onlyWithLinks: e.target.checked })}
                  />
                  Only posts with a link
                </label>
                <p className="v2-field-hint">
                  With both on, a post needs one of the two. Links are found in the text, so this needs the
                  Message Content intent.
                </p>
                <label className="v2-check">
                  <input
                    type="checkbox"
                    checked={r.skipBots}
                    onChange={(e) => updateRule(r.key, { skipBots: e.target.checked })}
                  />
                  Skip bots and webhooks
                </label>
                <label className="v2-check">
                  <input
                    type="checkbox"
                    checked={r.skipStaff}
                    onChange={(e) => updateRule(r.key, { skipStaff: e.target.checked })}
                  />
                  Skip staff
                </label>
              </div>

              {r.skipStaff ? (
                <div className="v2-field">
                  <label>
                    Staff roles{' '}
                    <span className="v2-field-hint">— on top of Manage Server and Administrator</span>
                  </label>
                  <ChipPicker
                    kind="role"
                    items={data.roles}
                    value={r.staffRoleIds}
                    onChange={(staffRoleIds) =>
                      updateRule(r.key, {
                        staffRoleIds: staffRoles.maxItems
                          ? staffRoleIds.slice(0, staffRoles.maxItems)
                          : staffRoleIds,
                      })
                    }
                  />
                </div>
              ) : null}

              <div className="v2-field">
                <label htmlFor={`at-first-${r.key}`}>
                  First message in the thread <span className="v2-field-hint">— optional</span>
                </label>
                <textarea
                  id={`at-first-${r.key}`}
                  rows={3}
                  maxLength={firstMessage.maxLength}
                  placeholder="Welcome {author}! Keep the discussion in this thread."
                  value={r.firstMessage}
                  onChange={(e) => updateRule(r.key, { firstMessage: e.target.value })}
                />
                <p className="v2-field-hint">
                  <code>{'{author}'}</code> becomes a mention of the poster.
                </p>
              </div>

              <div className="v2-field">
                <label htmlFor={`at-slow-${r.key}`}>
                  Slowmode in the thread (seconds) <span className="v2-field-hint">— 0 = off</span>
                </label>
                <input
                  id={`at-slow-${r.key}`}
                  type="number"
                  min={slowmode.min}
                  max={slowmode.max}
                  value={r.slowmodeSeconds}
                  onChange={(e) =>
                    updateRule(r.key, {
                      slowmodeSeconds: e.target.value === '' ? '' : Number(e.target.value),
                    })
                  }
                />
              </div>
            </div>
          );
        })}
        <button type="button" className="v2-btn-ghost" onClick={addRule} disabled={full}>
          + Add rule
        </button>
      </form>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
