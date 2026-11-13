import { useEffect, useId, useState } from 'react';
import { useParams } from 'react-router-dom';
import { searchMembers } from '../api.js';
import { rememberMember, useMemberNames } from '../memberNames.js';

const MIN_QUERY = 2;

/**
 * Pick one member by name instead of pasting an id: type two letters, pick from the members Sylo knows.
 * The chosen member shows as a name with a button to clear it. `value` is the member id ('' for nobody).
 *
 *   <MemberPicker id="as-user" label="Member" value={userId} onChange={setUserId} />
 */
export default function MemberPicker({ id, value, onChange, placeholder = 'All members' }) {
  const { guildId } = useParams();
  const listId = useId();
  const [text, setText] = useState('');
  const [found, setFound] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const names = useMemberNames(value ? `<@${value}>` : '');
  const shown = value ? (names.get(value) ?? 'This member') : '';

  useEffect(() => {
    const q = text.trim();
    if (q.length < MIN_QUERY) {
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
    rememberMember(guildId, m.id, m.name);
    onChange(m.id);
    setText('');
    setFound([]);
    setOpen(false);
  }

  if (value) {
    return (
      <div className="v2-member-picked">
        <span className="v2-mention-chip" id={id}>
          @{shown}
        </span>
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

  const list = open ? found : [];
  return (
    <div className="v2-mention-wrap">
      <input
        id={id}
        type="search"
        role="combobox"
        aria-expanded={list.length > 0}
        aria-controls={list.length ? listId : undefined}
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
      {text.trim().length > 0 && text.trim().length < MIN_QUERY ? (
        <p className="v2-field-hint">Type at least two letters of a name.</p>
      ) : null}
      {list.length ? (
        <ul className="v2-mention-pop" role="listbox" id={listId} aria-label="Members">
          {list.map((m, i) => (
            <li
              key={m.id}
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
              {m.name}
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
