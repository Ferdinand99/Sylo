// XP / level maths. MEE6-style curve: the XP earned *within* level L to reach
// L+1 is 5*L^2 + 50*L + 100.

/** XP needed to go from `level` to `level + 1`. */
export function xpForLevel(level) {
  const l = Math.max(0, Math.floor(level));
  return 5 * l * l + 50 * l + 100;
}

/** Total cumulative XP required to have reached `level`. */
export function totalXpForLevel(level) {
  let total = 0;
  for (let l = 0; l < Math.max(0, Math.floor(level)); l += 1) total += xpForLevel(l);
  return total;
}

/** The level a given cumulative XP total corresponds to. */
export function levelFromXp(xp) {
  const value = Math.max(0, Math.floor(xp));
  let level = 0;
  while (value >= totalXpForLevel(level + 1)) level += 1;
  return level;
}

/**
 * Progress within the current level.
 * @returns {{ level: number, into: number, need: number, pct: number }}
 */
export function levelProgress(xp) {
  const level = levelFromXp(xp);
  const base = totalXpForLevel(level);
  const need = xpForLevel(level);
  const into = Math.max(0, Math.floor(xp) - base);
  return { level, into, need, pct: need ? into / need : 0 };
}

/** A short unicode progress bar, e.g. "██████░░░░ 63%". */
export function progressBar(pct, width = 12) {
  const p = Math.min(1, Math.max(0, pct));
  const filled = Math.round(p * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${Math.round(p * 100)}%`;
}
