import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getRoadmapAdmin,
  createRoadmapPost,
  approveRoadmapPost,
  rejectRoadmapPost,
  setRoadmapPostStatus,
  editRoadmapPost,
  deleteRoadmapPost,
  ApiError,
} from '../api.js';
import LoadError from '../components/LoadError.jsx';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import { formatCount } from '../util.js';

function EditRow({ post, onSave, onCancel }) {
  const [title, setTitle] = useState(post.title);
  const [description, setDescription] = useState(post.description);
  const [busy, setBusy] = useState(false);
  const id = useId();

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(post.id, title, description);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="v2-section-gap">
      <div className="v2-field">
        <label htmlFor={`${id}-title`}>Title</label>
        <input
          id={`${id}-title`}
          type="text"
          maxLength={100}
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="v2-field">
        <label htmlFor={`${id}-desc`}>Description</label>
        <textarea
          id={`${id}-desc`}
          rows={5}
          maxLength={2000}
          required
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="v2-field-row">
        <button type="submit" className="v2-btn-primary" disabled={busy}>
          Save
        </button>
        <button type="button" className="v2-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function RoadmapAdmin() {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [notice, setNotice] = useState(null);
  const [form, setForm] = useState({ title: '', description: '' });
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState(null);

  function load() {
    return getRoadmapAdmin()
      .then((data) => setState({ loading: false, data, error: null }))
      .catch((error) => setState({ loading: false, data: null, error }));
  }

  useEffect(() => {
    load();
  }, []);

  if (state.error) {
    if (state.error instanceof ApiError && state.error.status === 403) {
      return <p className="v2-state">This page is restricted to Sylo's operators.</p>;
    }
    return <LoadError error={state.error} what="the roadmap admin" />;
  }
  if (state.loading || !state.data) return <p className="v2-state">Loading…</p>;

  const d = state.data;

  async function run(action, successMsg) {
    setNotice(null);
    try {
      await action();
      if (successMsg) setNotice(successMsg);
      await load();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function onCreate(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await run(() => createRoadmapPost(form.title, form.description));
      setForm({ title: '', description: '' });
    } finally {
      setSubmitting(false);
    }
  }

  async function onSaveEdit(id, title, description) {
    await run(() => editRoadmapPost(id, title, description));
    setEditingId(null);
  }

  async function onDelete(post) {
    const ok = await confirmDialog({
      title: 'Delete this post?',
      body: (
        <>
          <strong className="v2-break">{post.title}</strong> is removed from the public board for good.
        </>
      ),
      confirmLabel: 'Delete post',
    });
    if (!ok) return;
    await run(() => deleteRoadmapPost(post.id));
  }

  async function onReject(post) {
    const ok = await confirmDialog({
      title: 'Reject this suggestion?',
      body: (
        <>
          <strong className="v2-break">{post.title}</strong> is deleted and never shows on the board.
        </>
      ),
      confirmLabel: 'Reject and delete',
    });
    if (!ok) return;
    await run(() => rejectRoadmapPost(post.id));
  }

  return (
    <>
      <h1 className="v2-section-title">Roadmap admin</h1>
      <p className="v2-note">
        Review suggestions, manage status, or post something yourself.{' '}
        <Link to="/roadmap">View the public board</Link>.
      </p>

      {notice ? <p className="v2-note">{notice}</p> : null}

      <div className="v2-group">
        <h2 className="v2-group-title">Pending suggestions ({formatCount(d.pending.length)})</h2>
        {d.pending.length === 0 ? (
          <p className="v2-note">Nothing waiting on review.</p>
        ) : (
          <div className="v2-list">
            {d.pending.map((p) => (
              <div className="v2-row v2-row-stack v2-roadmap-row" key={p.id}>
                <div className="v2-row-main">
                  <h3 className="v2-break">{p.title}</h3>
                  <div
                    className="v2-roadmap-desc v2-break"
                    dangerouslySetInnerHTML={{ __html: p.descriptionHtml }}
                  />
                  <span className="v2-field-hint">{p.ago}</span>
                </div>
                <div className="v2-row-actions">
                  <button
                    type="button"
                    className="v2-btn-primary"
                    onClick={() => run(() => approveRoadmapPost(p.id))}
                  >
                    Approve
                  </button>
                  <button type="button" className="v2-btn-danger" onClick={() => onReject(p)}>
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="v2-group">
        <h2 className="v2-group-title">Post something new</h2>
        <form onSubmit={onCreate}>
          <div className="v2-field">
            <label htmlFor="rma-title">Title</label>
            <input
              id="rma-title"
              type="text"
              maxLength={100}
              required
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
          </div>
          <div className="v2-field">
            <label htmlFor="rma-desc">Description</label>
            <textarea
              id="rma-desc"
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
            {submitting ? 'Posting…' : 'Post as planned'}
          </button>
        </form>
      </div>

      <div className="v2-group">
        <h2 className="v2-group-title">Public posts ({formatCount(d.posts.length)})</h2>
        {d.posts.length === 0 ? (
          <p className="v2-note">Nothing posted yet.</p>
        ) : (
          <div className="v2-list">
            {d.posts.map((p) => (
              <div className="v2-row v2-row-stack v2-roadmap-row" key={p.id}>
                <div className="v2-row-main">
                  <h3 className="v2-break">
                    <span className={`v2-status-pill ${p.status}`}>{p.status}</span> {p.title}
                  </h3>
                  <div
                    className="v2-roadmap-desc v2-break"
                    dangerouslySetInnerHTML={{ __html: p.descriptionHtml }}
                  />
                  <span className="v2-field-hint">
                    {formatCount(p.votes)} vote{p.votes === 1 ? '' : 's'} · posted {p.ago}
                  </span>

                  {editingId === p.id ? (
                    <EditRow post={p} onSave={onSaveEdit} onCancel={() => setEditingId(null)} />
                  ) : (
                    <div className="v2-field-row v2-section-gap">
                      <button type="button" className="v2-btn-ghost" onClick={() => setEditingId(p.id)}>
                        Edit
                      </button>
                    </div>
                  )}
                </div>

                <div className="v2-row-actions v2-roadmap-admin-actions">
                  <select
                    aria-label={`Status of ${p.title}`}
                    value={p.status}
                    onChange={(e) => run(() => setRoadmapPostStatus(p.id, e.target.value))}
                  >
                    {d.statuses.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="v2-btn-danger" onClick={() => onDelete(p)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
