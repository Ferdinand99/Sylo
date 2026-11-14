import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  decideApplication,
  deleteApplicationSubmission,
  getApplicantHistory,
  getApplicationSubmission,
  retryApplicationRoles,
} from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';
import Badge from '../components/Badge.jsx';
import Breadcrumb from '../components/Breadcrumb.jsx';
import LoadError from '../components/LoadError.jsx';
import Meta from '../components/Meta.jsx';
import Time from '../components/Time.jsx';
import { SubmissionRow, statusTone } from '../components/ApplicationsSubmissions.jsx';
import { confirmDialog } from '../components/ConfirmDialog.jsx';

const ACTION_TEXT = {
  submitted: 'Submitted',
  accepted: 'Accepted',
  denied: 'Denied',
  withdrawn: 'Withdrawn',
  roles_failed: 'Some roles could not be changed',
  roles_retried: 'Roles retried',
};

/** One application: the answers, the history, accept or deny with a reason, retry roles, delete. */
export default function ApplicationDetail() {
  const { guildId, submissionId } = useParams();
  const navigate = useNavigate();
  const { data, error, setData } = useApiData(
    () => getApplicationSubmission(guildId, submissionId),
    [guildId, submissionId]
  );
  const history = useApiData(
    () => (data ? getApplicantHistory(guildId, data.submission.userId) : Promise.resolve(null)),
    [guildId, data?.submission.userId]
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  if (error) return <LoadError error={error} what="This application" />;
  if (!data) return <p className="v2-state">Loading…</p>;
  const s = data.submission;

  async function run(fn, done) {
    setBusy(true);
    try {
      const out = await fn();
      setData({ submission: out.submission });
      if (out.warnings?.length) notify(out.warnings.join(' '));
      if (done) notify(done, 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    const ok = await confirmDialog({
      title: `Delete application #${s.id}?`,
      body: 'The answers and the posts are deleted. This cannot be undone.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteApplicationSubmission(guildId, s.id);
      notify('Application deleted.', 'info');
      navigate(`/guilds/${guildId}/m/applications`);
    } catch (err) {
      notify(err.message);
      setBusy(false);
    }
  }

  return (
    <>
      <Breadcrumb
        parents={[{ label: 'Applications', to: `/guilds/${guildId}/m/applications` }]}
        current={`#${s.id}`}
      />
      <h1 className="v2-section-title">
        {s.formName || 'Application'} #{s.id}{' '}
        <Badge tone={statusTone(s.status)} inline>
          {s.status}
        </Badge>
      </h1>
      <p className="v2-field-hint">
        <Meta
          items={[
            `From ${s.userName ?? s.userId}`,
            s.source === 'web' ? 'sent on the web' : 'sent in DM',
            <Time key="at" value={s.createdAt} />,
            s.decidedAt && s.status !== 'pending' && <Time key="d" value={s.decidedAt} />,
            s.decidedBy && `by ${s.decidedByName ?? s.decidedBy}`,
          ]}
        />
      </p>
      {s.reason ? <p>Reason: {s.reason}</p> : null}
      {s.dmNote ? (
        <p className="v2-note v2-row-warn">The applicant could not be messaged ({s.dmNote}).</p>
      ) : null}

      {s.rolesPending.length > 0 ? (
        <div className="v2-note v2-row-warn">
          <p>
            Some role changes did not go through:{' '}
            {s.rolesPending
              .map((p) => `${p.op === 'add' ? 'give' : 'take away'} ${p.roleName ?? p.roleId}`)
              .join(', ')}
            .
          </p>
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={busy}
            onClick={() => run(() => retryApplicationRoles(guildId, s.id), 'Roles retried.')}
          >
            Retry the roles
          </button>
        </div>
      ) : null}

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">Answers</h2>
        {s.cleared ? <p className="v2-note">The answers were erased.</p> : null}
        <div className="v2-answers">
          {s.answers.map((a) => (
            <section key={a.id} className="v2-answer" aria-label={a.label}>
              <h3>{a.label}</h3>
              <p>{a.answer || '—'}</p>
            </section>
          ))}
        </div>
      </div>

      {s.status === 'pending' ? (
        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">Decide</h2>
          <div className="v2-field">
            <label htmlFor="ad-reason">Reason (optional, sent to the applicant)</label>
            <textarea
              id="ad-reason"
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="v2-field-row">
            <button
              type="button"
              className="v2-btn-primary"
              disabled={busy}
              onClick={() => run(() => decideApplication(guildId, s.id, 'accept', reason), 'Accepted.')}
            >
              Accept
            </button>
            <button
              type="button"
              className="v2-btn-danger-ghost"
              disabled={busy}
              onClick={() => run(() => decideApplication(guildId, s.id, 'deny', reason), 'Denied.')}
            >
              Deny
            </button>
          </div>
        </div>
      ) : null}

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">History</h2>
        <ul>
          {s.history.map((h, i) => (
            <li key={i}>
              <Time value={h.at} /> · {ACTION_TEXT[h.action] ?? h.action}
              {h.byName || h.by ? ` · ${h.byName ?? h.by}` : ''}
              {h.note ? ` (${h.note})` : ''}
            </li>
          ))}
        </ul>
      </div>

      {history.data && history.data.submissions.length > 1 ? (
        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">Everything from this member</h2>
          <div className="v2-list">
            {history.data.submissions.map((x) => (
              <SubmissionRow key={x.id} guildId={guildId} s={x} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="v2-field-row v2-section-gap">
        <Link className="v2-btn-ghost" to={`/guilds/${guildId}/m/applications`}>
          Back to applications
        </Link>
        <button type="button" className="v2-btn-danger-ghost" disabled={busy} onClick={onDelete}>
          Delete application
        </button>
      </div>
    </>
  );
}
