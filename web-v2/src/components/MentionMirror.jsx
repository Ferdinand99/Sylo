import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
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
 * Exported for tests.
 */
export function syncMirror(field, mirror) {
  if (!field || !mirror) return;
  const cs = window.getComputedStyle(field);
  for (const prop of COPIED) mirror.style[prop] = cs[prop];
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
  mirror.scrollTop = field.scrollTop;
}

/**
 * The layer that draws the mentions of a message field as names. It sits over the field, never takes a
 * click, and repeats the field's text exactly (the field's own text is made see-through while it is
 * shown), but each stored token (<#id>, <@&id>, <@id>) is drawn as a pill with the name of the channel,
 * role or member. The raw token stays in the layer, invisible, so every letter keeps the width it has in
 * the field: the caret, a selection and the line breaks are the field's own and cannot drift.
 *
 * Names come from the server and from people, so they are only ever rendered as text, never as markup:
 * a token's name is an attribute that the style sheet draws with `content: attr(...)`.
 *
 * It is hidden from assistive technology (the field is what is read) and is not drawn at all in forced
 * colours mode, where the field shows its text as it is.
 */
export default function MentionMirror({ field, value, channels = [], roles = [], members = new Map() }) {
  const ref = useRef(null);

  const parts = useMemo(
    () => mirrorParts(value, { channels, roles, members }),
    [value, channels, roles, members]
  );

  // Every render that can change what or where the text is (the text, the names, the field's class).
  useLayoutEffect(() => {
    syncMirror(field, ref.current);
  });

  useEffect(() => {
    if (!field) return undefined;
    const onScroll = () => {
      if (ref.current) ref.current.scrollTop = field.scrollTop;
    };
    const onSize = () => syncMirror(field, ref.current);
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
  }, [field]);

  // A text that ends in a line break shows an empty last line in a field, but a block of text only
  // does when something follows the break.
  const endsInBreak = /\n$/.test(String(value ?? ''));

  return (
    <div className="v2-mention-mirror" aria-hidden="true" ref={ref} data-testid="mention-mirror">
      {parts.map((part, i) => {
        if (part.kind === 'text') return part.text;
        if (part.kind === 'special') {
          return (
            <span key={i} className="v2-mm-pill is-special">
              {part.text}
            </span>
          );
        }
        return (
          <span
            key={i}
            className={`v2-mm-token is-${part.type}${part.missing ? ' is-missing' : ''}`}
            data-label={part.label}
          >
            {part.text}
          </span>
        );
      })}
      {endsInBreak ? '​' : null}
    </div>
  );
}
