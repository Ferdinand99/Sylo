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
//   ROADMAP_MESSAGE_ID                the message to edit; empty = post a new one
//   GITHUB_STEP_SUMMARY               set by GitHub Actions; the new message id is written here
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEGMENTS = 10;
// Sylo's accent colour (web-v2 --accent, #38c8f0).
export const EMBED_COLOR = 0x38c8f0;
const MAX_TITLE = 72;
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
  return Math.floor((done / total) * 100);
}

export function buildBar(done, total, segments = SEGMENTS) {
  const filled = total ? Math.floor((done / total) * segments) : 0;
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

function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '') + '…';
}

export function groupOf(item) {
  if (item.kind === 'issue') return 'step';
  const { type } = parseTitle(item.title);
  return type === 'feat' ? 'feature' : 'fix';
}

// Plain name for the checklist: no conventional-commit prefix, capitalised, with the area in front
// for fixes ("Honeypot: count every catch ...").
export function shortName(item) {
  if (item.kind === 'issue') return truncate(item.title.trim(), MAX_TITLE);
  const { type, scope, text } = parseTitle(item.title);
  const base = capitalise(text);
  const named = type && type !== 'feat' && scope ? `${capitalise(scope.replace(/-/g, ' '))}: ${text}` : base;
  return truncate(named, MAX_TITLE);
}

// Turn the milestone's issues + pull requests (as the GitHub issues API returns them) into items.
// A pull request that was closed without merging is dropped: it is no longer part of the plan.
export function toItems(apiItems) {
  const items = [];
  for (const it of apiItems) {
    if (it.pull_request) {
      const merged = Boolean(it.pull_request.merged_at);
      if (it.state === 'closed' && !merged) continue;
      items.push({ kind: 'pr', number: it.number, title: it.title, done: merged });
    } else {
      items.push({ kind: 'issue', number: it.number, title: it.title, done: it.state === 'closed' });
    }
  }
  return items;
}

export function buildEmbed(milestoneTitle, items) {
  const total = items.length;
  const done = items.filter((i) => i.done).length;
  const pct = percent(done, total);
  const lines = [`${buildBar(done, total)} **${pct}%** · ${done} of ${total} done`, ''];

  for (const { key, heading } of GROUPS) {
    const rows = items
      .filter((i) => groupOf(i) === key)
      .sort((a, b) => a.number - b.number)
      .map((i) => `${i.done ? '✅' : '🔄'} ${shortName(i)}`);
    if (!rows.length) continue;
    lines.push(`**${heading}**`, ...rows, '');
  }
  if (!total) lines.push('Nothing is planned yet.');

  let description = lines.join('\n').trim();
  if (description.length > MAX_DESCRIPTION) {
    description = description.slice(0, MAX_DESCRIPTION - 1).replace(/\n[^\n]*$/, '') + '\n…';
  }

  return {
    title: `Sylo ${milestoneTitle} — progress`,
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
export async function sendToDiscord(webhookUrl, messageId, embed) {
  const url = new URL(webhookUrl);
  const body = JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } });
  const headers = { 'Content-Type': 'application/json' };

  if (messageId) {
    const edit = new URL(url);
    edit.pathname = `${url.pathname.replace(/\/$/, '')}/messages/${encodeURIComponent(messageId)}`;
    const res = await fetch(edit, { method: 'PATCH', headers, body });
    if (res.ok) return { action: 'edited', id: messageId };
    // The message was deleted: fall through and post a fresh one instead of failing for good.
    if (res.status !== 404) throw new Error(`Discord returned ${res.status} when editing the message`);
    console.log('The saved message no longer exists; posting a new one.');
  }

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
  const { items } = await loadMilestone(env.GITHUB_REPOSITORY, title, env.GITHUB_TOKEN);
  const embed = buildEmbed(title, items);
  const done = items.filter((i) => i.done).length;

  const result = await sendToDiscord(webhook, (env.ROADMAP_MESSAGE_ID || '').trim(), embed);
  const pct = percent(done, items.length);
  if (result.action === 'posted') {
    console.log(`Posted a new progress message (${pct}%, ${done}/${items.length}).`);
    summary(
      `### Progress message posted\n\nMessage id: \`${result.id}\`\n\n` +
        'Save it as the repository variable `ROADMAP_MESSAGE_ID` so later runs edit this message ' +
        'instead of posting a new one.'
    );
  } else {
    console.log(`Edited the progress message ${result.id} (${pct}%, ${done}/${items.length}).`);
    summary(
      `### Progress message edited\n\nMessage id: \`${result.id}\` · ${pct}% (${done}/${items.length})`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`roadmap: ${err.message}`);
    process.exit(1);
  });
}
