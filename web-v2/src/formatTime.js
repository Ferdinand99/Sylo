// One way to write a date and time on every dashboard page: "Sat 7 Nov, 23:05" (the viewer's locale,
// no seconds, the month spelled out so day and month are never mixed up) and, where a page shows a
// relative time, "in 2 days" / "3m ago". Each form carries the other in a tooltip.

const toDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const formatters = new Map();
function formatter(locale, options) {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, options);
    } catch {
      // An unknown time zone name: fall back to the viewer's own zone instead of failing the page.
      f = new Intl.DateTimeFormat(locale, { ...options, timeZone: undefined });
    }
    formatters.set(key, f);
  }
  return f;
}

// 24-hour clocks write "09:05" and "00:05"; 12-hour ones "9:05 AM".
const uses24Hour = (locale) => !formatter(locale, { hour: 'numeric' }).resolvedOptions().hour12;

const sameYear = (d, now, locale, timeZone) =>
  formatter(locale, { year: 'numeric', timeZone }).format(d) ===
  formatter(locale, { year: 'numeric', timeZone }).format(now);

/**
 * "Sat 7 Nov, 23:05" (the year is added when it is not the current one: "Sat 7 Nov 2027, 23:05").
 * Takes a timestamp in ms, an ISO string or a Date; '' when there is no valid date.
 * `timeZone` shows the time in that zone instead of the viewer's.
 */
export function formatDateTime(value, { locale, timeZone, now = Date.now() } = {}) {
  const d = toDate(value);
  if (!d) return '';
  return formatter(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear(d, now, locale, timeZone) ? {} : { year: 'numeric' }),
    hour: uses24Hour(locale) ? '2-digit' : 'numeric',
    minute: '2-digit',
    timeZone,
  })
    .format(d)
    .replace(/^([^\s,]+),\s/, '$1 '); // en-US writes "Sat, Nov 7, 11:05 PM"; keep the weekday without a comma
}

/** "7 Nov" ("7 Nov 2027" in another year) for a value that is a day, not a moment. */
export function formatDay(value, { locale, timeZone, now = Date.now() } = {}) {
  const d = toDate(value);
  if (!d) return '';
  return formatter(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear(d, now, locale, timeZone) ? {} : { year: 'numeric' }),
    timeZone,
  }).format(d);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "in 2 days", "3m ago", "in 5h", "just now". Past and future alike; from about two months out it
 * is the plain date instead, since "in 74 days" says less than "Mon 18 Jan".
 */
export function formatRelative(value, { now = Date.now(), locale } = {}) {
  const d = toDate(value);
  if (!d) return '';
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  const later = diff > 0;
  if (abs < MINUTE) return 'just now';
  const wrap = (text) => (later ? `in ${text}` : `${text} ago`);
  if (abs < HOUR) return wrap(`${Math.round(abs / MINUTE)}m`);
  if (abs < DAY) return wrap(`${Math.round(abs / HOUR)}h`);
  const days = Math.round(abs / DAY);
  if (days < 60) return wrap(`${days} ${days === 1 ? 'day' : 'days'}`);
  return formatDay(d, { locale, now });
}

/**
 * Both forms at once for a page: `text` is what to show, `title` the other form for the tooltip.
 * `relative: true` shows the relative form ("in 2 days") and keeps the exact moment in the tooltip;
 * the default shows the exact moment and keeps the relative form in the tooltip.
 * @returns {{ text: string, title: string }}
 */
export function describeTime(value, { relative = false, now = Date.now(), locale, timeZone } = {}) {
  const exact = formatDateTime(value, { locale, timeZone, now });
  if (!exact) return { text: '', title: '' };
  const rel = formatRelative(value, { now, locale });
  return relative ? { text: rel, title: exact } : { text: exact, title: rel };
}
