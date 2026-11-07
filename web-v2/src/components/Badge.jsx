/**
 * One badge for every status: <Badge tone="success">Published</Badge>.
 * Tones go by meaning, not by page:
 *   danger  — something bad or final: ban, kick, denied
 *   warning — needs a look or is limited: warn, timeout, pending, open
 *   success — good or live: accepted, published, active, on
 *   neutral — everything else (the default): note, draft, off, deleted
 * The label is always text (never colour alone) and is shown in Sentence case: pass the raw
 * word ("timeout", "PUBLISHED") and it is tidied; pass `raw` to keep a label exactly as given.
 * `inline` adds the small gap used right after a row title.
 */

export const BADGE_TONES = ['danger', 'warning', 'success', 'neutral'];

/**
 * "timeout" -> "Timeout", "NOT_SET" -> "Not set", "PUBLISHED" -> "Published". Only long all-caps
 * words (4+ letters) are lowercased; short acronyms and mixed-case words keep their capitals
 * ("API", "DM", "iOS", "Fluxer").
 */
export function sentenceCase(text) {
  const s = String(text ?? '')
    .trim()
    .replace(/[_-]+/g, ' ');
  if (!s) return s;
  const words = s.split(' ').map((w) => (w.length > 3 && w === w.toUpperCase() ? w.toLowerCase() : w));
  const first = words[0];
  // A first word like "iOS" or "macOS" already has its own capitalisation.
  if (!/^[a-z]+[A-Z]/.test(first)) words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(' ');
}

// Tone per moderation action (the case type stored by the bot).
const CASE_TONES = { ban: 'danger', kick: 'danger', warn: 'warning', timeout: 'warning' };
/** Tone of an infraction type: ban/kick danger, warn/timeout warning, anything else neutral. */
export function caseTone(action) {
  return CASE_TONES[String(action ?? '').toLowerCase()] ?? 'neutral';
}

const APPEAL_TONES = { accepted: 'success', denied: 'danger', open: 'warning', pending: 'warning' };
/** Tone of a ban appeal's status. */
export function appealTone(status) {
  return APPEAL_TONES[String(status ?? '').toLowerCase()] ?? 'neutral';
}

export default function Badge({ tone = 'neutral', inline = false, raw = false, className = '', children }) {
  const safeTone = BADGE_TONES.includes(tone) ? tone : 'neutral';
  const label = !raw && typeof children === 'string' ? sentenceCase(children) : children;
  return (
    <span
      className={`v2-status-pill is-${safeTone}${inline ? ' v2-badge-inline' : ''}${className ? ` ${className}` : ''}`}
    >
      {label}
    </span>
  );
}
