import { useEffect, useId, useState } from 'react';
import { useParams } from 'react-router-dom';
import { searchMembers } from '../api.js';
import { rememberMember, useMemberNames } from '../memberNames.js';

const MIN_QUERY = 2;
const ID = /^\d{17,20}$/;

/**
 * Pick one member by name instead of pasting an id: type two letters, pick from the members Sylo knows.
 * A member who has left, or who Sylo has not cached, can still be picked by pasting the member's id (17 to
 * 20 digits), which is offered as the one option. The chosen member shows as a name with a button to clear
 * it. `value` is the member id ('' for nobody).
 *
 *   <MemberPicker id="as-user" value={userId} onChange={setUserId} />
 */
export default function MemberPicker({ id, value, onChange, placeholder = 'All members' }) {
  const { guildId } = useParams();
  const listId = useId();
  const [text, setText] = useState('');
  const [found, setFound] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const names = useMemberNames(value ? `<@${value}>` : '');
  // A member the server cannot name (left, or not cached) shows by the end of the id.
  const shown = value ? (names.get(value) ?? `member …${value.slice(-4)}`) : '';

  useEffect(() => {
    const q = text.trim();
    if (q.length < MIN_QUERY || ID.test(q)) {
      setFound([]);
      return undefined;
    }
    let live = true;
    const t = setTimeout(() => {
      Promise.resolve()
        .then(() => searchMembers(guildId, q))
        .then((res) => live && setFound(Array.isArray(res?.members) ? res.members : []))
        .catch(() => live && setFound([]));
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [text, guildId]);

  function pick(m) {
    if (m.name) rememberMember(guildId, m.id, m.name);
    onChange(m.id);
    setText('');
    setFound([]);
    setOpen(false);
  }

  if (value) {
    return (
      <div className="v2-member-picked">
        {/* an <output> so the field's label still points at something labelable */}
        <output className="v2-mention-chip" id={id}>
          @{shown}
        </output>
        <button
          type="button"
          className="v2-btn-ghost v2-member-clear"
          aria-label={`Clear the member filter (${shown})`}
          onClick={() => onChange('')}
        >
          Clear
        </button>
      </div>
    );
  }

  const typed = text.trim();
  // A pasted id is one option of its own; names come from the search.
  const list = !open
    ? []
    : ID.test(typed)
      ? [{ id: typed, name: '', label: `Use the member id ${typed}` }]
      : found.map((m) => ({ ...m, label: m.name }));
  const optionId = (i) => `${listId}-${i}`;
  return (
    <div className="v2-mention-wrap">
      <input
        id={id}
        type="search"
        role="combobox"
        aria-expanded={list.length > 0}
        aria-controls={list.length ? listId : undefined}
        aria-activedescendant={list.length ? optionId(active) : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!list.length) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(list[active] ?? list[0]);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {typed.length > 0 && typed.length < MIN_QUERY ? (
        <p className="v2-field-hint">Type at least two letters of a name, or paste a member id.</p>
      ) : null}
      {list.length ? (
        <ul className="v2-mention-pop" role="listbox" id={listId} aria-label="Members">
          {list.map((m, i) => (
            <li
              key={m.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={`v2-mention-option${i === active ? ' is-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="v2-mention-kind" aria-hidden="true">
                @
              </span>
              {m.label}
              {m.username && m.username !== m.name ? (
                <span className="v2-field-hint"> {m.username}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
