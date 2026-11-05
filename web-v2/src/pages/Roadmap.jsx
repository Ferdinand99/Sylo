import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getRoadmap, voteRoadmapPost, suggestRoadmapPost } from '../api.js';
import Badge from '../components/Badge.jsx';
import LoadError from '../components/LoadError.jsx';
import { formatCount } from '../util.js';
import { loginHref } from '../publicRoutes.js';
import { ROADMAP_STATUS } from '../roadmapStatus.js';

const GROUPS = Object.entries(ROADMAP_STATUS).map(([key, v]) => ({ key, ...v }));

function VoteButton({ post, onVote, canVote, canLogin }) {
  const [busy, setBusy] = useState(false);

  async function click() {
    setBusy(true);
    try {
      await onVote(post.id);
    } finally {
      setBusy(false);
    }
  }

  // Without a login (or with voting off) the count is only shown: no button, no border, full colour.
  if (!canVote) {
    return (
      <div className="v2-roadmap-vote is-static" title={canLogin ? 'Sign in to vote' : undefined}>
        <strong>{formatCount(post.votes)}</strong>
        <span>vote{post.votes === 1 ? '' : 's'}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`v2-roadmap-vote${post.voted ? ' is-voted' : ''}`}
      onClick={click}
      disabled={busy}
      aria-pressed={Boolean(post.voted)}
      aria-label={`Vote for ${post.title}, ${formatCount(post.votes)} ${post.votes === 1 ? 'vote' : 'votes'}`}
    >
      <strong>{formatCount(post.votes)}</strong>
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

  if (state.error) return <LoadError error={state.error} what="the roadmap" />;
  if (state.loading || !state.data) return <p className="v2-state">Loading…</p>;

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
      <p className={`v2-note${d.signedIn ? '' : ' v2-login-prompt'}`}>
        What's planned, in progress, and shipped. Vote on what matters to you, or suggest something new.
        {d.signedIn ? null : d.open ? (
          ' Voting and suggesting need a login, and this Sylo has none set up.'
        ) : (
          <>
            {' '}
            <a href={loginHref()}>Sign in</a> to vote or suggest a feature.
          </>
        )}
      </p>

      {notice ? <p className="v2-note">{notice}</p> : null}

      {GROUPS.map(({ key, label, tone }) => (
        <div className="v2-group" key={key}>
          <h2 className="v2-group-title">
            <Badge tone={tone}>{label}</Badge>
          </h2>
          {!d.groups[key]?.length ? (
            <p className="v2-note">Nothing here yet.</p>
          ) : (
            <div className="v2-list">
              {d.groups[key].map((p) => (
                <div className="v2-row v2-roadmap-row" id={`post-${p.id}`} key={p.id}>
                  <div className="v2-row-main">
                    <h3 className="v2-break">{p.title}</h3>
                    <div
                      className="v2-roadmap-desc v2-break"
                      dangerouslySetInnerHTML={{ __html: p.descriptionHtml }}
                    />
                  </div>
                  <VoteButton post={p} onVote={onVote} canVote={d.signedIn} canLogin={!d.open} />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {d.signedIn ? (
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

          {d.mine?.length ? (
            <>
              <h3 className="v2-section-gap">Your suggestions awaiting review</h3>
              <div className="v2-list">
                {d.mine.map((p) => (
                  <div className="v2-row" key={p.id}>
                    <div className="v2-row-main">
                      <h3 className="v2-break">{p.title}</h3>
                    </div>
                    <span className="v2-field-hint v2-row-time">{p.ago}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
