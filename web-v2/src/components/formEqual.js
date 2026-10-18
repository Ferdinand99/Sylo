// Structural equality for form state — what "dirty" means for the save bar.
// Plain data only (what a form holds and an API returns): primitives, arrays,
// plain objects, Dates. An own key whose value is `undefined` counts the same
// as a missing key, so `{ a: 1, b: undefined }` equals `{ a: 1 }` — a form
// that clears an optional field shouldn't look edited just because the key
// is still there.
export function deepEqual(a, b) {
  return equal(a, b, false);
}

// Loose mode, for dirty checks only: an empty value ('' / null / undefined)
// equals another empty value, and a number equals its own digits as a string —
// what inputs hand back for a value the user never touched (a number field
// gives "5" for a saved 5; a cleared select gives '' for a saved null).
const isEmpty = (v) => v === undefined || v === null || v === '';

function samePrimitive(a, b) {
  if (isEmpty(a) && isEmpty(b)) return true;
  if (typeof a === 'number' && typeof b === 'string') return b.trim() !== '' && Number(b) === a;
  if (typeof a === 'string' && typeof b === 'number') return a.trim() !== '' && Number(a) === b;
  return false;
}

function equal(a, b, loose) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return loose ? samePrimitive(a, b) : false;
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!equal(a[i], b[i], loose)) return false;
    return true;
  }
  const skip = loose ? isEmpty : (v) => v === undefined;
  const keys = new Set();
  for (const k of Object.keys(a)) if (!skip(a[k])) keys.add(k);
  for (const k of Object.keys(b)) if (!skip(b[k])) keys.add(k);
  for (const k of keys) if (!equal(a[k], b[k], loose)) return false;
  return true;
}

/** True when `form` has been edited away from `baseline` (both loaded). */
export function isDirty(form, baseline) {
  if (form == null || baseline == null) return false;
  return !equal(form, baseline, true);
}
