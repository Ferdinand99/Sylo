import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { searchMembers } from '../api.js';
import { rememberMember, useMemberNames } from '../memberNames.js';
import MentionMirror from './MentionMirror.jsx';
import '../styles/mention-mirror.css';
import {
  filterChannels,
  filterRoles,
  hasMentions,
  insertMention,
  mentionIsMissing,
  mentionLabel,
  mentionsIn,
  snapSelection,
  tokenEndingAt,
  tokenOf,
  tokenStartingAt,
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
 * A mention in the text is drawn as its name (a pill reading "#welcome") by a layer over the field
 * (MentionMirror) while the field itself keeps the real text, caret, selection and undo. A stored token
 * is one unit for the caret: the arrow keys step over it, Backspace and Delete remove all of it, and a
 * click or a selection never ends inside it.
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
  onMouseUp,
  onCompositionStart,
  onCompositionEnd,
  className = '',
  ...rest
}) {
  const { guildId } = useParams();
  const ref = useRef(null);
  // The field element as state too, so the mirror can be laid over it once it exists.
  const [field, setField] = useState(null);
  const setRef = useCallback((el) => {
    ref.current = el;
    setField(el);
  }, []);
  const composing = useRef(false);
  const listId = useId();
  const [trigger, setTrigger] = useState(null);
  const [active, setActive] = useState(0);
  const [people, setPeople] = useState([]);
  // Names of the members mentioned in the text: the ones picked or searched in this session, and the ones
  // the server can name for a mention that was saved earlier.
  const members = useMemberNames(rest.value);

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
          for (const m of list) rememberMember(guildId, m.id, m.name);
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
  // The mirror is for fields that wrap their text; a one-line input keeps showing its tokens as they are.
  const mirrored = Boolean(field) && field.tagName === 'TEXTAREA' && hasMentions(rest.value);

  /** Delete a range of the field the way typing would, so the browser keeps its undo history. */
  function removeRange(el, start, end) {
    el.focus();
    el.setSelectionRange(start, end);
    let done;
    try {
      done = typeof document.execCommand === 'function' && document.execCommand('delete');
    } catch {
      done = false;
    }
    if (!done) {
      const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(
        el,
        el.value.slice(0, start) + el.value.slice(end)
      );
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.setSelectionRange(start, start);
    }
  }

  /** A stored token next to the caret is one unit: Backspace/Delete remove it whole, arrows step over it. */
  function stepOverToken(e) {
    const el = ref.current;
    if (!el || composing.current || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (el.selectionStart !== el.selectionEnd) return false;
    const pos = el.selectionStart;
    const text = el.value;
    if (e.key === 'Backspace') {
      const t = tokenEndingAt(text, pos);
      if (!t) return false;
      removeRange(el, t.start, t.end);
      return true;
    }
    if (e.key === 'Delete') {
      const t = tokenStartingAt(text, pos);
      if (!t) return false;
      removeRange(el, t.start, t.end);
      return true;
    }
    if (e.key === 'ArrowLeft') {
      const t = tokenEndingAt(text, pos);
      if (!t) return false;
      if (e.shiftKey) el.setSelectionRange(t.start, t.end, 'backward');
      else el.setSelectionRange(t.start, t.start);
      return true;
    }
    if (e.key === 'ArrowRight') {
      const t = tokenStartingAt(text, pos);
      if (!t) return false;
      if (e.shiftKey) el.setSelectionRange(t.start, t.end, 'forward');
      else el.setSelectionRange(t.end, t.end);
      return true;
    }
    return false;
  }

  /** Move a caret or a range that ended up inside a token (a click, Up/Down, undo) out to its edges. */
  function snapToTokens() {
    const el = ref.current;
    if (!el || composing.current || document.activeElement !== el) return;
    const [start, end] = snapSelection(el.value, el.selectionStart, el.selectionEnd);
    if (start !== el.selectionStart || end !== el.selectionEnd) {
      el.setSelectionRange(start, end, el.selectionDirection ?? 'none');
    }
  }

  // Backspace and Delete on a keyboard that sends no key (a phone's) arrive only as input intents.
  useEffect(() => {
    if (!field) return undefined;
    const onBeforeInput = (e) => {
      if (composing.current || e.isComposing) return;
      if (e.inputType !== 'deleteContentBackward' && e.inputType !== 'deleteContentForward') return;
      if (field.selectionStart !== field.selectionEnd) return;
      const pos = field.selectionStart;
      const t =
        e.inputType === 'deleteContentBackward'
          ? tokenEndingAt(field.value, pos)
          : tokenStartingAt(field.value, pos);
      if (!t) return;
      e.preventDefault();
      removeRange(field, t.start, t.end);
    };
    field.addEventListener('beforeinput', onBeforeInput);
    return () => field.removeEventListener('beforeinput', onBeforeInput);
  }, [field]);

  function pick(s) {
    const el = ref.current;
    if (!el || !trigger) return;
    if (s.type === 'user') rememberMember(guildId, s.id, s.label.slice(1));
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
    if (!e.defaultPrevented && stepOverToken(e)) {
      e.preventDefault();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') lookupTrigger();
    }
  }

  return (
    <div className="v2-mention-wrap">
      <Tag
        {...rest}
        {...(typeof Tag === 'string' ? { ref: setRef } : { innerRef: setRef })}
        className={mirrored ? `${className} is-mirrored`.trim() : className}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
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
          snapToTokens();
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) lookupTrigger();
        }}
        onMouseUp={(e) => {
          onMouseUp?.(e);
          snapToTokens();
        }}
        onCompositionStart={(e) => {
          composing.current = true;
          onCompositionStart?.(e);
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          onCompositionEnd?.(e);
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
      {mirrored ? (
        <MentionMirror field={field} value={rest.value} channels={channels} roles={roles} members={members} />
      ) : null}
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
      {chips ? <MentionChips value={rest.value} channels={channels} roles={roles} members={members} /> : null}
    </div>
  );
}
