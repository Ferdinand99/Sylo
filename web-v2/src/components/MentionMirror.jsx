import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { mirrorParts } from '../mentions.js';
import '../styles/mention-mirror.css';

// The properties that decide where a letter lands in a textarea: the font, the spacing, the padding, how
// and where a line breaks. They are read from the field itself and written to the mirror, so the mirror
// follows whatever class the field has (a settings field, an embed field, the message builder) without a
// rule of its own for each, and a change of theme, zoom or breakpoint is picked up the next time it syncs.
const COPIED = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontStretch',
  'fontVariant',
  'fontKerning',
  'fontFeatureSettings',
  'fontVariationSettings',
  'letterSpacing',
  'wordSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'textAlign',
  'textRendering',
  'tabSize',
  'direction',
  'writingMode',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
  'lineBreak',
  'hyphens',
  'color',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'opacity',
];

/**
 * Lays the mirror over the field: same box, same text metrics, same scroll position. The mirror is
 * `box-sizing: border-box` with the field's padding and border widths, and the width a classic scrollbar
 * takes from the field's text is added to its right padding, so a line breaks at the same letter in both.
 * With `bare` (the layer of names) there is no padding and no border, so its origin is the mirror's outer
 * corner. Exported for tests.
 */
export function syncMirror(field, mirror, { bare = false } = {}) {
  if (!field || !mirror) return;
  const cs = window.getComputedStyle(field);
  for (const prop of COPIED) mirror.style[prop] = cs[prop];
  // Whole pixels, like the field's own text: a box placed at a fraction of a pixel puts the letters on a
  // different pixel row than the field's, and they blur against them.
  mirror.style.left = `${field.offsetLeft}px`;
  mirror.style.top = `${field.offsetTop}px`;
  mirror.style.width = `${field.offsetWidth}px`;
  mirror.style.height = `${field.offsetHeight}px`;
  const bars =
    field.offsetWidth -
    field.clientWidth -
    (parseFloat(cs.borderLeftWidth) || 0) -
    (parseFloat(cs.borderRightWidth) || 0);
  if (bars > 0) mirror.style.paddingRight = `${(parseFloat(cs.paddingRight) || 0) + bars}px`;
  if (bare) {
    mirror.style.padding = '0';
    mirror.style.borderWidth = '0';
  } else {
    mirror.scrollTop = field.scrollTop;
  }
}

const same = (a, b) =>
  a.length === b.length &&
  a.every((s, i) => {
    const t = b[i];
    return s === t || (s && t && ['x', 'y', 'w', 'h'].every((k) => Math.abs(s[k] - t[k]) < 0.01));
  });

/**
 * The layers that draw the mentions of a message field as names. They sit over the field, never take a
 * click, and repeat the field's text exactly (the field's own text is made see-through while they are
 * shown):
 *
 * - the mirror holds the text. Each stored token (<#id>, <@&id>, <@id>) stays in it as its raw text,
 *   invisible, in a tinted span, so every letter keeps the width it has in the field: the caret, a
 *   selection and the line breaks are the field's own and cannot drift. Nothing but text and spans is in
 *   the flow, because anything else (a pseudo-element, an inline box) is a place where a browser may break
 *   the line, and the field's own text has none inside a word.
 * - the names sit in a second layer of the same box, each one placed over its token from where the
 *   browser laid the token out. They slide with the mirror's scroll.
 *
 * Names come from the server and from people, so they are only ever rendered as text, never as markup.
 *
 * Both are hidden from assistive technology (the field is what is read) and are not drawn at all in
 * forced colours mode, where the field shows its text as it is.
 */
export default function MentionMirror({ field, value, channels = [], roles = [], members = new Map() }) {
  const mirrorRef = useRef(null);
  const namesRef = useRef(null);
  const innerRef = useRef(null);
  const [spots, setSpots] = useState([]);

  const parts = useMemo(
    () => mirrorParts(value, { channels, roles, members }),
    [value, channels, roles, members]
  );
  const mentions = parts.filter((p) => p.kind === 'mention');

  /** Lay both layers over the field, then find where each token ended up. */
  const lay = () => {
    const mirror = mirrorRef.current;
    syncMirror(field, mirror);
    syncMirror(field, namesRef.current, { bare: true });
    if (!mirror) return;
    // The names are placed in the content of the mirror and slid by its scroll, so they cannot be limited
    // by how far a layer with so little in it can scroll.
    if (innerRef.current) innerRef.current.style.transform = `translateY(${-mirror.scrollTop}px)`;
    const origin = mirror.getBoundingClientRect();
    const found = [...mirror.querySelectorAll('[data-token]')].map((el) => {
      const r = el.getClientRects()[0];
      return r
        ? { x: r.left - origin.left, y: r.top - origin.top + mirror.scrollTop, w: r.width, h: r.height }
        : null;
    });
    setSpots((prev) => (same(prev, found) ? prev : found));
  };

  // Every render that can change what or where the text is (the text, the names, the field's class).
  useLayoutEffect(() => {
    lay();
  });

  useEffect(() => {
    if (!field) return undefined;
    const onScroll = () => {
      const mirror = mirrorRef.current;
      if (!mirror) return;
      mirror.scrollTop = field.scrollTop;
      if (innerRef.current) innerRef.current.style.transform = `translateY(${-mirror.scrollTop}px)`;
    };
    const onSize = () => lay();
    field.addEventListener('scroll', onScroll, { passive: true });
    // A box that grows (an auto-growing field, the drag handle) or a width that changes (the window, a
    // sidebar) wraps the text differently.
    let observer;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(onSize);
      observer.observe(field);
    }
    window.addEventListener('resize', onSize);
    // The web font arrives after the first render and changes every width.
    const fonts = document.fonts;
    fonts?.ready?.then(onSize);
    fonts?.addEventListener?.('loadingdone', onSize);
    return () => {
      field.removeEventListener('scroll', onScroll);
      observer?.disconnect();
      window.removeEventListener('resize', onSize);
      fonts?.removeEventListener?.('loadingdone', onSize);
    };
    // `lay` reads the current props through the refs and the closure of the latest render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field]);

  // A text that ends in a line break shows an empty last line in a field, but a block of text only
  // does when something follows the break.
  const endsInBreak = /\n$/.test(String(value ?? ''));

  let n = -1;
  return (
    <>
      <div className="v2-mention-mirror" aria-hidden="true" ref={mirrorRef} data-testid="mention-mirror">
        {parts.map((part, i) => {
          if (part.kind === 'text') return part.text;
          if (part.kind === 'special') {
            return (
              <span key={i} className="v2-mm-pill is-special">
                {part.text}
              </span>
            );
          }
          n += 1;
          return (
            <span
              key={i}
              className={`v2-mm-token is-${part.type}${part.missing ? ' is-missing' : ''}`}
              data-token={n}
            >
              {part.text}
            </span>
          );
        })}
        {endsInBreak ? '\u200b' : null}
      </div>
      <div className="v2-mention-names" aria-hidden="true" ref={namesRef} data-testid="mention-names">
        <div className="v2-mm-names-inner" ref={innerRef}>
          {mentions.map((part, i) => {
            const at = spots[i];
            return (
              <span
                key={i}
                className={`v2-mm-name is-${part.type}${part.missing ? ' is-missing' : ''}`}
                style={at ? { left: at.x, top: at.y, width: at.w, height: at.h } : { visibility: 'hidden' }}
              >
                {part.label}
              </span>
            );
          })}
        </div>
      </div>
    </>
  );
}
