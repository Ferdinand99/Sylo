import { useState } from 'react';
import { Link } from 'react-router-dom';
import { applicationsExportUrl, getApplicationSubmissions } from '../api.js';
import { useApiData } from '../useApiData.js';
import Badge from './Badge.jsx';
import Meta from './Meta.jsx';
import Time from './Time.jsx';
import LoadError from './LoadError.jsx';

export const STATUS_OPTIONS = ['pending', 'accepted', 'denied', 'withdrawn'];
export const statusTone = (status) =>
  ({ accepted: 'success', denied: 'danger', pending: 'warning', withdrawn: 'neutral' })[status] ?? 'neutral';

/** The row of one submission, linking to its page. */
export function SubmissionRow({ guildId, s }) {
  return (
    <div className="v2-row">
      <div className="v2-row-main">
        <h3>
          <Link to={`/guilds/${guildId}/applications/${s.id}`}>
            #{s.id} · {s.formName || 'Form'}
          </Link>{' '}
          <Badge tone={statusTone(s.status)} inline>
            {s.status}
          </Badge>
        </h3>
        <p className="v2-field-hint">
          <Meta
            items={[
              s.userName ?? s.userId,
              s.source === 'web' ? 'on the web' : 'in DM',
              <Time key="at" value={s.createdAt} relative />,
              s.rolesPending.length > 0 && 'roles waiting for a retry',
              s.cleared && 'answers erased',
            ]}
          />
        </p>
      </div>
    </div>
  );
}

/**
 * The submissions of the server, filtered by form, status and member, with a download of one form's
 * answers (CSV or JSON). Every download is logged by the server.
 */
export default function ApplicationsSubmissions({ guildId, forms }) {
  const [formId, setFormId] = useState('');
  const [status, setStatus] = useState('');
  const [userId, setUserId] = useState('');
  const [page, setPage] = useState(1);
  const [exportForm, setExportForm] = useState('');
  const [exportStatus, setExportStatus] = useState('');
  const { data, error } = useApiData(
    () => getApplicationSubmissions(guildId, { formId, status, userId, page }),
    [guildId, formId, status, userId, page]
  );
  const validUser = userId === '' || /^\d{17,20}$/.test(userId);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const exportTarget = exportForm || forms[0]?.id;

  return (
    <div className="v2-section-gap">
      <div className="v2-field-row">
        <div className="v2-field">
          <label htmlFor="as-form">Form</label>
          <select
            id="as-form"
            value={formId}
            onChange={(e) => {
              setFormId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All forms</option>
            {forms.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <div className="v2-field">
          <label htmlFor="as-status">Status</label>
          <select
            id="as-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Any status</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="v2-field">
          <label htmlFor="as-user">Member id</label>
          <input
            id="as-user"
            type="text"
            inputMode="numeric"
            placeholder="All members"
            value={userId}
            onChange={(e) => {
              setUserId(e.target.value.trim());
              setPage(1);
            }}
          />
          {!validUser ? <p className="v2-field-hint">A member id is 17 to 20 digits.</p> : null}
        </div>
      </div>

      {error ? <LoadError error={error} what="Applications" /> : null}
      {!error && !data ? <p className="v2-state">Loading…</p> : null}
      {data ? (
        <>
          {data.submissions.length === 0 ? <p className="v2-note">No applications match.</p> : null}
          <div className="v2-list">
            {data.submissions.map((s) => (
              <SubmissionRow key={s.id} guildId={guildId} s={s} />
            ))}
          </div>
          {pages > 1 ? (
            <div className="v2-field-row">
              <button
                type="button"
                className="v2-btn-ghost"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span className="v2-field-hint">
                Page {page} of {pages}
              </span>
              <button
                type="button"
                className="v2-btn-ghost"
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {forms.length > 0 ? (
        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">Export answers</h2>
          <p className="v2-field-hint">
            Downloads the answers of one form as CSV or JSON. It is for staff only and is written to the audit
            log.
          </p>
          <form className="v2-field-row" onSubmit={(e) => e.preventDefault()}>
            <select
              aria-label="Form to export"
              value={exportForm || forms[0].id}
              onChange={(e) => setExportForm(e.target.value)}
            >
              {forms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Status to export"
              value={exportStatus}
              onChange={(e) => setExportStatus(e.target.value)}
            >
              <option value="">Any status</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <a
              className="v2-btn-ghost"
              href={applicationsExportUrl(guildId, {
                formId: exportTarget,
                status: exportStatus,
                format: 'csv',
              })}
            >
              Download CSV
            </a>
            <a
              className="v2-btn-ghost"
              href={applicationsExportUrl(guildId, {
                formId: exportTarget,
                status: exportStatus,
                format: 'json',
              })}
            >
              Download JSON
            </a>
          </form>
        </div>
      ) : null}
    </div>
  );
}
