// The last step of a copy: link every mirrored channel through the bridge, so a message written in a
// Discord channel appears in its Fluxer copy and the other way round.
//
// The bridge (its link model, webhooks and relay) is a separate package. Until it is wired in, this function is
// what the copy calls at the end, and it does nothing: it reports that no channel was linked and why. The
// copy shows that in its report ("Bridge linking: not available yet") and still finishes.
//
// The contract a real implementation keeps:
//   - input: the id of a mirror pair (src/db/mirror.js); the id map of that pair says which Discord channel is
//     which Fluxer channel;
//   - it links only text and announcement channels that both sides have, and skips a channel that is already
//     linked, so running it twice is safe;
//   - it returns how many channels it linked, and `reason` when it linked none on purpose;
//   - it throws only for a failure the copy should retry (the queue retries it with a delay).

/**
 * @param {number} _pairId
 * @returns {Promise<{ linked: number, reason?: string }>}
 */
export async function linkMirroredChannels(_pairId) {
  return { linked: 0, reason: 'bridge-not-available' };
}
