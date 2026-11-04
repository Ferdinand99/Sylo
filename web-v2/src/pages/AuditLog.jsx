import { useParams } from 'react-router-dom';
import { getAuditLog } from '../api.js';
import { useApiData } from '../useApiData.js';
import { useOverview } from '../OverviewContext.jsx';
import Breadcrumb from '../components/Breadcrumb.jsx';
import LoadError from '../components/LoadError.jsx';
import { formatCount } from '../util.js';
import Reveal from '../components/Reveal.jsx';

// Plain names for the action keys that are not "module:<id>".
const ACTION_LABELS = {
  'settings:server': 'Server settings',
  'moderation:lockdown': 'Lockdown',
  'moderation:unlock': 'Channel unlocked',
  'moderation:warn-clear': 'Warnings cleared',
  'moderation:case-reason': 'Case reason edited',
  'personalizer:identity': 'Bot name and avatar',
  'personalizer:presence': 'Bot status',
  'personalizer:announcement': 'Announcement',
  'leveling:vanity': 'Leaderboard link',
  'leveling:setxp': 'XP changed',
  'leveling:reset': 'XP reset',
  'leveling:leaderboard': 'Leaderboard',
  'counting:unbench': 'Counting access restored',
  'counting:set': 'Count set',
  'counting:reset': 'Count reset',
  'privacy:member-data': 'Member data',
  warned: 'Warning',
};

const words = (text) => {
  const s = String(text)
    .replace(/[:_-]+/g, ' ')
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
};

/**
 * A readable name for an audit action key: "module:starboard" -> "Starboard" (the module's name from
 * `moduleNames`, a Map of id -> name), "settings:server" -> "Server settings". The key itself is shown as the
 * hover title. Unknown keys fall back to the key with its punctuation turned into spaces.
 */
export function auditActionLabel(action, moduleNames = new Map()) {
  const key = String(action ?? '');
  if (ACTION_LABELS[key]) return ACTION_LABELS[key];
  if (key.startsWith('module:')) {
    const id = key.slice('module:'.length);
    if (id === 'bulk') return 'Several modules';
    return moduleNames.get(id) || words(id);
  }
  if (key.startsWith('appeal:')) return `Appeal ${key.slice('appeal:'.length)}`;
  if (key.startsWith('moderation:case-')) return `Case ${key.slice('moderation:case-'.length)}`;
  if (key.startsWith('command:')) return `Command ${key.slice('command:'.length)}`;
  return words(key) || key;
}

// The server's config-change history.
export default function AuditLog() {
  const { guildId } = useParams();
  const { data, error } = useApiData(() => getAuditLog(guildId), [guildId]);
  const overview = useOverview();

  if (error) return <LoadError error={error} what="the audit log" />;
  if (!data) return <p className="v2-state">Loading…</p>;

  const moduleNames = new Map(
    (overview?.data?.groups ?? []).flatMap((g) => g.cards).map((c) => [c.id, c.name])
  );

  return (
    <Reveal>
      <Breadcrumb parents={[{ label: 'Settings', to: `/guilds/${guildId}/settings` }]} current="Audit log" />
      <h1 className="v2-section-title">Audit log</h1>
      <p className="v2-field-hint">
        Configuration changes made from the dashboard. Keeps the most recent {formatCount(data.kept)} per
        server.
      </p>

      {data.entries.length ? (
        <div className="v2-group v2-section-gap">
          <p className="v2-field-hint">{formatCount(data.entries.length)} shown, newest first.</p>
          <div className="v2-list">
            {data.entries.map((a) => (
              <div className="v2-row v2-row-stack" key={a.id}>
                <div className="v2-row-main">
                  <h3 className="v2-audit-action v2-break" title={a.action}>
                    {auditActionLabel(a.action, moduleNames)}
                  </h3>
                  <p className="is-wrap v2-break">
                    {a.actor}
                    {a.detail ? ` — ${a.detail}` : ''}
                    <span className="v2-audit-ago-inline" title={new Date(a.at).toLocaleString()}>
                      {' · '}
                      {a.ago}
                    </span>
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
    </Reveal>
  );
}
