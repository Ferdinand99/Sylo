// "Is there a newer Sylo?" for the operators' update notice: the latest GitHub release, compared with
// the version that runs. One anonymous request to a fixed address, kept in memory for six hours, with a
// timeout; a failure is quiet (one log line, then a shorter retry delay) and never reaches startup.
// UPDATE_CHECK=off turns it off completely: nothing is requested.
import { changelogFeed } from './changelog.js';

export const RELEASE_API = 'https://api.github.com/repos/Ferdinand99/Sylo/releases/latest';
export const UPDATE_COMMAND = 'docker compose pull && docker compose up -d';

export const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
// After a failed check the next one waits this long, so a dead network is not asked every few seconds.
export const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;
// "Check again" can bring the next request forward, but not more often than this for the whole instance
// (GitHub allows an anonymous address 60 requests an hour), and never while a failure is being waited out.
export const FORCE_MIN_INTERVAL_MS = 60 * 1000;
export const REQUEST_TIMEOUT_MS = 5000;
const MAX_BODY_CHARS = 1_000_000;
const MAX_NOTES_CHARS = 20_000;
const MAX_NOTES_TEXT = 4000;

/**
 * "5.3.0" or "v5.3.0-rc.1" as numbers and a prerelease tag, or null when it is not a version.
 * @param {unknown} v
 */
export function parseVersion(v) {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,40}))?(?:\+[0-9A-Za-z.-]{1,40})?$/.exec(
    String(v ?? '').trim()
  );
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : null };
}

function comparePre(a, b) {
  // A release outranks its prereleases; identifiers compare as numbers when both are numbers.
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      const d = Number(a[i]) - Number(b[i]);
      if (d) return Math.sign(d);
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Compare two versions: 1 when `a` is newer, -1 when older, 0 when equal, null when either is not a version.
 * @returns {1 | 0 | -1 | null}
 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  }
  return comparePre(x.pre, y.pre);
}

/** The body as text, read as it streams and cut off with an error once it passes `max` characters. */
async function readCapped(res, max) {
  if (!res.body?.getReader) {
    const text = await res.text();
    if (text.length > max) throw new Error('the answer is too large');
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > max) {
      await reader.cancel().catch(() => {});
      throw new Error('the answer is too large');
    }
  }
  return text + decoder.decode();
}

/** `[label](url)` links in a changelog line keep only https targets: anything else shows as its label. */
function httpsOnly(text) {
  return String(text).replace(/\[([^\]]+)\]\(([^()\s]+(?:\([^()\s]*\))?)\)/g, (whole, label, url) =>
    /^https:\/\//i.test(url) ? whole : label
  );
}

/**
 * The release notes as data the dashboard and the app render themselves (never as HTML): the sections
 * and items of a release-please body, with only https links. Notes that are not in that format come
 * back as a short plain text instead.
 * @returns {{ notes: object | null, notesText: string | null }}
 */
export function shapeNotes(body, version) {
  const text = String(body ?? '').slice(0, MAX_NOTES_CHARS);
  const [release] = changelogFeed(text, { limit: 1 });
  if (release && release.sections.length) {
    return {
      notes: {
        version: release.version || version,
        date: release.date,
        url: release.url && /^https:\/\//i.test(release.url) ? release.url : null,
        sections: release.sections.map((s) => ({
          title: s.title,
          kind: s.kind,
          items: s.items.map((i) => ({
            scope: i.scope,
            text: httpsOnly(i.text),
            refs: i.refs.filter((r) => /^https:\/\//i.test(r.url)),
          })),
        })),
      },
      notesText: null,
    };
  }
  const plain = httpsOnly(text).trim();
  return { notes: null, notesText: plain ? plain.slice(0, MAX_NOTES_TEXT) : null };
}

/** Only a GitHub page of the Sylo repository is offered as "the release". */
const RELEASE_PAGE = /^https:\/\/github\.com\/Ferdinand99\/Sylo\/releases\/[A-Za-z0-9._/-]{1,100}$/;

/**
 * @param {object} release GitHub's `releases/latest` answer
 */
export function shapeRelease(release) {
  if (!release || typeof release !== 'object') return null;
  if (release.draft || release.prerelease) return null;
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  const parsed = parseVersion(tag);
  if (!parsed) return null;
  const version = tag.replace(/^v/, '');
  return {
    version,
    url: RELEASE_PAGE.test(release.html_url ?? '') ? release.html_url : null,
    publishedAt: Number.isNaN(Date.parse(release.published_at)) ? null : release.published_at,
    ...shapeNotes(release.body, version),
  };
}

/**
 * A checker with its own cache. The routes use one instance (below); tests make their own.
 * @param {{
 *   enabled?: boolean, version: string, url?: string, ttlMs?: number, retryMs?: number,
 *   timeoutMs?: number, now?: () => number, fetchImpl?: typeof fetch,
 *   log?: { debug?: Function, warn?: Function },
 * }} opts
 */
export function createUpdateChecker({
  enabled = true,
  version,
  url = RELEASE_API,
  ttlMs = CHECK_TTL_MS,
  retryMs = RETRY_AFTER_FAILURE_MS,
  timeoutMs = REQUEST_TIMEOUT_MS,
  now = Date.now,
  fetchImpl,
  log,
}) {
  /** @type {{ at: number, until: number, release: ReturnType<typeof shapeRelease>, failed: boolean } | null} */
  let cached = null;
  /** @type {Promise<void> | null} */
  let inflight = null;
  let warned = false;
  let lastAttempt = 0;

  async function fetchLatest() {
    lastAttempt = now();
    try {
      const res = await (fetchImpl ?? globalThis.fetch)(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': `Sylo/${version} (update check)`,
          'x-github-api-version': '2022-11-28',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_BODY_CHARS) throw new Error('the answer is too large');
      const text = await readCapped(res, MAX_BODY_CHARS);
      const release = shapeRelease(JSON.parse(text));
      if (!release) throw new Error('no usable release in the answer');
      const at = now();
      cached = { at, until: at + ttlMs, release, failed: false };
    } catch (err) {
      const at = now();
      // The last good answer stays visible; only the retry is pushed out.
      cached = { at: cached?.at ?? 0, until: at + retryMs, release: cached?.release ?? null, failed: true };
      const message = err instanceof Error ? err.message : String(err);
      // One warning per process; later failures are only debug lines.
      if (!warned) log?.warn?.('update-check', 'could not check for a new Sylo release:', message);
      else log?.debug?.('update-check', 'check failed again:', message);
      warned = true;
    }
  }

  /**
   * The state of the check. Never throws, never waits for the network when the cache is fresh.
   * `force` re-checks now (the Check again button, rate limited by the route).
   */
  async function get({ force = false } = {}) {
    if (!enabled) return view(null, false, 0);
    // A forced check is a request to look sooner; it is served from the cache when the last look was a
    // moment ago or a failure is being waited out.
    const forced =
      force &&
      cached &&
      !(cached.failed && now() < cached.until) &&
      now() - lastAttempt >= FORCE_MIN_INTERVAL_MS;
    if (!cached || forced || now() >= cached.until) {
      inflight ??= fetchLatest().finally(() => {
        inflight = null;
      });
      await inflight;
    }
    return view(cached.release, cached.failed, cached.at);
  }

  function view(release, failed, at) {
    const newer = release ? compareVersions(release.version, version) === 1 : false;
    return {
      enabled,
      current: version,
      latest: release?.version ?? null,
      available: newer,
      checkedAt: at ? new Date(at).toISOString() : null,
      checkFailed: failed,
      releaseUrl: release?.url ?? null,
      publishedAt: release?.publishedAt ?? null,
      // Notes are only worth sending when they are for a version the operator does not run yet.
      notes: newer ? release.notes : null,
      notesText: newer ? release.notesText : null,
      command: UPDATE_COMMAND,
    };
  }

  return { get };
}
