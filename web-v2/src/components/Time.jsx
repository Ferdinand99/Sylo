import { describeTime } from '../formatTime.js';

/**
 * A date and time in the dashboard's one format ("Sat 7 Nov, 23:05"), with the relative form
 * ("in 2 days") in the tooltip. `relative` swaps them: "3m ago" shown, the exact time in the tooltip.
 * `fallback` is shown as plain text when there is no valid date; with none, nothing is rendered.
 */
export default function Time({ value, relative = false, timeZone, className, fallback = '' }) {
  const { text, title } = describeTime(value, { relative, timeZone });
  // No usable time (an older answer without one): show the server's own wording as it is.
  if (!text) return fallback ? <span className={className}>{fallback}</span> : null;
  const iso = new Date(value).toISOString();
  return (
    <time dateTime={iso} title={title} className={className}>
      {text}
    </time>
  );
}
