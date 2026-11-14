// What the change history keeps of a settings save: the top-level settings that changed, with their value
// before and after, and with every secret masked. Pure functions, no database.
//
// Two rules live here and nowhere else:
//   1. A secret is never stored in clear. A value is masked when its key looks like one (secret, token,
//      password, API key, webhook ...), when it is a webhook link, or when it is a link that carries
//      credentials (a user name and password, or a key in the query).
//   2. A masked value is never restored. Undoing a change puts the value that is saved now back in its
//      place (restoreMasked), so an undo cannot blank a secret or write the mask over it.
import { isDeepStrictEqual } from 'node:util';

/** What a masked secret is stored as. Never a real value. */
export const MASK = '••••••';

// The history is capped by entries (500 a server, like the audit log), by size: a settings save whose
// changed part is larger than this keeps no copy, only the fact that it was too large, and by a budget for all
// the copies of a server (HISTORY_BUDGET_CHARS in src/db/audit.js, which drops the oldest copies).
export const MAX_SNAPSHOT_CHARS = 32_000;

/** Settings the server stamps itself on every save; a change to only these is not a change. */
const SERVER_STAMPED = new Set(['triggerSince']);

const SECRET_KEY =
  /secret|token|passw(or)?d|passphrase|api[-_]?key|private[-_]?key|credential|authorization|webhook|hmac/i;
// A Discord or Fluxer webhook link, wherever it sits in a text.
const WEBHOOK_LINK = /\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+/i;
// Where the secret of a link sits: a query parameter whose name says so (or is one of the short names that
// are used for one), or a long token-like piece of a path. Links to the hosts below are secret whole.
const SECRET_PARAM =
  /^(?:k|key|code|hash|hm|h|sig|sign|signature|sid|ticket|jwt|bearer|auth|session)$|key|token|secret|passw|pwd|credential|apikey|access|signature|hmac/i;
const WEBHOOK_HOSTS =
  /(^|\.)(hooks\.slack\.com|hooks\.zapier\.com|maker\.ifttt\.com|webhook\.office\.com|outlook\.office\.com|discord(app)?\.com|api\.telegram\.org)$/i;

// The links in a text, found from their "://" (a pattern that starts at every letter would take quadratic time on
// a long text without spaces).
const SCHEME_CHAR = /[a-z0-9+.-]/i;
const LINK_END = /[\s"'<>)\]]/;
function linksIn(text) {
  const out = [];
  let at = text.indexOf('://');
  while (at !== -1 && out.length < 50) {
    let start = at;
    while (start > 0 && at - start < 16 && SCHEME_CHAR.test(text[start - 1])) start -= 1;
    let end = at + 3;
    while (end < text.length && !LINK_END.test(text[end])) end += 1;
    if (start < at) out.push(text.slice(start, end));
    at = text.indexOf('://', end);
  }
  return out;
}

/** True when a link in the text carries a credential: a user name or password, a secret parameter, a token in the path. */
function secretLinkIn(text) {
  for (const found of linksIn(text)) {
    let url;
    try {
      url = new URL(found);
    } catch {
      continue;
    }
    if (url.username || url.password) return true;
    for (const name of url.searchParams.keys()) if (SECRET_PARAM.test(name)) return true;
    // A webhook-style host with a path beyond its root is a webhook (Slack, Zapier, a Telegram bot token ...).
    if (
      WEBHOOK_HOSTS.test(url.hostname) &&
      url.pathname.length > 12 &&
      /webhook|services|hooks|trigger|bot/i.test(url.pathname)
    ) {
      return true;
    }
    // A long run of letters and digits in the path is a token, not a word.
    for (const part of url.pathname.split('/')) {
      const run = part.replace(/\.[a-z0-9]{2,5}$/i, '');
      if (/^[A-Za-z0-9_-]{32,}$/.test(run) && /\d/.test(run) && /[A-Za-z]/.test(run)) return true;
    }
  }
  return false;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** True for a stored value that is the mask (or the mask of a value that was cleared). */
export const isMask = (v) => v === MASK;

function secretLeaf(key, value) {
  if (typeof value === 'string') {
    if (value === '') return false;
    return SECRET_KEY.test(key) || WEBHOOK_LINK.test(value) || secretLinkIn(value);
  }
  // A list or a nested object under a secret-looking key. (A number or a flag is a setting, not a secret.)
  if (Array.isArray(value)) return value.length > 0 && SECRET_KEY.test(key);
  if (isPlainObject(value)) return Object.keys(value).length > 0 && SECRET_KEY.test(key);
  return false;
}

/**
 * A copy of `value` with every secret in it replaced by {@link MASK}. `key` is the name the value is
 * saved under (a list inherits its parent's name, so a list of tokens is masked item by item).
 * @param {unknown} value
 * @param {string} [key]
 */
export function maskSecrets(value, key = '') {
  if (secretLeaf(key, value)) return MASK;
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item, key));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskSecrets(v, k);
    return out;
  }
  return value;
}

/** Drop the settings only the server stamps (see SERVER_STAMPED). */
function comparable(config) {
  const out = {};
  for (const [k, v] of Object.entries(isPlainObject(config) ? config : {})) {
    if (!SERVER_STAMPED.has(k)) out[k] = v;
  }
  return out;
}

/**
 * The top-level settings that differ between two configs, as the history stores them: `before` and
 * `after` hold only those keys (a key that did not exist is simply missing on that side), masked.
 * Null when nothing changed.
 * @param {object} before
 * @param {object} after
 * @returns {{ before: object, after: object } | null}
 */
export function changedSettings(before, after) {
  const b = comparable(before);
  const a = comparable(after);
  const out = { before: {}, after: {} };
  let any = false;
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (isDeepStrictEqual(b[key], a[key])) continue;
    any = true;
    if (key in b) out.before[key] = maskSecrets(b[key], key);
    if (key in a) out.after[key] = maskSecrets(a[key], key);
  }
  return any ? out : null;
}

/**
 * The text the history keeps for a change, or a marker when it is too large to keep.
 * @param {{ before: object, after: object }} change
 */
export function serialiseChange(change) {
  const text = JSON.stringify(change);
  if (text.length > MAX_SNAPSHOT_CHARS) return JSON.stringify({ tooLarge: true });
  return text;
}

/**
 * Read a stored change. `null` for text that is not one (a row from before the history, or damaged).
 * @param {string | null | undefined} text
 * @returns {{ before: object, after: object } | { tooLarge: true } | null}
 */
export function parseChange(text) {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    if (v?.tooLarge === true) return { tooLarge: true };
    if (isPlainObject(v?.before) && isPlainObject(v?.after)) return { before: v.before, after: v.after };
  } catch {
    // fall through
  }
  return null;
}

/** The top-level keys a stored change touches. */
export const changeKeys = (change) => [
  ...new Set([...Object.keys(change.before ?? {}), ...Object.keys(change.after ?? {})]),
];

// The item of a saved list that stands for `item`: the one with the same id. An item without an id has no
// counterpart (a place in a list is not an identity: the list may have been reordered or cut), so a masked
// value in it is left out and reported, never taken from another item.
function counterpart(list, item) {
  if (!Array.isArray(list)) return undefined;
  if (isPlainObject(item) && item.id !== undefined) {
    return list.find((c) => isPlainObject(c) && c.id === item.id);
  }
  return undefined;
}

/**
 * `value` (a stored "before" value) with every mask replaced by what is saved now at the same place in
 * `current`. A mask with nothing saved to put there is left out. This is the rule that keeps an undo from
 * touching a secret: the history cannot know it, so the current one stays.
 * @param {unknown} value
 * @param {unknown} current
 * @returns {unknown} undefined when the whole value was a mask with nothing to keep
 */
export function restoreMasked(value, current, dropped = []) {
  if (isMask(value)) {
    if (current === undefined) dropped.push(true);
    return current;
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      const kept = restoreMasked(item, counterpart(current, item), dropped);
      if (kept !== undefined) out.push(kept);
    }
    return out;
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const kept = restoreMasked(v, isPlainObject(current) ? current[k] : undefined, dropped);
      if (kept !== undefined) out[k] = kept;
    }
    return out;
  }
  return value;
}

/** The change without some of its settings (the ones an undo leaves alone). */
export function without(change, keys) {
  const drop = new Set(keys);
  const pick = (side) => Object.fromEntries(Object.entries(side ?? {}).filter(([k]) => !drop.has(k)));
  return { before: pick(change.before), after: pick(change.after) };
}

/**
 * What an undo of `change` would save: the config as it is now, with every setting the change touched put
 * back to its earlier value (a setting that did not exist before is removed). Masked values keep what is
 * saved now.
 * `keep` lists settings that are not restored (they stay as saved now). `droppedSecrets`, when given, receives
 * the settings in which a masked value had nothing to be taken from and was left out.
 * @param {object} current
 * @param {{ before: object, after: object }} change
 * @param {{ keep?: string[], droppedSecrets?: string[] }} [opts]
 */
export function undoTarget(current, change, { keep = [], droppedSecrets = [] } = {}) {
  const target = { ...current };
  for (const key of changeKeys(change)) {
    if (keep.includes(key)) continue;
    if (key in change.before) {
      const dropped = [];
      const restored = restoreMasked(change.before[key], current[key], dropped);
      if (dropped.length) droppedSecrets.push(key);
      if (restored === undefined) continue; // the whole value was a secret: keep the saved one
      target[key] = restored;
    } else {
      delete target[key];
    }
  }
  return target;
}

/**
 * Where the saved config stands against a change:
 *   'clean'    every touched setting still has the value the change gave it,
 *   'reverted' every touched setting already has its earlier value,
 *   'changed'  something else: the settings were changed again since.
 * Compared on the masked values, the same form the history keeps.
 * @param {object} current
 * @param {{ before: object, after: object }} change
 * @returns {'clean' | 'reverted' | 'changed'}
 */
export function undoState(current, change) {
  const now = {};
  for (const key of changeKeys(change)) {
    if (key in current) now[key] = maskSecrets(current[key], key);
  }
  const matches = (side) =>
    changeKeys(change).every((key) => {
      const had = key in side;
      return had === key in now && (!had || isDeepStrictEqual(side[key], now[key]));
    });
  if (matches(change.after)) return 'clean';
  if (matches(change.before)) return 'reverted';
  return 'changed';
}

/** The settings of a change that were changed again since (for the warning). */
export function laterChanges(current, change) {
  return changeKeys(change).filter((key) => {
    const has = key in current;
    const now = has ? maskSecrets(current[key], key) : undefined;
    const after = key in change.after ? change.after[key] : undefined;
    return has !== key in change.after || !isDeepStrictEqual(now, after);
  });
}
