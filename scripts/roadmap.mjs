// Posts (or edits) one Discord message that shows how far the next release is.
//
// It reads a GitHub milestone, counts its pull requests (done = merged) and issues (done = closed),
// builds a Discord embed and sends it to a webhook. Run by .github/workflows/roadmap.yml; it needs no
// dependencies, only Node's built-in fetch.
//
// Environment:
//   GITHUB_TOKEN, GITHUB_REPOSITORY   set by GitHub Actions
//   ROADMAP_WEBHOOK_URL               the Discord webhook (a secret, never printed)
//   ROADMAP_MILESTONE                 milestone title, default "5.3"
//   ROADMAP_MESSAGE_ID                this version's message to edit (repo variable ROADMAP_MESSAGE_ID_<version>)
//   ROADMAP_ALLOW_POST                "true" on a manual run that ticked "post": may create the message
//   GITHUB_STEP_SUMMARY               set by GitHub Actions; the new message id is written here
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEGMENTS = 10;
// Sylo's accent colour (web-v2 --accent, #38c8f0).
export const EMBED_COLOR = 0x38c8f0;
// Collapsed into one line: items whose "Roadmap:" line says "internal".
export const INTERNAL_NAME = 'Smaller fixes and improvements';
const MAX_DESCRIPTION = 4000; // Discord allows 4096; keep a margin.

// Order of the checklist; the non-code steps come last.
export const GROUPS = [
  { key: 'feature', heading: 'New features' },
  { key: 'fix', heading: 'Fixes' },
  { key: 'step', heading: 'Still to do' },
];

export function percent(done, total) {
  if (!total) return 0;
  // Rounded down, so 100 % only ever shows when everything is done.
  return Math.floor((done * 100) / total);
}

export function buildBar(done, total, segments = SEGMENTS) {
  const filled = total ? Math.floor((done * segments) / total) : 0;
  return '▰'.repeat(filled) + '▱'.repeat(segments - filled);
}

// "feat(mirror): mirror a Discord server (5.3)" -> { type: 'feat', scope: 'mirror', text: 'mirror a Discord server' }
export function parseTitle(title) {
  const m = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.*)$/.exec(String(title).trim());
  const type = m ? m[1].toLowerCase() : null;
  const scope = m ? m[2] || '' : '';
  let text = m ? m[3] : String(title).trim();
  // Drop a trailing "(...)" aside, then anything after the first ";" - the short feature name is
  // what matters in a chat message.
  text = text
    .replace(/\s*\([^()]*\)\s*$/, '')
    .split(';')[0]
    .trim();
  return { type, scope, text };
}

function capitalise(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// The member-friendly name for an item: an optional line "Roadmap: <name>" in the PR or issue body.
// "Roadmap: internal" files the item under the one collapsed "Smaller fixes and improvements" line.
// Returns '' when the body has no such line.
export function roadmapName(body) {
  const m = /^[ \t]*Roadmap:[ \t]*(.+?)[ \t]*$/im.exec(String(body ?? ''));
  if (!m) return '';
  return m[1].toLowerCase() === 'internal' ? INTERNAL_NAME : m[1];
}

export function groupOf(item) {
  if (item.kind === 'issue') return 'step';
  if (item.name === INTERNAL_NAME) return 'fix';
  const { type } = parseTitle(item.title);
  return type === 'feat' ? 'feature' : 'fix';
}

// Plain name for the checklist. The "Roadmap:" line wins; without one, fall back to the title with
// the conventional-commit prefix removed, capitalised, with the area in front for fixes
// ("Honeypot: count every catch ...").
export function shortName(item) {
  if (item.name) return item.name;
  if (item.kind === 'issue') return item.title.trim();
  const { type, scope, text } = parseTitle(item.title);
  return type && type !== 'feat' && scope
    ? `${capitalise(scope.replace(/-/g, ' '))}: ${text}`
    : capitalise(text);
}

// Where an item is: 'done' (PR merged, issue closed), 'test' (built and reviewed, waiting for a test:
// an open PR with the ready label) or 'progress'. Counted in thirds: done 3, test 2, progress 0.
export const READY_LABEL = 'ready-for-test';
export const STAGE_POINTS = { done: 3, test: 2, progress: 0 };
export const STAGE_ICON = { done: '✅', test: '🧪', progress: '🔨' };
export const LEGEND = '✅ done · 🧪 built, waiting for test · 🔨 in progress';

export function stageOf(item) {
  return item.stage ?? (item.done ? 'done' : 'progress');
}

export function progressOf(items) {
  const points = items.reduce((sum, i) => sum + STAGE_POINTS[stageOf(i)], 0);
  return { points, max: items.length * STAGE_POINTS.done };
}

// The checklist rows of one group: items with the same name share one line, which shows the least
// advanced stage of its items, with "(n of m)" until all of them are done. Internal items end up on
// a single line, last.
export function checklistRows(items) {
  const lines = new Map();
  for (const item of [...items].sort((a, b) => a.number - b.number)) {
    const name = shortName(item);
    if (!lines.has(name)) lines.set(name, []);
    lines.get(name).push(item);
  }
  const rows = [...lines.entries()].map(([name, group]) => {
    const done = group.filter((i) => stageOf(i) === 'done').length;
    const least = group.map(stageOf).sort((a, b) => STAGE_POINTS[a] - STAGE_POINTS[b])[0];
    const count = group.length > 1 && done < group.length ? ` (${done} of ${group.length})` : '';
    return { name, text: `${STAGE_ICON[least]} ${name}${count}` };
  });
  rows.sort((a, b) => (a.name === INTERNAL_NAME) - (b.name === INTERNAL_NAME));
  return rows.map((r) => r.text);
}

// Turn the milestone's issues + pull requests (as the GitHub issues API returns them) into items.
// A pull request that was closed without merging is dropped: it is no longer part of the plan.
export function toItems(apiItems) {
  const items = [];
  for (const it of apiItems) {
    if (it.pull_request) {
      const merged = Boolean(it.pull_request.merged_at);
      if (it.state === 'closed' && !merged) continue;
      const ready = (it.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === READY_LABEL);
      const stage = merged ? 'done' : ready ? 'test' : 'progress';
      items.push({
        kind: 'pr',
        number: it.number,
        title: it.title,
        name: roadmapName(it.body),
        stage,
        done: merged,
      });
    } else {
      const done = it.state === 'closed';
      items.push({
        kind: 'issue',
        number: it.number,
        title: it.title,
        name: roadmapName(it.body),
        stage: done ? 'done' : 'progress',
        done,
      });
    }
  }
  return items;
}

// "5.3" -> "ROADMAP_MESSAGE_ID_5_3": every version keeps its own message, so the id lives in a
// repo variable per milestone. (The workflow derives the same name.)
export function messageVarName(milestoneTitle) {
  return `ROADMAP_MESSAGE_ID_${String(milestoneTitle)
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase()}`;
}

export function buildEmbed(milestoneTitle, items, { released = false } = {}) {
  const total = items.length;
  const done = items.filter((i) => stageOf(i) === 'done').length;
  const { points, max } = progressOf(items);
  const pct = percent(points, max);
  const lines = [`${buildBar(points, max)} **${pct}%** · ${done} of ${total} done`, LEGEND, ''];

  for (const { key, heading } of GROUPS) {
    const rows = checklistRows(items.filter((i) => groupOf(i) === key));
    if (!rows.length) continue;
    lines.push(`**${heading}**`, ...rows, '');
  }
  if (!total) lines.push('Nothing is planned yet.');

  let description = lines.join('\n').trim();
  if (description.length > MAX_DESCRIPTION) {
    description = description.slice(0, MAX_DESCRIPTION - 1).replace(/\n[^\n]*$/, '') + '\n…';
  }

  return {
    title: `Sylo ${milestoneTitle} — ${released ? 'released' : 'progress'}`,
    description,
    color: EMBED_COLOR,
    footer: { text: 'Updated automatically' },
    timestamp: new Date().toISOString(),
  };
}

async function github(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sylo-roadmap',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path.split('?')[0]}`);
  return res.json();
}

async function paged(path, token) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const rows = await github(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, token);
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

export async function loadMilestone(repo, title, token) {
  const milestones = await paged(`/repos/${repo}/milestones?state=all`, token);
  const milestone = milestones.find((m) => m.title === title);
  if (!milestone) throw new Error(`Milestone "${title}" not found in ${repo}`);
  const apiItems = await paged(`/repos/${repo}/issues?milestone=${milestone.number}&state=all`, token);
  return { milestone, items: toItems(apiItems) };
}

// The webhook URL is a secret: it is only ever used to build requests, never printed, and errors
// mention the status code only.
//
// A new message is posted only when `allowPost` is true (a manual run that asked for it). Any other
// run without a saved message id does nothing, so two events cannot both post the message. If the
// saved message is gone (404) nothing is posted either; the caller just logs a notice.
export async function sendToDiscord(webhookUrl, messageId, embed, { allowPost = false } = {}) {
  const url = new URL(webhookUrl);
  const body = JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } });
  const headers = { 'Content-Type': 'application/json' };

  if (messageId) {
    const edit = new URL(url);
    edit.pathname = `${url.pathname.replace(/\/+$/, '')}/messages/${encodeURIComponent(messageId)}`;
    const res = await fetch(edit, { method: 'PATCH', headers, body });
    if (res.ok) return { action: 'edited', id: messageId };
    if (res.status === 404) return { action: 'missing', id: messageId };
    throw new Error(`Discord returned ${res.status} when editing the message`);
  }
  if (!allowPost) return { action: 'skipped' };

  const create = new URL(url);
  create.searchParams.set('wait', 'true');
  const res = await fetch(create, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`Discord returned ${res.status} when posting the message`);
  const message = await res.json();
  return { action: 'posted', id: message.id };
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
}

async function main() {
  const env = process.env;
  const webhook = env.ROADMAP_WEBHOOK_URL;
  if (!webhook) {
    // Runs without secrets (Dependabot pull requests, forks) have nothing to do.
    console.log('ROADMAP_WEBHOOK_URL is not available in this run; nothing to update.');
    return;
  }
  console.log(`::add-mask::${webhook}`);

  const title = env.ROADMAP_MILESTONE || '5.3';
  const varName = messageVarName(title);
  const { milestone, items } = await loadMilestone(env.GITHUB_REPOSITORY, title, env.GITHUB_TOKEN);
  const embed = buildEmbed(title, items, { released: milestone.state === 'closed' });
  const { points, max } = progressOf(items);
  const pct = percent(points, max);
  const stats = `${pct}%, ${items.filter((i) => stageOf(i) === 'done').length}/${items.length} done`;

  // The id of this version's message comes from the repo variable ROADMAP_MESSAGE_ID_<version>.
  const result = await sendToDiscord(webhook, (env.ROADMAP_MESSAGE_ID || '').trim(), embed, {
    allowPost: env.ROADMAP_ALLOW_POST === 'true',
  });
  if (result.action === 'skipped') {
    console.log(
      `No ${varName} is set, so nothing was posted. To post the message for ${title}, run this ` +
        `workflow manually with "post" ticked, then save the message id as ${varName}.`
    );
  } else if (result.action === 'missing') {
    console.log(
      `::notice::The progress message ${result.id} no longer exists, so nothing was updated or posted. ` +
        `Set ${varName} to the id of the message that is still there, or run the workflow ` +
        'manually with "post" ticked to create a new one.'
    );
  } else if (result.action === 'posted') {
    console.log(`Posted a new progress message ${result.id} for ${title} (${stats}).`);
    summary(
      `### Progress message posted\n\nMessage id: \`${result.id}\`\n\n` +
        `Save it as the repository variable \`${varName}\` so later runs edit this message ` +
        'instead of posting a new one.'
    );
  } else {
    console.log(`Edited the progress message ${result.id} for ${title} (${stats}).`);
    summary(`### Progress message edited\n\nMessage id: \`${result.id}\` · ${stats}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`roadmap: ${err.message}`);
    process.exit(1);
  });
}
