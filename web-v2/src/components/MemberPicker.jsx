import { useEffect, useId, useState } from 'react';
import { useParams } from 'react-router-dom';
import { searchMembers } from '../api.js';
import { rememberMember, useMemberNames } from '../memberNames.js';
import '../styles/wp1-members.css';

const MIN_QUERY = 2;
const TOKEN = /<@!?(\d{17,20})>|\b(\d{17,20})\b/g;

/**
 * The member ids in a pasted text: bare ids (17 to 20 digits) and `<@id>` mentions, separated by spaces or
 * commas. Empty when the text holds anything else (a name being typed, or an id with words around it), so
 * a name is never mistaken for a paste. Each id appears once, in order.
 */
export function parseMemberIds(text) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  if (source.replace(TOKEN, '').replace(/[\s,;]+/g, '')) return [];
  const ids = [];
  for (const m of source.matchAll(TOKEN)) {
    const memberId = m[1] ?? m[2];
    if (!ids.includes(memberId)) ids.push(memberId);
  }
  return ids;
}

/**
 * Pick a member by name instead of pasting an id: type two letters, pick from the members Sylo knows. A
 * member who has left, or who Sylo has not cached, can still be picked by pasting the member's id (17 to
 * 20 digits) or a `<@id>` mention, which is offered as the one option. The chosen member shows as a name
 * with a button to clear it. `value` is the member id ('' for nobody). `clearLabel` names what the clear
 * button clears, for a screen reader. Give `label` when no visible <label htmlFor={id}> names the field.
 *
 *   <MemberPicker id="as-user" value={userId} onChange={setUserId} />
 *
 * With `multiple`, `value` is a list of ids and `onChange` gets the new list, in the order the members were
 * picked. The chosen members show as removable chips in front of the field, which stays open for the next
 * one. Several ids pasted together (spaces or commas between them) are added in one go; `max` caps the list.
 *
 *   <MemberPicker multiple id="targets" value={ids} onChange={setIds} max={25} />
 */
export default function MemberPicker({
  id,
  value,
  onChange,
  placeholder = 'All members',
  clearLabel = 'Clear the member filter',
  label,
  multiple = false,
  max,
}) {
  const { guildId } = useParams();
  const listId = useId();
  const [text, setText] = useState('');
  const [found, setFound] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const chosen = multiple ? (Array.isArray(value) ? value : []) : value ? [value] : [];
  const names = useMemberNames(...chosen.map((m) => `<@${m}>`));
  // A member the server cannot name (left, or not cached) shows by the end of the id.
  const nameOf = (memberId) => names.get(memberId) ?? `member …${memberId.slice(-4)}`;
  const shown = !multiple && value ? nameOf(value) : '';
  const full = multiple && max != null && chosen.length >= max;
  const typed = text.trim();
  const pastedAll = parseMemberIds(typed);

  useEffect(() => {
    const q = text.trim();
    if (q.length < MIN_QUERY || parseMemberIds(q).length) {
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
    if (multiple) {
      const add = (m.ids ?? [m.id]).filter((x) => !chosen.includes(x));
      const room = max != null ? Math.max(0, max - chosen.length) : add.length;
      onChange([...chosen, ...add.slice(0, room)]);
    } else {
      onChange(m.id);
      setOpen(false);
    }
    setText('');
    setFound([]);
  }

  function remove(memberId) {
    onChange(chosen.filter((x) => x !== memberId));
  }

  if (!multiple && value) {
    return (
      <div className="v2-member-picked">
        {/* an <output> so the field's label still points at something labelable */}
        <output className="v2-mention-chip" id={id}>
          @{shown}
        </output>
        <button
          type="button"
          className="v2-btn-ghost v2-member-clear"
          aria-label={`${clearLabel} (${shown})`}
          onClick={() => onChange('')}
        >
          Clear
        </button>
      </div>
    );
  }

  // A pasted id (or mention) is one option of its own; names come from the search.
  const fresh = pastedAll.filter((x) => !chosen.includes(x));
  let list;
  if (!open || full) list = [];
  else if (pastedAll.length === 1) {
    list = fresh.length ? [{ id: fresh[0], name: '', label: `Use the member id ${fresh[0]}` }] : [];
  } else if (pastedAll.length > 1) {
    list =
      multiple && fresh.length
        ? [{ id: fresh[0], ids: fresh, name: '', label: `Add ${fresh.length} members` }]
        : [];
  } else {
    list = found.filter((m) => !chosen.includes(m.id)).map((m) => ({ ...m, label: m.name }));
  }
  const optionId = (i) => `${listId}-${i}`;
  const fieldPlaceholder = full
    ? `At most ${max} members`
    : multiple && chosen.length
      ? 'Add another…'
      : placeholder;
  const field = (
    <div className="v2-mention-wrap">
      <input
        id={id}
        type="search"
        aria-label={label}
        role="combobox"
        aria-expanded={list.length > 0}
        aria-controls={list.length ? listId : undefined}
        aria-activedescendant={list.length ? optionId(active) : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={fieldPlaceholder}
        disabled={full}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          // Backspace in an empty field takes the last chip back.
          if (multiple && e.key === 'Backspace' && !text && chosen.length) {
            remove(chosen[chosen.length - 1]);
            return;
          }
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
      {typed.length > 0 && typed.length < MIN_QUERY && !pastedAll.length ? (
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
  if (!multiple) return field;
  return (
    <div className="v2-member-multi">
      {chosen.length ? (
        <ul className="v2-member-chips" aria-label="Chosen members">
          {chosen.map((memberId) => (
            <li className="v2-chip" key={memberId}>
              <span className="v2-chip-name">@{nameOf(memberId)}</span>
              <button
                type="button"
                className="v2-chip-x"
                aria-label={`Remove ${nameOf(memberId)}`}
                onClick={() => remove(memberId)}
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {field}
    </div>
  );
}
