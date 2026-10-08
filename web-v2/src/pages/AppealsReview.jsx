import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getAppealsReview, decideAppeal } from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import Meta from '../components/Meta.jsx';

const STATUS_LABEL = { open: 'Open', accepted: 'Accepted', denied: 'Denied' };

function AppealCard({ appeal, onDecide }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function decide(decision) {
    setBusy(true);
    try {
      await onDecide(appeal.id, decision, reason);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="v2-rule-card">
      <div className="v2-rule-head">
        <div>
          <h3 className="v2-appeal-user">{appeal.user}</h3>
          <p className="v2-field-hint">
            <Meta
              items={[
                `submitted ${appeal.ago}`,
                `original ban reason: ${appeal.banReason}`,
                appeal.status !== 'open' && `${STATUS_LABEL[appeal.status]} by ${appeal.decidedBy}`,
                appeal.decidedAgo,
              ]}
            />
          </p>
        </div>
        <span className={`v2-status-pill ${appeal.status === 'accepted' ? 'completed' : 'pending'}`}>
          {STATUS_LABEL[appeal.status] ?? appeal.status}
        </span>
      </div>
      <dl className="v2-appeal-answers">
        {appeal.answers.map((qa, i) => (
          <div key={i}>
            <dt>{qa.q}</dt>
            <dd>{qa.a || '—'}</dd>
          </div>
        ))}
      </dl>
      {appeal.status === 'open' ? (
        <div className="v2-field">
          <label htmlFor={`appeal-reason-${appeal.id}`}>Reason or note to the member</label>
          <textarea
            id={`appeal-reason-${appeal.id}`}
            rows={2}
            maxLength={1000}
            placeholder="Explain the decision. The member sees this."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="v2-field-row v2-section-gap-sm">
            <button type="button" className="v2-btn-primary" disabled={busy} onClick={() => decide('accept')}>
              Accept and unban
            </button>
            <button type="button" className="v2-btn-ghost" disabled={busy} onClick={() => decide('deny')}>
              Deny
            </button>
          </div>
        </div>
      ) : appeal.decisionReason ? (
        <p className="v2-field-hint">Note to the member: {appeal.decisionReason}</p>
      ) : null}
    </div>
  );
}

export default function AppealsReview() {
  const { guildId } = useParams();
  const { data, loading, error, setData } = useApiData(() => getAppealsReview(guildId), [guildId]);

  if (loading && !data) return <p className="v2-state">Loading…</p>;
  if (error) return <LoadError error={error} what="the appeals" />;

  async function onDecide(id, decision, reason) {
    try {
      const r = await decideAppeal(guildId, id, decision, reason);
      const status = r.status;
      setData((d) => ({
        ...d,
        open: d.open - 1,
        appeals: d.appeals.map((a) =>
          a.id === id
            ? {
                ...a,
                status,
                decidedBy: 'you',
                decisionReason: reason || 'No reason given',
                decidedAgo: 'just now',
              }
            : a
        ),
      }));
      const parts = [status === 'accepted' ? 'Appeal accepted.' : 'Appeal denied.'];
      const unbanFailed = status === 'accepted' && !r.unbanned;
      if (unbanFailed) parts.push('The ban could not be lifted. Unban them manually.');
      if (!r.dmDelivered) parts.push('The member could not be sent a DM.');
      notify(parts.join(' '), unbanFailed ? 'error' : 'info');
    } catch (err) {
      notify(err.message);
    }
  }

  const open = data.appeals.filter((a) => a.status === 'open');
  const decided = data.appeals.filter((a) => a.status !== 'open');
  return (
    <>
      <h1 className="v2-section-title">Ban appeals</h1>
      {!data.moduleEnabled || !data.configured ? (
        <p className="v2-note">
          {!data.moduleEnabled ? 'The Ban appeals module is off. ' : ''}
          {!data.configured ? 'No appeal questions are set up yet. ' : ''}
          Set it up under <Link to={`/guilds/${guildId}/m/appeals`}>Ban appeals settings</Link>.
        </p>
      ) : null}

      <h2 className="v2-group-title">Open ({open.length})</h2>
      {open.length ? (
        open.map((a) => <AppealCard key={a.id} appeal={a} onDecide={onDecide} />)
      ) : (
        <p className="v2-field-hint">Nothing waiting for a decision.</p>
      )}

      {decided.length ? (
        <>
          <h2 className="v2-group-title v2-section-gap">Decided</h2>
          {decided.map((a) => (
            <AppealCard key={a.id} appeal={a} onDecide={onDecide} />
          ))}
        </>
      ) : null}
    </>
  );
}
