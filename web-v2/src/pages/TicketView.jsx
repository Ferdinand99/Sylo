import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getTicket, pollTicket, replyToTicket, closeTicket, ticketTranscriptUrl } from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import Meta from '../components/Meta.jsx';

const POLL_MS = 6000;
const isHttp = (u) => /^https?:\/\//i.test(u);

// Append new messages, skipping any that are already shown (a poll and a reply can overlap).
const append = (list, incoming) => [...list, ...incoming.filter((m) => !list.some((x) => x.id === m.id))];

function Bubble({ m }) {
  return (
    <div className={`v2-bubble is-${m.kind}`}>
      <div className="v2-bubble-meta">
        <Meta items={[m.who, m.ago, m.kind === 'staff' && !m.delivered && 'not delivered']} />
      </div>
      {m.content ? <div className="v2-bubble-body">{m.content}</div> : null}
      {(m.attachments ?? []).filter(isHttp).map((url) => (
        <a key={url} className="v2-bubble-att" href={url} target="_blank" rel="noopener noreferrer">
          attachment
        </a>
      ))}
    </div>
  );
}

export default function TicketView() {
  const { guildId, ticketId } = useParams();
  const { data, loading, error } = useApiData(() => getTicket(guildId, ticketId), [guildId, ticketId]);
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('open');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const chatRef = useRef(null);
  const lastId = useRef(0);

  useEffect(() => {
    if (!data) return;
    setMessages(data.messages);
    setStatus(data.ticket.status);
    lastId.current = data.lastId;
  }, [data]);

  // Poll for new messages while the ticket is open.
  useEffect(() => {
    if (!data || status !== 'open') return undefined;
    const timer = setInterval(async () => {
      try {
        const r = await pollTicket(guildId, ticketId, lastId.current);
        if (r.messages.length) {
          lastId.current = r.messages[r.messages.length - 1].id;
          setMessages((list) => append(list, r.messages));
        }
        if (r.status !== 'open') setStatus(r.status);
      } catch {
        /* a failed poll is retried on the next tick */
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [data, status, guildId, ticketId]);

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  if (loading && !data) return <p className="v2-state">Loading…</p>;
  if (error) return <LoadError error={error} what="this ticket" />;
  const { ticket } = data;

  async function send() {
    if (!text.trim()) return notify('Write a reply first.');
    setBusy(true);
    try {
      const r = await replyToTicket(guildId, ticketId, text);
      setText('');
      const fresh = await pollTicket(guildId, ticketId, lastId.current);
      if (fresh.messages.length) {
        lastId.current = fresh.messages[fresh.messages.length - 1].id;
        setMessages((list) => append(list, fresh.messages));
      }
      if (!r.delivered) {
        notify('Saved, but the member could not be sent a DM (DMs closed or the bot is blocked).');
      }
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (!confirm(`Close ticket #${ticket.id}?`)) return;
    setBusy(true);
    try {
      await closeTicket(guildId, ticketId, text);
      setText('');
      setStatus('closed');
      notify('Ticket closed.', 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="v2-field-hint">
        <Link to={`/guilds/${guildId}/tickets`}>Back to tickets</Link>
      </p>
      <h1 className="v2-section-title">
        Ticket #{ticket.id} <span className="v2-ticket-user">{ticket.user}</span>
      </h1>
      <p className="v2-field-hint">
        <Meta
          items={[
            ticket.userId,
            `opened ${ticket.openedAgo}`,
            status === 'open' ? 'open' : 'closed',
            <a key="t" href={ticketTranscriptUrl(guildId, ticketId)} download>
              Download transcript
            </a>,
          ]}
        />
      </p>

      <div className="v2-chat" ref={chatRef} aria-live="polite">
        {messages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
      </div>

      {status === 'open' ? (
        <div className="v2-field">
          <label htmlFor="ticket-reply">Reply as staff</label>
          <textarea
            id="ticket-reply"
            rows={3}
            maxLength={2000}
            placeholder="Write a reply…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="v2-field-row v2-section-gap-sm">
            <button type="button" className="v2-btn-primary" disabled={busy} onClick={send}>
              Send reply
            </button>
            <button type="button" className="v2-btn-ghost" disabled={busy} onClick={close}>
              Close ticket
            </button>
          </div>
          <p className="v2-field-hint">
            Close ticket sends what you wrote as the final reply. With an empty box it sends the default
            closing notice.
          </p>
        </div>
      ) : (
        <p className="v2-field-hint">
          This ticket is closed. The member can open a new one by sending the bot a DM again.
        </p>
      )}
    </>
  );
}
