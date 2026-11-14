import { Link, useParams } from 'react-router-dom';
import { getComposedMessages, unpublishComposedMessage, deleteComposedMessage } from '../api.js';
import LoadError from '../components/LoadError.jsx';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';
import Reveal from '../components/Reveal.jsx';
import Badge from '../components/Badge.jsx';
import Meta from '../components/Meta.jsx';
import ListPageHead from '../components/ListPageHead.jsx';
import RowActions from '../components/RowActions.jsx';
import EmptyList from '../components/EmptyList.jsx';

export default function Messages() {
  const { guildId } = useParams();
  const { data, loading, error, setData } = useApiData(() => getComposedMessages(guildId), [guildId]);

  if (error) return <LoadError error={error} what="Embed messages" />;
  if (loading && !data) return <p className="v2-state">Loading…</p>;

  async function onUnpublish(id) {
    const ok = await confirmDialog({
      title: 'Unpublish this message?',
      body: 'The posted message is deleted from the channel. The draft stays here, so you can publish it again.',
      confirmLabel: 'Unpublish',
    });
    if (!ok) return;
    try {
      await unpublishComposedMessage(guildId, id);
      setData((d) => ({
        ...d,
        items: d.items.map((it) => (it.id === id ? { ...it, published: false } : it)),
      }));
    } catch (err) {
      notify(err.message);
    }
  }

  async function onDelete(id) {
    const ok = await confirmDialog({
      title: 'Delete this embed message?',
      body: "The draft is deleted, and so is the posted message if it's published. This can't be undone.",
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await deleteComposedMessage(guildId, id);
      setData((d) => ({ ...d, items: d.items.filter((it) => it.id !== id) }));
    } catch (err) {
      notify(err.message);
    }
  }

  return (
    <Reveal>
      <ListPageHead
        title="Embed messages"
        // With nothing saved the empty state below carries the one accent button.
        action={
          data.items.length === 0 ? null : (
            <Link className="v2-btn-primary" to={`/guilds/${guildId}/messages/new`}>
              + New embed message
            </Link>
          )
        }
      >
        <p className="v2-field-hint">
          Build rich embed messages with a live editor, then publish them to a channel as Sylo — and
          re-publish to edit the posted message in place.
        </p>
      </ListPageHead>

      <h2 className="v2-group-title v2-section-gap">Your embed messages ({data.items.length} / 200)</h2>
      {data.items.length === 0 ? (
        <EmptyList
          start={{ label: 'Create your first embed message', to: `/guilds/${guildId}/messages/new` }}
        >
          Build a rich message with a live preview, then publish it to a channel as Sylo.
        </EmptyList>
      ) : (
        <div className="v2-list">
          {data.items.map((it) => (
            <div className="v2-row v2-row-stack" key={it.id}>
              <div className="v2-row-main">
                <Link className="v2-row-title-link" to={`/guilds/${guildId}/messages/${it.id}`}>
                  <h3>
                    {it.name}
                    <Badge tone={it.published ? 'success' : 'neutral'} inline>
                      {it.published ? 'Published' : 'Draft'}
                    </Badge>
                  </h3>
                </Link>
                <p>
                  <Meta items={[`#${it.channel}`, `edited ${it.when}`]} />
                </p>
              </div>
              <RowActions
                edit={{ to: `/guilds/${guildId}/messages/${it.id}` }}
                menuLabel={`More actions for ${it.name}`}
                items={[
                  it.published && { label: 'Unpublish', onClick: () => onUnpublish(it.id) },
                  { label: 'Delete', danger: true, onClick: () => onDelete(it.id) },
                ].filter(Boolean)}
              />
            </div>
          ))}
        </div>
      )}
    </Reveal>
  );
}
