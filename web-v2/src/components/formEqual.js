// Structural equality for form state — what "dirty" means for the save bar.
// Plain data only (what a form holds and an API returns): primitives, arrays,
// plain objects, Dates. An own key whose value is `undefined` counts the same
// as a missing key, so `{ a: 1, b: undefined }` equals `{ a: 1 }` — a form
// that clears an optional field shouldn't look edited just because the key
// is still there.
export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const keys = new Set();
  for (const k of Object.keys(a)) if (a[k] !== undefined) keys.add(k);
  for (const k of Object.keys(b)) if (b[k] !== undefined) keys.add(k);
  for (const k of keys) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

/** True when `form` has been edited away from `baseline` (both loaded). */
export function isDirty(form, baseline) {
  if (form == null || baseline == null) return false;
  return !deepEqual(form, baseline);
}
