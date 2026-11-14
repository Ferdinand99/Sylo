import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { searchInbox, searchMembers } from '../api.js';
import { useOverview } from '../OverviewContext.jsx';
import { useOperator } from '../useOperator.js';
import { groupItems, paletteItems, rankItems, readRecent, rememberRecent } from '../paletteModel.js';
import { parseMemberIds } from './MemberPicker.jsx';
import { Icon } from './icons.jsx';

const MIN_QUERY = 2;
const SEARCH_DELAY_MS = 220;
const CLOSE_MS = 150;
// The same shape the server reads (src/web/routes/v2Search.js): an optional kind, then a number.
const INBOX_QUERY = /^(?:(ticket|suggestion|appeal|application)s?\s*)?#?\s*\d{1,9}$/i;
const KIND_LABEL = {
  ticket: 'Ticket',
  suggestion: 'Suggestion',
  appeal: 'Appeal',
  application: 'Application',
};
// Matches /guilds/:id or /guilds/:id/<subpath>, like the server switcher: a server picked on a server page
// opens the same page there.
const GUILD_PAGE = /^\/guilds\/[^/]+(\/.*)?$/;

/** Whether this is an Apple device (a Mac, an iPad with a keyboard): its primary modifier is Command. */
export function isApplePlatform() {
  return (
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  );
}

/**
 * Whether the keyboard event is the shortcut for the palette: the platform's primary modifier and K, so
 * Command+K on Apple devices and Ctrl+K elsewhere. The other modifier is never taken: Ctrl+K on a Mac is
 * "delete to the end of the line" in a text field.
 */
export function isPaletteShortcut(e) {
  const primary = isApplePlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return Boolean(primary) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 'k';
}

const memberItem = (guildId, id, label, hint = '') => ({
  key: `member:${id}`,
  group: 'Members',
  label,
  hint,
  icon: 'database',
  href: `/guilds/${guildId}/member-data?user=${encodeURIComponent(id)}`,
  transient: true,
});

/**
 * The items found on the server for the typed text: members by name (the existing member search), and an
 * inbox item by number. Both are asked after a short pause and only when the text can mean it. The answer
 * carries the text it is for, so a late answer never shows under a newer text.
 */
function useServerMatches(guildId, text) {
  const [found, setFound] = useState({ text: '', items: [] });
  const typed = text.trim();

  useEffect(() => {
    const byNumber = INBOX_QUERY.test(typed);
    const byKind = byNumber && /^\D/.test(typed);
    const byName = typed.length >= MIN_QUERY && !byKind && !parseMemberIds(typed).length;
    if (!guildId || (!byNumber && !byName)) return undefined;
    let live = true;
    const t = setTimeout(async () => {
      const items = [];
      if (byName) {
        const res = await Promise.resolve()
          .then(() => searchMembers(guildId, typed))
          .catch(() => null);
        for (const m of Array.isArray(res?.members) ? res.members.slice(0, 5) : [])
          items.push(memberItem(guildId, m.id, `Open member data for ${m.name}`, m.username));
      }
      if (byNumber) {
        const res = await Promise.resolve()
          .then(() => searchInbox(guildId, typed))
          .catch(() => null);
        for (const it of Array.isArray(res?.items) ? res.items : [])
          items.unshift({
            key: `inbox:${it.kind}:${it.number}`,
            group: 'Inbox items',
            label: `${KIND_LABEL[it.kind] ?? it.kind} #${it.number}`,
            hint: it.status,
            icon: it.kind === 'ticket' ? 'inbox' : it.kind === 'appeal' ? 'flag' : 'clipboard',
            href: it.href,
            transient: true,
          });
      }
      if (live) setFound({ text: typed, items });
    }, SEARCH_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [guildId, typed]);

  return found.text === typed ? found.items : [];
}

function PaletteDialog({ onClose, guildId, guilds }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data: shared, dataGuildId } = useOverview();
  const data = dataGuildId === guildId ? shared : null;
  const operator = useOperator();
  const dialogRef = useRef(null);
  const settled = useRef(false);
  const titleId = useId();
  const listId = useId();
  const [shown, setShown] = useState(false);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [recent] = useState(readRecent);

  const items = useMemo(
    () => paletteItems({ guildId, data, operator, guilds }),
    [guildId, data, operator, guilds]
  );
  const found = useServerMatches(guildId, text);
  // A pasted member id (or a mention) is a place to open without asking the server.
  const pasted = useMemo(() => {
    const ids = guildId ? parseMemberIds(text) : [];
    return ids.length === 1 ? [memberItem(guildId, ids[0], `Open member data for member id ${ids[0]}`)] : [];
  }, [guildId, text]);
  const list = useMemo(
    () => rankItems(items, text, recent, [...pasted, ...found]),
    [items, text, recent, pasted, found]
  );
  const groups = useMemo(() => groupItems(list), [list]);
  // The options in the order they are drawn (grouped), so the arrow keys follow what is on screen.
  const flat = useMemo(
    () => groups.flatMap((g) => g.items.map((item) => ({ item, group: g.group }))),
    [groups]
  );
  const optionId = (i) => `${listId}-${i}`;
  const current = Math.min(active, Math.max(0, flat.length - 1));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    setActive(0);
  }, [text]);

  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [current, flat, listId]);

  function finish() {
    if (settled.current) return;
    settled.current = true;
    setShown(false);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setTimeout(
      () => {
        dialogRef.current?.close?.();
        onClose();
      },
      reduce ? 0 : CLOSE_MS
    );
  }

  function open(entry) {
    if (!entry) return;
    const { item } = entry;
    if (!item.transient) rememberRecent(item.key);
    let href = item.href;
    if (item.key.startsWith('guild:')) {
      const m = pathname.match(GUILD_PAGE);
      if (m) href = `${item.href}${m[1] ?? ''}`;
    }
    navigate(href);
    finish();
  }

  // The shortcut that opened the palette closes it again, through the same animated path as Esc, so the
  // focus goes back to where it was. (Shell.jsx only opens.)
  useEffect(() => {
    function onShortcut(e) {
      if (!isPaletteShortcut(e)) return;
      e.preventDefault();
      finish();
    }
    document.addEventListener('keydown', onShortcut);
    return () => document.removeEventListener('keydown', onShortcut);
    // finish only reads refs and the stable onClose of the opening
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(e) {
    // A key that belongs to an input method (picking or confirming a candidate of a CJK keyboard) is not
    // for the list. Safari reports the Enter that ends a composition as keyCode 229 after the compositionend.
    if (e.nativeEvent?.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      finish();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!flat.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((current + step + flat.length) % flat.length);
    } else if (e.key === 'Home' && !text) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && !text) {
      e.preventDefault();
      setActive(Math.max(0, flat.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      open(flat[current]);
    }
  }

  let index = -1;
  return (
    <dialog
      ref={dialogRef}
      className={`v2-palette-dialog${shown ? ' is-open' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        finish();
      }}
      onClose={finish}
      onMouseDown={(e) => {
        if (e.target === dialogRef.current) finish();
      }}
    >
      <div className="v2-palette">
        <h2 id={titleId} className="v2-sr-only">
          Search the dashboard
        </h2>
        <div className="v2-palette-field">
          <Icon name="search" className="v2-palette-field-icon" />
          <input
            type="text"
            className="v2-palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={flat.length ? optionId(current) : undefined}
            aria-autocomplete="list"
            aria-label="Search pages, modules, members and inbox items"
            placeholder="Search pages, modules, members…"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="button" className="v2-palette-close" onClick={finish}>
            Close
          </button>
        </div>
        <div className="v2-palette-results">
          <div id={listId} role="listbox" aria-label="Results">
            {groups.map((g) => (
              <div key={g.group} role="group" aria-label={g.group} className="v2-palette-group">
                <div className="v2-palette-heading" aria-hidden="true">
                  {g.group}
                </div>
                {g.items.map((item) => {
                  index += 1;
                  const i = index;
                  return (
                    <div
                      key={`${g.group}:${item.key}`}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === current}
                      className={`v2-palette-option${i === current ? ' is-active' : ''}`}
                      onMouseMove={() => i !== current && setActive(i)}
                      // Keep the focus in the field: the press is what picks, not a focus change.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => open({ item })}
                    >
                      <Icon name={item.icon} className="v2-palette-option-icon" />
                      <span className="v2-palette-label">{item.label}</span>
                      {item.hint ? <span className="v2-palette-hint">{item.hint}</span> : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {!flat.length ? (
            <p className="v2-palette-empty">
              {text.trim() ? `Nothing matches "${text.trim()}".` : 'Nothing to open yet.'}
            </p>
          ) : null}
        </div>
        <p className="v2-sr-only" role="status">
          {flat.length === 1 ? '1 result' : `${flat.length} results`}
        </p>
        <p className="v2-palette-foot" aria-hidden="true">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to open
          </span>
          <span>
            <kbd>Esc</kbd> to close
          </span>
        </p>
      </div>
    </dialog>
  );
}

/**
 * The command palette: a dialog with a search field and a list of every page, module, inbox page and server
 * the person can open, with members and inbox items by number found on the server. It is mounted by Shell.jsx
 * while it is open, so each opening starts empty, with the recent places first.
 */
export default function CommandPalette({ open, onClose, guildId, guilds }) {
  if (!open) return null;
  return <PaletteDialog onClose={onClose} guildId={guildId} guilds={guilds} />;
}
