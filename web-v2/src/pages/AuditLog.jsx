import { Link, useParams } from 'react-router-dom';
import { getAuditLog } from '../api.js';
import { useApiData } from '../useApiData.js';
import LoadError from '../components/LoadError.jsx';
import { formatCount } from '../util.js';

// The server's config-change history — the classic dashboard's Audit log page.
export default function AuditLog() {
  const { guildId } = useParams();
  const { data, error } = useApiData(() => getAuditLog(guildId), [guildId]);

  if (error) return <LoadError error={error} what="the audit log" />;
  if (!data) return <p className="v2-state">Loading…</p>;

  return (
    <>
      <h1 className="v2-section-title">Audit log</h1>
      <p className="v2-field-hint">
        Configuration changes made from the dashboard. Keeps the most recent {formatCount(data.kept)} per
        server. Back to <Link to={`/guilds/${guildId}/settings`}>Settings</Link>.
      </p>

      {data.entries.length ? (
        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">{formatCount(data.entries.length)} shown, newest first</h2>
          <div className="v2-list">
            {data.entries.map((a) => (
              <div className="v2-row v2-row-stack" key={a.id}>
                <div className="v2-row-main">
                  <h3 className="v2-audit-action v2-break">{a.action}</h3>
                  <p className="is-wrap v2-break">
                    {a.actor}
                    {a.detail ? ` — ${a.detail}` : ''}
                  </p>
                </div>
                <span className="v2-field-hint v2-row-time" title={new Date(a.at).toLocaleString()}>
                  {a.ago}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="v2-state">Nothing recorded yet.</p>
      )}
    </>
  );
}
