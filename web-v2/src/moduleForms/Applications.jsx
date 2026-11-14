import { useState } from 'react';
import { useCmd } from '../platformContext.jsx';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  getModuleConfig,
  publishApplicationsPanel,
  saveModuleConfig,
  unpublishApplicationsPanel,
} from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';
import ApplicationsFormEditor, { newDraft, toDraft } from '../components/ApplicationsFormEditor.jsx';
import ApplicationsSubmissions from '../components/ApplicationsSubmissions.jsx';
import EmptyList from '../components/EmptyList.jsx';
import Badge from '../components/Badge.jsx';
import HowItWorks from '../components/HowItWorks.jsx';
import LoadError from '../components/LoadError.jsx';
import Meta from '../components/Meta.jsx';
import TabRow from '../components/TabRow.jsx';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';

const TABS = [
  ['forms', 'Forms'],
  ['submissions', 'Submissions'],
  ['panel', 'Panel and settings'],
];

/** The label of a tab; the queue says how many applications wait for a decision. */
const tabLabel = (key, label, pending) =>
  key === 'submissions' && pending > 0 ? `${label} · ${pending} waiting` : label;

const MODE_TEXT = { both: 'DM or web', discord: 'DM only', web: 'Web only' };

/** The module's settings that are not one form: the panel message and how long decided ones are kept. */
function PanelAndSettings({ guildId, data, setData, limits }) {
  const [text, setText] = useState(data.config.panelText);
  const [channelId, setChannelId] = useState(data.config.panelChannelId);
  const [retention, setRetention] = useState(data.config.retentionDays);
  const [busy, setBusy] = useState(false);
  const published = Boolean(data.config.panelMessageId);
  const textLimit = limitOf(limits, 'panelText');
  const retentionLimit = limitOf(limits, 'retentionDays');

  async function run(fn, done) {
    setBusy(true);
    try {
      const out = await fn();
      setData((d) => ({ ...d, config: out.config }));
      if (out.warning) notify(out.warning);
      notify(done, 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onUnpublish() {
    const ok = await confirmDialog({
      title: 'Remove the panel message?',
      body: 'The message is deleted from the channel. Members can still use /apply.',
      confirmLabel: 'Remove message',
    });
    if (ok) await run(() => unpublishApplicationsPanel(guildId), 'Panel message removed.');
  }

  return (
    <div className="v2-section-gap">
      <div className="v2-group">
        <h2 className="v2-group-title">Panel message</h2>
        <p className="v2-field-hint">
          A message in a channel with one button for each open form (a menu when there are more than 5). On
          Fluxer the buttons are shown as reactions. Publishing again sends a new panel and deletes the old
          one.
        </p>
        <div className="v2-field">
          <label htmlFor="ap-channel">Channel</label>
          <select id="ap-channel" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            <option value="">— select a channel —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="v2-field">
          <label htmlFor="ap-text">Message text</label>
          <textarea
            id="ap-text"
            rows={2}
            maxLength={textLimit.maxLength}
            placeholder={data.defaultPanelText}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="v2-field-row">
          <button
            type="button"
            className="v2-btn-primary"
            disabled={busy || !channelId}
            onClick={() =>
              run(
                () => publishApplicationsPanel(guildId, { channelId, text }),
                published ? 'Panel republished.' : 'Panel published.'
              )
            }
          >
            {published ? 'Republish panel' : 'Publish panel'}
          </button>
          {published ? (
            <button type="button" className="v2-btn-danger-ghost" disabled={busy} onClick={onUnpublish}>
              Remove panel
            </button>
          ) : null}
        </div>
      </div>

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">Keeping applications</h2>
        <div className="v2-field">
          <label htmlFor="ap-retention">Delete decided applications after (days)</label>
          <input
            id="ap-retention"
            type="number"
            min={retentionLimit.min}
            max={retentionLimit.max}
            value={retention}
            onChange={(e) => setRetention(Number(e.target.value))}
          />
          <p className="v2-field-hint">
            Answers are personal data. Accepted, denied and withdrawn applications are deleted with their
            posts after this many days. Applications waiting for a decision are kept.
          </p>
        </div>
        <button
          type="button"
          className="v2-btn-primary"
          disabled={busy}
          onClick={() =>
            run(
              () => saveModuleConfig(guildId, 'applications', { retentionDays: retention, panelText: text }),
              'Settings saved.'
            )
          }
        >
          Save settings
        </button>
      </div>
    </div>
  );
}

/**
 * Applications: forms members fill in, in DM or on the web, for staff to accept or deny. Three tabs: the
 * forms (with an editor and a preview), the received applications (list, filters, export), and the panel
 * message with the retention.
 */
export default function Applications() {
  const cmd = useCmd();
  const { guildId } = useParams();
  const limits = useModuleLimits('applications');
  const { data, error, setData } = useApiData(() => getModuleConfig(guildId, 'applications'), [guildId]);
  const [params, setParams] = useSearchParams();
  // The form being edited: null (the list), a draft, or a new draft.
  const [editing, setEditing] = useState(null);

  if (error) return <LoadError error={error} what="Applications" />;
  if (!data) return <p className="v2-state">Loading…</p>;

  // "?tab=" says which tab; without it the page opens on the queue when applications wait, else on the forms.
  const asked = params.get('tab');
  const tab = TABS.some(([key]) => key === asked) ? asked : data.pending > 0 ? 'submissions' : 'forms';
  const setTab = (key) => setParams({ tab: key }, { replace: true, preventScrollReset: true });

  const upsert = (form) =>
    setData((d) => {
      const has = d.forms.some((f) => f.id === form.id);
      return { ...d, forms: has ? d.forms.map((f) => (f.id === form.id ? form : f)) : [...d.forms, form] };
    });

  return (
    <>
      <h1 className="v2-section-title">Applications</h1>
      <p className="v2-field-hint">
        Members apply with <code>{cmd('/apply start')}</code>, the panel message, or the web form. Staff
        accept or deny from the post, with <code>{cmd('/application accept')}</code> or{' '}
        <code>{cmd('/application deny')}</code> when they want to give a reason, or here.
      </p>
      <HowItWorks>
        <p>
          Each form has its own questions, requirements, channels and roles. Sylo asks the questions one at a
          time in DM (choices as numbered options), or the member fills in the web form. Staff see every
          submission as a post with Accept and Deny. A decision is made once, even if two people press at the
          same time; if a role change fails, the decision stands and you can retry the roles from the
          application.
        </p>
      </HowItWorks>

      <TabRow role="tablist" activeKey={tab}>
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`v2-tab${tab === key ? ' is-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {tabLabel(key, label, data.pending)}
          </button>
        ))}
      </TabRow>

      {tab === 'forms' ? (
        editing ? (
          <ApplicationsFormEditor
            key={editing.id ?? 'new'}
            guildId={guildId}
            initial={editing}
            data={data}
            limits={limits}
            onSaved={(form) => {
              upsert(form);
              setEditing(toDraft(form));
            }}
            onDeleted={(id) => {
              setData((d) => ({ ...d, forms: d.forms.filter((f) => f.id !== id) }));
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div className="v2-section-gap">
            {data.forms.length === 0 ? (
              <EmptyList
                start={{ label: 'Create your first form', onClick: () => setEditing(newDraft(data)) }}
              >
                Let members apply for a role or a position with the questions you choose, and review the
                answers here.
              </EmptyList>
            ) : null}
            <div className="v2-list">
              {data.forms.map((f) => (
                <div className="v2-row" key={f.id}>
                  <div className="v2-row-main">
                    <h3>
                      {f.name}{' '}
                      <Badge tone={f.enabled ? 'success' : 'neutral'} inline>
                        {f.enabled ? 'Open' : 'Closed'}
                      </Badge>
                    </h3>
                    <p className="v2-field-hint">
                      <Meta
                        items={[
                          MODE_TEXT[f.fillMode],
                          `${f.questions.length} question${f.questions.length === 1 ? '' : 's'}`,
                          f.problems.setup && `Not ready: ${f.problems.setup}`,
                          f.problems.roles && `Roles: ${f.problems.roles}`,
                        ]}
                      />
                    </p>
                  </div>
                  <div className="v2-row-actions">
                    <button type="button" className="v2-btn-ghost" onClick={() => setEditing(toDraft(f))}>
                      Edit
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {/* With no form yet the empty state above carries the one accent button. */}
            {data.forms.length > 0 ? (
              <button
                type="button"
                className="v2-btn-primary"
                disabled={data.forms.length >= data.maxForms}
                onClick={() => setEditing(newDraft(data))}
              >
                New form
              </button>
            ) : null}
            {data.forms.length >= data.maxForms ? (
              <p className="v2-field-hint">A server can have at most {data.maxForms} forms.</p>
            ) : null}
          </div>
        )
      ) : null}

      {tab === 'submissions' ? <ApplicationsSubmissions guildId={guildId} forms={data.forms} /> : null}
      {tab === 'panel' ? (
        <PanelAndSettings guildId={guildId} data={data} setData={setData} limits={limits} />
      ) : null}
    </>
  );
}
