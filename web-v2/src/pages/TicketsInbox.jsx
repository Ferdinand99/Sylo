import { Link, useParams } from 'react-router-dom';
import { getTickets } from '../api.js';
import { useApiData } from '../useApiData.js';
import LoadError from '../components/LoadError.jsx';

function TicketRow({ ticket, guildId }) {
  const preview = ticket.preview || '(no text)';
  return (
    <Link
      className={`v2-row v2-ticket-row${ticket.unread ? ' is-unread' : ''}`}
      to={`/guilds/${guildId}/tickets/${ticket.id}`}
    >
      <div className="v2-row-main">
        <h3>
          <span className="v2-id">#{ticket.id}</span>
          {ticket.user}
          {ticket.unread ? <span className="v2-unread-dot" title="New messages" /> : null}
        </h3>
        <p>
          {ticket.previewKind === 'staff' ? 'You: ' : ''}
          {preview}
        </p>
      </div>
      <span className="v2-field-hint">{ticket.ago}</span>
    </Link>
  );
}

export default function TicketsInbox() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getTickets(guildId), [guildId]);

  if (loading && !data) return <p className="v2-state">Loading…</p>;
  if (error) return <LoadError error={error} what="the tickets" />;

  return (
    <>
      <h1 className="v2-section-title">Tickets</h1>
      <p className="v2-field-hint">
        Members open a ticket by sending the bot a DM. Replies you write here reach them as an anonymous
        "Staff" DM.
      </p>

      <h2 className="v2-group-title">Open ({data.open.length})</h2>
      {data.open.length ? (
        <div className="v2-list">
          {data.open.map((t) => (
            <TicketRow key={t.id} ticket={t} guildId={guildId} />
          ))}
        </div>
      ) : (
        <p className="v2-field-hint">No open tickets.</p>
      )}

      {data.closed.length ? (
        <>
          <h2 className="v2-group-title v2-section-gap">Recently closed</h2>
          <div className="v2-list">
            {data.closed.map((t) => (
              <TicketRow key={t.id} ticket={t} guildId={guildId} />
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
