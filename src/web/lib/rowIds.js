// Ids for the rows of a builder that lives inside a module's config (temp-voice hubs,
// starboard boards). The normalisers fall back to the row's position for a row without an
// id, so a row added in the new dashboard after an earlier one was removed could take over
// that other row's id. The classic builders hand a new row the current time instead; this does
// the same for a whole list at once, and also re-ids a row whose id is already used above it.

/**
 * @param {unknown} rows  the rows as submitted
 * @param {number} [now]
 * @returns {object[]} the rows (not mutated), each with a unique numeric-string id
 */
export function withRowIds(rows, now = Date.now()) {
  const list = Array.isArray(rows) ? rows : [];
  const used = new Set();
  let next = now;
  return list.map((row) => {
    const given = row && typeof row === 'object' ? String(row.id ?? '') : '';
    let id = /^\d+$/.test(given) && !used.has(given) ? given : '';
    while (!id) {
      const candidate = String(next++);
      if (!used.has(candidate)) id = candidate;
    }
    used.add(id);
    return { ...row, id };
  });
}
