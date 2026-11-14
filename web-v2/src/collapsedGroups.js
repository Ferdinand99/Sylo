// Which categories of the overview the person has folded away, remembered in this browser only.
// Storage can be missing or throw (a private window, blocked site data): the overview then simply
// starts with every category open.
const KEY = 'sylo:v2:overview-collapsed';

/** @returns {Set<string>} the titles of the folded categories */
export function readCollapsed() {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null');
    return new Set(Array.isArray(raw) ? raw.filter((t) => typeof t === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Remember the folded categories; a failing write is ignored. */
export function writeCollapsed(titles) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify([...titles]));
  } catch {
    // nothing to do: the state just is not remembered
  }
}

/** A new set with `title` folded or opened. */
export function toggled(titles, title) {
  const next = new Set(titles);
  if (next.has(title)) next.delete(title);
  else next.add(title);
  return next;
}

/** Whether the person has ever folded or opened a category here (before that, a phone starts folded by default). */
export function hasStoredCollapse() {
  try {
    return globalThis.localStorage?.getItem(KEY) != null;
  } catch {
    return false;
  }
}

const HINT_KEY = 'sylo:v2:overview-hint-seen';

/** Whether the "Switch a module on or off here" hint was dismissed by the first switch. */
export function hintSeen() {
  try {
    return globalThis.localStorage?.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remember that the person has used a switch, so the hint is not shown again. */
export function markHintSeen() {
  try {
    globalThis.localStorage?.setItem(HINT_KEY, '1');
  } catch {
    // nothing to do: the hint just shows again next time
  }
}
