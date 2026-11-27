// A mirror is run by the two servers' owners, and by nobody else. The people who agreed are recorded by their
// platform user id (the owner of each server at that time); before every piece of work the engine asks whether the
// servers still have those owners. If a server changed hands, the mirror pauses until the new owner has confirmed it.
//
// Open mode (no sign-in, a private instance) has no accounts, so nothing is enforced there: `enforce` is false.

/**
 * @param {{ sourceConsentUser: string, targetConsentUser: string }} pair
 * @param {{ ownerId?: string } | undefined} sourceGuild  the Discord server
 * @param {{ ownerId?: string } | undefined} targetGuild  the Fluxer server
 * @param {boolean} enforce
 * @returns {{ ok: boolean, sides: Array<'source' | 'target'>, reason?: string }} `sides`: whose owner is not the one who agreed
 */
export function checkOwnership(pair, sourceGuild, targetGuild, enforce) {
  if (!enforce) return { ok: true, sides: [] };
  const sides = [];
  const same = (agreed, guild) =>
    Boolean(agreed) && Boolean(guild?.ownerId) && String(guild.ownerId) === agreed;
  if (!same(pair.sourceConsentUser, sourceGuild)) sides.push('source');
  if (!same(pair.targetConsentUser, targetGuild)) sides.push('target');
  if (!sides.length) return { ok: true, sides };
  const names = sides.map((s) => (s === 'source' ? 'Discord' : 'Fluxer'));
  return {
    ok: false,
    sides,
    reason: `The owner of the ${names.join(' and ')} server is not the person who agreed to the mirror (the server changed hands). The mirror is paused until the new owner confirms it.`,
  };
}
