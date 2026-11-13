import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { searchMembers } from '../api.js';
import {
  filterChannels,
  filterRoles,
  insertMention,
  mentionIsMissing,
  mentionLabel,
  mentionsIn,
  tokenOf,
  triggerAt,
} from '../mentions.js';

/**
 * The names of the channels, roles and members a text mentions, as small chips under the field, so a
 * person reads "#welcome" and "@Verified" and not <#1000…>. A channel or role that was deleted is marked.
 */
export function MentionChips({ value, channels = [], roles = [], members = new Map() }) {
  const found = mentionsIn(value);
  if (!found.length) return null;
  const lookup = { channels, roles, members };
  return (
    <ul className="v2-mention-chips" aria-label="Mentions in this text">
      {found.map((part) => {
        const missing = mentionIsMissing(part, lookup);
        return (
          <li
            key={`${part.type}:${part.id ?? part.name}`}
            className={`v2-mention-chip is-${part.type}${missing ? ' is-missing' : ''}`}
            title={missing ? 'This channel or role no longer exists' : undefined}
          >
            {mentionLabel(part, lookup)}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A textarea (or a single-line input with `as="input"`) for message text. Typing # opens the channels of
 * the server, typing @ its roles (and @everyone, @here) and members; picking one writes the right mention
 * token into the text and the names are shown as chips below. Everything else is a normal field: the same
 * props, the same onChange (it fires for a picked mention exactly as it does for typing).
 *
 *   <MentionTextarea id="joinMessage" rows={3} value={…} onChange={…} channels={data.channels} roles={data.roles} />
 */
export default function MentionTextarea({
  as: Tag = 'textarea',
  channels = [],
  roles = [],
  chips = true,
  onKeyDown,
  onKeyUp,
  onClick,
  onBlur,
  onInput,
  className = '',
  ...rest
}) {
  const { guildId } = useParams();
  const ref = useRef(null);
  const listId = useId();
  const [trigger, setTrigger] = useState(null);
  const [active, setActive] = useState(0);
  const [people, setPeople] = useState([]);
  // Names of members seen in this session (picked or searched), for the chips.
  const names = useRef(new Map());
  const [, bump] = useState(0);

  const lookupTrigger = () => {
    const el = ref.current;
    setTrigger(el ? triggerAt(el.value, el.selectionStart) : null);
    setActive(0);
  };

  // Members are searched on the server (the ones Sylo has cached) once at least one letter is typed.
  const memberQuery = trigger?.kind === 'mention' ? trigger.query : '';
  useEffect(() => {
    if (!memberQuery) {
      setPeople([]);
      return undefined;
    }
    let live = true;
    const t = setTimeout(() => {
      Promise.resolve()
        .then(() => searchMembers(guildId, memberQuery))
        .then((res) => {
          if (!live) return;
          const list = Array.isArray(res?.members) ? res.members : [];
          for (const m of list) names.current.set(m.id, m.name);
          setPeople(list);
        })
        .catch(() => live && setPeople([]));
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [memberQuery, guildId]);

  const suggestions = useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === 'channel') {
      return filterChannels(channels, trigger.query).map((c) => ({
        type: 'channel',
        id: c.id,
        label: `#${c.name}`,
      }));
    }
    const found = filterRoles(roles, trigger.query);
    const users = people.map((m) => ({ type: 'user', id: m.id, label: `@${m.name}` }));
    return [...found, ...users].slice(0, 8);
  }, [trigger, channels, roles, people]);
  const open = suggestions.length > 0;

  function pick(s) {
    const el = ref.current;
    if (!el || !trigger) return;
    if (s.type === 'user') names.current.set(s.id, s.label.slice(1));
    const caret = el.selectionStart;
    const next = insertMention(el.value, trigger, caret, tokenOf(s));
    el.focus();
    el.setSelectionRange(trigger.start, caret);
    // Typing-like insert first: the browser keeps its undo history and fires the field's own input
    // event. Where that is not supported the value is set directly and the same event is fired.
    const inserted = next.value.slice(trigger.start, next.caret);
    let done;
    try {
      done =
        typeof document.execCommand === 'function' && document.execCommand('insertText', false, inserted);
    } catch {
      done = false;
    }
    if (!done) {
      const proto = Tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, next.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.setSelectionRange(next.caret, next.caret);
    }
    setTrigger(null);
    bump((n) => n + 1);
  }

  function handleKeyDown(e) {
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((a) => (a + step + suggestions.length) % suggestions.length);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        pick(suggestions[active] ?? suggestions[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setTrigger(null);
        return;
      }
    }
    onKeyDown?.(e);
  }

  const lookup = { channels, roles, members: names.current };
  return (
    <div className="v2-mention-wrap">
      <Tag
        {...rest}
        {...(typeof Tag === 'string' ? { ref } : { innerRef: ref })}
        className={className}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onInput={(e) => {
          onInput?.(e);
          lookupTrigger();
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={(e) => {
          onKeyUp?.(e);
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) lookupTrigger();
        }}
        onClick={(e) => {
          onClick?.(e);
          lookupTrigger();
        }}
        onBlur={(e) => {
          onBlur?.(e);
          setTrigger(null);
        }}
      />
      {open ? (
        <ul
          className="v2-mention-pop"
          role="listbox"
          id={listId}
          aria-label={trigger.kind === 'channel' ? 'Channels' : 'Roles and members'}
        >
          {suggestions.map((s, i) => (
            <li
              key={`${s.type}:${s.id ?? s.name}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`v2-mention-option${i === active ? ' is-active' : ''}`}
              // mousedown, not click: the field must keep its focus (and caret) while one is picked.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className={`v2-mention-kind is-${s.type}`} aria-hidden="true">
                {s.type === 'channel' ? '#' : '@'}
              </span>
              {s.label.slice(1)}
            </li>
          ))}
        </ul>
      ) : null}
      {chips ? (
        <MentionChips value={rest.value} channels={channels} roles={roles} members={lookup.members} />
      ) : null}
    </div>
  );
}
