// GitHub alerts: post selected event types from a watched repo to a channel.
// Unlike every other alert module (Twitch/YouTube/Kick/RSS), this one is
// push-based, not polled — GitHub POSTs to a per-repo webhook URL
// (src/web/routes/githubWebhook.js) the moment something happens, verified
// with the HMAC secret Sylo generated when the watch was created
// (src/db/githubWatches.js). Everything here is pure/synchronous and easy to
// unit-test; the route owns all the I/O (DB lookup, posting to Discord).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { log } from '../lib/log.js';

// The event types a watch can subscribe to. `key` must match GitHub's
// `X-GitHub-Event` header value exactly. Shown as checkboxes in the dashboard
// (src/web/views/guild/modules/github.ejs) and used to filter inbound events.
export const GITHUB_EVENT_TYPES = [
  { key: 'push', label: 'Commits pushed' },
  { key: 'release', label: 'Release published' },
  { key: 'issues', label: 'Issue opened / closed' },
  { key: 'pull_request', label: 'Pull request opened / merged / closed' },
  { key: 'star', label: 'Repo starred' },
  { key: 'fork', label: 'Repo forked' },
];
const VALID_EVENT_KEYS = new Set(GITHUB_EVENT_TYPES.map((e) => e.key));

/** Keep only recognised event keys, deduped — used when saving a watch's config. */
export function sanitiseGithubEvents(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map(String)
    .filter((k) => VALID_EVENT_KEYS.has(k) && !seen.has(k) && seen.add(k));
}

const COLOR = 0x24292f; // GitHub's own near-black

/**
 * Merge a role ping into an already-formatted message, if the watch has one
 * configured. Kept separate from formatGithubEvent() — that function is pure
 * per-event formatting and doesn't know which watch (or role) produced it.
 * @param {{ embeds: object[] }} message
 * @param {string | null | undefined} roleId
 */
export function applyRolePing(message, roleId) {
  if (!roleId) return message;
  return { ...message, content: `<@&${roleId}>`, allowedMentions: { roles: [roleId] } };
}

/**
 * Verify an inbound webhook's `X-Hub-Signature-256` header against the
 * raw (unparsed) request body and the watch's stored secret.
 * @param {string} secret
 * @param {Buffer} rawBody
 * @param {string | undefined} signatureHeader
 */
export function verifyGithubSignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=') || !Buffer.isBuffer(rawBody)) {
    return false;
  }
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

const truncate = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));

/**
 * Turn a validated (eventName, payload) pair into a channel.send() payload,
 * or null when this specific event/action isn't one we post about (e.g. a
 * release being edited rather than published, or a webhook ping).
 * @param {string} eventName The `X-GitHub-Event` header value.
 * @param {any} payload The parsed JSON body.
 * @returns {{ embeds: object[] } | null}
 */
export function formatGithubEvent(eventName, payload) {
  const repo = payload?.repository?.full_name ?? 'unknown/repo';
  const repoUrl = payload?.repository?.html_url ?? '';

  switch (eventName) {
    case 'push': {
      if (payload?.deleted || !Array.isArray(payload?.commits) || payload.commits.length === 0) return null;
      const branch = String(payload.ref ?? '').replace(/^refs\/heads\//, '');
      const commits = payload.commits.slice(-5).reverse();
      const lines = commits.map((c) => {
        const sha = String(c.id ?? '').slice(0, 7);
        const msg = truncate(String(c.message ?? '').split('\n')[0], 80);
        return `[\`${sha}\`](${c.url}) ${msg} — ${c.author?.name ?? 'someone'}`;
      });
      const more = payload.commits.length > 5 ? `\n…and ${payload.commits.length - 5} more` : '';
      return {
        embeds: [
          {
            color: COLOR,
            title: `${payload.commits.length} new commit${payload.commits.length === 1 ? '' : 's'} to ${repo} (${branch})`,
            url: payload.compare,
            description: lines.join('\n') + more,
          },
        ],
      };
    }

    case 'release': {
      if (payload?.action !== 'published') return null;
      const r = payload.release ?? {};
      return {
        embeds: [
          {
            color: COLOR,
            title: `🚀 New release: ${repo} ${r.tag_name ?? ''}`.trim(),
            url: r.html_url,
            description:
              [r.name, r.body ? truncate(r.body, 500) : null].filter(Boolean).join('\n') || undefined,
          },
        ],
      };
    }

    case 'issues': {
      if (!['opened', 'closed', 'reopened'].includes(payload?.action)) return null;
      const i = payload.issue ?? {};
      const verb = { opened: 'opened', closed: 'closed', reopened: 'reopened' }[payload.action];
      return {
        embeds: [
          {
            color: COLOR,
            title: `Issue ${verb}: ${repo}#${i.number} ${truncate(i.title, 200)}`,
            url: i.html_url,
            description: `by ${i.user?.login ?? 'someone'}`,
          },
        ],
      };
    }

    case 'pull_request': {
      if (!['opened', 'closed', 'reopened'].includes(payload?.action)) return null;
      const pr = payload.pull_request ?? {};
      const verb = payload.action === 'closed' ? (pr.merged ? 'merged' : 'closed') : payload.action;
      return {
        embeds: [
          {
            color: COLOR,
            title: `PR ${verb}: ${repo}#${payload.number} ${truncate(pr.title, 200)}`,
            url: pr.html_url,
            description: `by ${pr.user?.login ?? 'someone'}`,
          },
        ],
      };
    }

    case 'star': {
      if (payload?.action !== 'created') return null;
      return {
        embeds: [
          {
            color: COLOR,
            description: `⭐ **${payload.sender?.login ?? 'someone'}** starred **${repo}** (${payload.repository?.stargazers_count ?? '?'} total)`,
            url: repoUrl,
          },
        ],
      };
    }

    case 'fork': {
      const f = payload?.forkee ?? {};
      return {
        embeds: [
          {
            color: COLOR,
            description: `🍴 **${payload?.sender?.login ?? 'someone'}** forked **${repo}** → [${f.full_name}](${f.html_url})`,
          },
        ],
      };
    }

    default:
      return null;
  }
}

// --- changelog-file watching --------------------------------------------
// A separate, opt-in feature layered on top of 'push': instead of (or beside)
// the generic commit list above, post just the latest entry from a specific
// file — e.g. CHANGELOG.md — the moment a push actually changes it. Mirrors
// a common GitHub Actions pattern (checkout + awk the top heading block +
// curl a Discord webhook), moved into Sylo so it needs no workflow file.
//
// Public repos only for now: the file is fetched from raw.githubusercontent.com
// at the exact pushed commit, unauthenticated. A private repo needs a GitHub
// token Sylo doesn't have anywhere yet — attempting it just logs and skips,
// rather than failing in a confusing way.

/** Did this push touch `path` (added, modified, or removed in any commit)? */
export function pushTouchedPath(payload, path) {
  if (!path || !Array.isArray(payload?.commits)) return false;
  return payload.commits.some((c) =>
    [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])].includes(path)
  );
}

/**
 * Was this push to the repo's default branch? Release tooling (e.g.
 * release-please) commonly pushes the same changelog update to its own
 * long-lived release branch first, then again when a human merges that PR
 * into the default branch — without this check, both pushes touch the
 * changelog file and it gets posted twice for the same entry.
 */
export function isDefaultBranchPush(payload) {
  const branch = payload?.repository?.default_branch || 'main';
  return payload?.ref === `refs/heads/${branch}`;
}

/**
 * The first `## heading` block in `text` (its heading line through the line
 * before the next `## heading`, or end of file) — e.g. the newest entry in a
 * "Keep a Changelog"-style file, regardless of what's after `## ` on that
 * line (a version number, an emoji, a date, …). Null if no `## ` line exists.
 */
export function extractLatestChangelogBlock(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^##\s+/.test(l));
  if (startIdx === -1) return null;
  const rest = lines.slice(startIdx + 1);
  const endOffset = rest.findIndex((l) => /^##\s+/.test(l));
  const block = [lines[startIdx], ...(endOffset === -1 ? rest : rest.slice(0, endOffset))];
  const joined = block.join('\n').trim();
  return joined || null;
}

/**
 * Fetch `path` from a public repo at `ref` and extract its latest changelog
 * entry. Never throws — returns null (and logs why) on a private repo, a
 * missing file, or any fetch failure.
 * @param {string} repo "owner/repo"
 * @param {string} path
 * @param {string} ref a commit SHA (the push's `after`/`head_commit.id`)
 */
export async function fetchChangelogBlock(repo, path, ref) {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      log.warn(
        'module:github',
        `changelog fetch ${repo}/${path}@${ref.slice(0, 7)}: HTTP ${res.status}` +
          (res.status === 404 ? ' (private repo, or the path is wrong)' : '')
      );
      return null;
    }
    const block = extractLatestChangelogBlock(await res.text());
    if (!block) log.warn('module:github', `changelog fetch ${repo}/${path}: no "## " heading found`);
    return block;
  } catch (err) {
    log.warn('module:github', `changelog fetch ${repo}/${path}: ${err.message}`);
    return null;
  }
}

/** Format an extracted changelog block as a channel.send() payload. */
export function formatChangelogPost(repo, block, url) {
  return {
    embeds: [
      {
        color: COLOR,
        title: `📋 Changelog update: ${repo}`,
        url: url || undefined,
        description: truncate(block, 3800),
      },
    ],
  };
}
