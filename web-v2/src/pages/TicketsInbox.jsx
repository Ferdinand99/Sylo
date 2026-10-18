import { Link, useParams } from 'react-router-dom';
import { getTickets } from '../api.js';
import { useApiData } from '../useApiData.js';
import LoadError from '../components/LoadError.jsx';
import { formatCount } from '../util.js';

function TicketRow({ ticket, guildId }) {
  const preview = `${ticket.previewKind === 'staff' ? 'You: ' : ''}${ticket.preview || '(no text)'}`;
  return (
    <Link
      className={`v2-row v2-ticket-row${ticket.unread ? ' is-unread' : ''}`}
      to={`/guilds/${guildId}/tickets/${ticket.id}`}
    >
      <div className="v2-row-main">
        <h3 className="v2-break">
          <span className="v2-id">#{ticket.id}</span>
          {ticket.user}
          {ticket.unread ? (
            <span className="v2-unread-dot" title="New messages" role="img" aria-label="New messages" />
          ) : null}
        </h3>
        <p title={preview}>{preview}</p>
      </div>
      <span className="v2-field-hint v2-row-time">{ticket.ago}</span>
    </Link>
  );
}

export default function TicketsInbox() {
  const { guildId } = useParams();
  const { data, error } = useApiData(() => getTickets(guildId), [guildId]);

  if (error) return <LoadError error={error} what="the tickets" />;
  if (!data) return <p className="v2-state">Loading…</p>;

  return (
    <>
      <h1 className="v2-section-title">Tickets</h1>
      <p className="v2-field-hint">
        Members open a ticket by sending the bot a DM. Replies you write here reach them as an anonymous
        "Staff" DM.
      </p>

      <h2 className="v2-group-title">Open ({formatCount(data.open.length)})</h2>
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
