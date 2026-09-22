import { Link, useParams } from 'react-router-dom';
import { getComposedMessages, unpublishComposedMessage, deleteComposedMessage, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

export default function Messages() {
  const { guildId } = useParams();
  const { data, loading, error, setData } = useApiData(() => getComposedMessages(guildId), [guildId]);

  if (loading && !data) return <p className="v2-state">Loading…</p>;

  if (error) {
    const notAuthed = error instanceof ApiError && error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/discord/login">log in again</a>.
          </>
        ) : (
          `Couldn't load Embed messages (${error.message}).`
        )}
      </p>
    );
  }

  async function onUnpublish(id) {
    if (!confirm('Delete the posted message? The draft stays here.')) return;
    try {
      await unpublishComposedMessage(guildId, id);
      setData((d) => ({
        ...d,
        items: d.items.map((it) => (it.id === id ? { ...it, published: false } : it)),
      }));
    } catch (err) {
      alert(err.message);
    }
  }

  async function onDelete(id) {
    if (!confirm('Delete this embed message (and the posted message, if any)?')) return;
    try {
      await deleteComposedMessage(guildId, id);
      setData((d) => ({ ...d, items: d.items.filter((it) => it.id !== id) }));
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <>
      <div className="v2-page-head">
        <h1 className="v2-section-title">Embed messages</h1>
        <Link className="v2-btn-primary" to={`/guilds/${guildId}/messages/new`}>
          + New embed message
        </Link>
      </div>
      <p className="v2-field-hint">
        Build rich embed messages with a live editor, then publish them to a channel as Sylo — and re-publish
        to edit the posted message in place.
      </p>

      <h2 className="v2-group-title v2-section-gap">Your embed messages ({data.items.length} / 200)</h2>
      {data.items.length === 0 ? (
        <p className="v2-field-hint">None yet — create one to post an embed to a channel.</p>
      ) : (
        <div className="v2-list">
          {data.items.map((it) => (
            <div className="v2-row" key={it.id}>
              <div className="v2-row-main">
                <Link className="v2-row-title-link" to={`/guilds/${guildId}/messages/${it.id}`}>
                  <h3>{it.name}</h3>
                </Link>
                <p>
                  #{it.channel} · edited {it.when}
                </p>
              </div>
              <div className="v2-field-row">
                <span className={`v2-toggle${it.published ? ' is-on' : ''}`} aria-hidden="true" />
                <span className="v2-field-hint">{it.published ? 'published' : 'draft'}</span>
                {it.published ? (
                  <button type="button" className="v2-btn-ghost" onClick={() => onUnpublish(it.id)}>
                    Unpublish
                  </button>
                ) : null}
                <button type="button" className="v2-btn-ghost" onClick={() => onDelete(it.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
