// Download bounded videos only from known media CDNs; arbitrary configured
// URLs stay links and are never fetched from the bot's hosting network.
const HOSTS = new Set(['packaged-media.redd.it', 'v.redd.it', 'cdn.discordapp.com', 'media.discordapp.net']);
export const MAX_VIDEO_BYTES = 8 * 1024 * 1024;
let activeDownloads = 0;

export function videoExtension(value) {
  try {
    return new URL(value).pathname.match(/\.(mp4|webm)$/i)?.[1].toLowerCase() || null;
  } catch {
    return null;
  }
}

export function canDownloadVideo(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
      HOSTS.has(url.hostname) &&
      Boolean(videoExtension(value))
    );
  } catch {
    return false;
  }
}

/** No redirects, bounded time/size/concurrency, no arbitrary remote fetches. */
export async function downloadAutoresponderVideo(value, { fetchImpl = fetch } = {}) {
  if (!canDownloadVideo(value) || activeDownloads >= 2) return null;
  activeDownloads++;
  const signal = AbortSignal.timeout(10_000);
  let reader;
  let body;
  try {
    const res = await fetchImpl(value, { redirect: 'error', signal });
    body = res.body;
    if (!res.ok || !res.body) return null;
    const type = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!['video/mp4', 'video/webm', 'application/octet-stream'].includes(type)) return null;
    if (Number(res.headers.get('content-length')) > MAX_VIDEO_BYTES) return null;
    reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > MAX_VIDEO_BYTES) return null;
      chunks.push(Buffer.from(chunk));
    }
    return size ? Buffer.concat(chunks, size) : null;
  } catch {
    return null;
  } finally {
    if (reader) await reader.cancel().catch(() => {});
    else await body?.cancel().catch(() => {});
    activeDownloads--;
  }
}
