import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import ChipPicker from '../components/ChipPicker.jsx';

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

function toFormRow(b = {}) {
  return {
    key: newKey(),
    id: b.id || '',
    name: b.name || 'Starboard',
    channelId: b.channelId || '',
    emojiText: b.emojiText ?? '⭐',
    threshold: b.threshold ?? 3,
    multiPerUser: Boolean(b.multiPerUser),
    autoReact: b.autoReact !== false,
    autoReactFirstOnly: Boolean(b.autoReactFirstOnly),
    removeOnUnstar: b.removeOnUnstar !== false,
    repostCooldown: Boolean(b.repostCooldown),
    removeOnDelete: b.removeOnDelete !== false,
    ignoreSelfStars: b.ignoreSelfStars !== false,
    removeSelfStarReactions: Boolean(b.removeSelfStarReactions),
    ignoreBotMessages: b.ignoreBotMessages !== false,
    removeBotReactions: Boolean(b.removeBotReactions),
    minAgeMinutes: b.minAgeMinutes ?? 0,
    maxAgeMinutes: b.maxAgeMinutes ?? 0,
    roleMode: b.roleMode === 'deny' ? 'deny' : 'allow',
    roleList: b.roleList || [],
    channelMode: b.channelMode === 'deny' ? 'deny' : 'allow',
    channelList: b.channelList || [],
  };
}

const CHECKS_BEHAVIOUR = [
  ['autoReact', 'React to the starboard post with the board emoji(s)'],
  ['autoReactFirstOnly', '…but only with the first emoji'],
  ['removeOnDelete', 'Delete the starboard post if the original message is deleted'],
  ['removeOnUnstar', 'Remove the post if it drops back below the threshold'],
  ['repostCooldown', 'After a post is removed, wait a minute before it can return'],
];
const CHECKS_ANTIABUSE = [
  ['ignoreSelfStars', "Don't count the author reacting to their own message"],
  ['removeSelfStarReactions', '…and remove that reaction when they do'],
  ['ignoreBotMessages', 'Ignore messages posted by bots'],
  ['removeBotReactions', '…and clear reactions members add to bot messages'],
];

export default function Starboard() {
  const { guildId } = useParams();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function load() {
    return getModuleConfig(guildId, 'starboard')
      .then((data) => {
        setState({ loading: false, data, error: null });
        setForm({ boards: data.config.boards.map(toFormRow) });
      })
      .catch((error) => setState({ loading: false, data: null, error }));
  }

  useEffect(() => {
    load();
  }, [guildId]);

  if ((state.loading && !state.data) || !form) return <p className="v2-state">Loading…</p>;
  if (state.error) {
    const notAuthed = state.error instanceof ApiError && state.error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/discord/login">log in again</a>.
          </>
        ) : (
          `Couldn't load Starboard settings (${state.error.message}).`
        )}
      </p>
    );
  }

  const d = state.data;

  const updateBoard = (key, patch) =>
    setForm((f) => ({ boards: f.boards.map((b) => (b.key === key ? { ...b, ...patch } : b)) }));
  const addBoard = () => setForm((f) => ({ boards: [...f.boards, toFormRow()] }));
  const removeBoard = (key) => setForm((f) => ({ boards: f.boards.filter((b) => b.key !== key) }));

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const body = {
        boards: form.boards.map((b) => {
          const copy = { ...b, emojis: b.emojiText };
          delete copy.key;
          delete copy.emojiText;
          return copy;
        }),
      };
      const { config } = await saveModuleConfig(guildId, 'starboard', body);
      setForm({ boards: config.boards.map(toFormRow) });
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Starboard</h1>
      <p className="v2-field-hint">
        When a message gets enough of a reaction, Sylo re-posts it into a highlights channel — like a
        community pin board. Each board has its own emoji, threshold and rules.
      </p>

      <form onSubmit={onSave}>
        {form.boards.map((b) => (
          <div className="v2-rule-card" key={b.key}>
            <div className="v2-rule-head">
              <span className="v2-field-hint">Board</span>
              <button type="button" className="v2-btn-ghost" onClick={() => removeBoard(b.key)}>
                remove
              </button>
            </div>

            <div className="v2-field-row">
              <div className="v2-field">
                <label>
                  Name <span className="v2-field-hint">— shown on the dashboard only</span>
                </label>
                <input
                  type="text"
                  maxLength={60}
                  placeholder="Starboard"
                  value={b.name}
                  onChange={(e) => updateBoard(b.key, { name: e.target.value })}
                />
              </div>
              <div className="v2-field">
                <label>Starboard channel</label>
                <select
                  value={b.channelId}
                  onChange={(e) => updateBoard(b.key, { channelId: e.target.value })}
                >
                  <option value="">— select a channel —</option>
                  {d.channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="v2-field">
              <label>Emoji(s)</label>
              <input
                type="text"
                placeholder="⭐"
                value={b.emojiText}
                onChange={(e) => updateBoard(b.key, { emojiText: e.target.value })}
              />
              <p className="v2-field-hint">
                Space-separated. Paste custom emojis directly. First emoji is the one shown on the post.
              </p>
            </div>

            <div className="v2-field-row">
              <div className="v2-field">
                <label>Reactions needed</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  style={{ maxWidth: '100px' }}
                  value={b.threshold}
                  onChange={(e) => updateBoard(b.key, { threshold: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="v2-field">
              <label className="v2-check">
                <input
                  type="checkbox"
                  checked={b.multiPerUser}
                  onChange={(e) => updateBoard(b.key, { multiPerUser: e.target.checked })}
                />
                Count every matching emoji from a user, not just one
              </label>
            </div>

            <h3 className="v2-field-hint u-mt-2">Behaviour</h3>
            <div className="v2-field">
              {CHECKS_BEHAVIOUR.map(([key, label]) => (
                <label className="v2-check" key={key}>
                  <input
                    type="checkbox"
                    checked={b[key]}
                    onChange={(e) => updateBoard(b.key, { [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>

            <h3 className="v2-field-hint u-mt-2">Anti-abuse</h3>
            <div className="v2-field">
              {CHECKS_ANTIABUSE.map(([key, label]) => (
                <label className="v2-check" key={key}>
                  <input
                    type="checkbox"
                    checked={b[key]}
                    onChange={(e) => updateBoard(b.key, { [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="v2-field-row">
              <div className="v2-field">
                <label>Ignore messages younger than (minutes)</label>
                <input
                  type="number"
                  min={0}
                  style={{ maxWidth: '100px' }}
                  value={b.minAgeMinutes}
                  onChange={(e) => updateBoard(b.key, { minAgeMinutes: Number(e.target.value) })}
                />
              </div>
              <div className="v2-field">
                <label>
                  Ignore messages older than (minutes) <span className="v2-field-hint">— 0 = no limit</span>
                </label>
                <input
                  type="number"
                  min={0}
                  style={{ maxWidth: '100px' }}
                  value={b.maxAgeMinutes}
                  onChange={(e) => updateBoard(b.key, { maxAgeMinutes: Number(e.target.value) })}
                />
              </div>
            </div>

            <h3 className="v2-field-hint u-mt-2">Restrictions</h3>
            <div className="v2-field">
              <label>Whose reactions count</label>
              <select value={b.roleMode} onChange={(e) => updateBoard(b.key, { roleMode: e.target.value })}>
                <option value="allow">Everyone except the roles below</option>
                <option value="deny">Only members with a role below</option>
              </select>
            </div>
            <ChipPicker
              kind="role"
              items={d.roles}
              value={b.roleList}
              onChange={(roleList) => updateBoard(b.key, { roleList })}
            />

            <div className="v2-field u-mt-2">
              <label>Which channels this board watches</label>
              <select
                value={b.channelMode}
                onChange={(e) => updateBoard(b.key, { channelMode: e.target.value })}
              >
                <option value="allow">Every channel except the ones below</option>
                <option value="deny">Only the channels below</option>
              </select>
            </div>
            <ChipPicker
              kind="channel"
              items={d.channels}
              value={b.channelList}
              onChange={(channelList) => updateBoard(b.key, { channelList })}
            />
          </div>
        ))}
        <button type="button" className="v2-btn-ghost" onClick={addBoard}>
          + Add board
        </button>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved ? <span className="v2-field-hint"> Saved.</span> : null}
        </div>
      </form>
    </>
  );
}
