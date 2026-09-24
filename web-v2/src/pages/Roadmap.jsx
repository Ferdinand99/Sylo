import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getRoadmap, voteRoadmapPost, suggestRoadmapPost, ApiError } from '../api.js';

const GROUPS = [
  { key: 'planned', label: 'Planned' },
  { key: 'started', label: 'In progress' },
  { key: 'completed', label: 'Recently shipped' },
];

function VoteButton({ post, onVote }) {
  const [busy, setBusy] = useState(false);

  async function click() {
    setBusy(true);
    try {
      await onVote(post.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`v2-roadmap-vote${post.voted ? ' is-voted' : ''}`}
      onClick={click}
      disabled={busy}
    >
      <strong>{post.votes}</strong>
      <span>vote{post.votes === 1 ? '' : 's'}</span>
    </button>
  );
}

export default function Roadmap() {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [notice, setNotice] = useState(null);
  const [form, setForm] = useState({ title: '', description: '' });
  const [submitting, setSubmitting] = useState(false);

  function load() {
    return getRoadmap()
      .then((data) => setState({ loading: false, data, error: null }))
      .catch((error) => setState({ loading: false, data: null, error }));
  }

  useEffect(() => {
    load();
  }, []);

  if (state.loading) return <p className="v2-state">Loading…</p>;
  if (state.error) {
    const notAuthed = state.error instanceof ApiError && state.error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/discord/login">log in again</a>.
          </>
        ) : (
          `Couldn't load the roadmap (${state.error.message}).`
        )}
      </p>
    );
  }

  const d = state.data;

  async function onVote(id) {
    try {
      const result = await voteRoadmapPost(id);
      setState((s) => ({
        ...s,
        data: {
          ...s.data,
          groups: Object.fromEntries(
            Object.entries(s.data.groups).map(([k, list]) => [
              k,
              list.map((p) => (p.id === id ? { ...p, ...result } : p)),
            ])
          ),
        },
      }));
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function onSuggest(e) {
    e.preventDefault();
    setSubmitting(true);
    setNotice(null);
    try {
      await suggestRoadmapPost(form.title, form.description);
      setForm({ title: '', description: '' });
      setNotice('Thanks — your suggestion is awaiting review.');
      await load();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">
        Roadmap{' '}
        {d.isOwner ? (
          <Link to="/roadmap/admin" className="v2-field-hint">
            Manage board →
          </Link>
        ) : null}
      </h1>
      <p className="v2-note">
        What's planned, in progress, and shipped. Vote on what matters to you, or suggest something new.
      </p>

      {notice ? <p className="v2-note">{notice}</p> : null}

      {GROUPS.map(({ key, label }) => (
        <div className="v2-group" key={key}>
          <h2 className="v2-group-title">
            <span className={`v2-status-pill ${key}`}>{label}</span>
          </h2>
          {d.groups[key].length === 0 ? (
            <p className="v2-note">Nothing here yet.</p>
          ) : (
            <div className="v2-list">
              {d.groups[key].map((p) => (
                <div className="v2-row" id={`post-${p.id}`} key={p.id}>
                  <div className="v2-row-main">
                    <h3>{p.title}</h3>
                    <div
                      className="v2-roadmap-desc"
                      dangerouslySetInnerHTML={{ __html: p.descriptionHtml }}
                    />
                  </div>
                  <VoteButton post={p} onVote={onVote} />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      <div className="v2-group">
        <h2 className="v2-group-title">Suggest a feature</h2>
        <form onSubmit={onSuggest}>
          <div className="v2-field">
            <label htmlFor="rm-title">Title</label>
            <input
              id="rm-title"
              type="text"
              maxLength={100}
              required
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
          </div>
          <div className="v2-field">
            <label htmlFor="rm-desc">Description</label>
            <textarea
              id="rm-desc"
              rows={5}
              maxLength={2000}
              required
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
            <p className="v2-field-hint">
              Markdown: **bold**, _italic_, `code`, [links](url), and - bullet lists.
            </p>
          </div>
          <button type="submit" className="v2-btn-primary" disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit for review'}
          </button>
        </form>

        {d.mine.length ? (
          <>
            <h3 className="v2-section-gap">Your suggestions awaiting review</h3>
            <div className="v2-list">
              {d.mine.map((p) => (
                <div className="v2-row" key={p.id}>
                  <div className="v2-row-main">
                    <h3>{p.title}</h3>
                  </div>
                  <span className="v2-field-hint">{p.ago}</span>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
