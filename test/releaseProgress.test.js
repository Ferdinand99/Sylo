import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  buildBar,
  percent,
  parseTitle,
  shortName,
  roadmapName,
  checklistRows,
  groupOf,
  toItems,
  buildEmbed,
  messageVarName,
  parseMilestones,
  milestoneHeading,
  stageOf,
  progressOf,
  sendToDiscord,
} from '../scripts/roadmap.mjs';

test('release progress: bar and percentage round down so 100 % only shows when everything is done', () => {
  assert.equal(buildBar(0, 0), '▱▱▱▱▱▱▱▱▱▱');
  assert.equal(percent(0, 0), 0);
  assert.equal(buildBar(0, 20), '▱▱▱▱▱▱▱▱▱▱');
  assert.equal(buildBar(5, 20), '▰▰▱▱▱▱▱▱▱▱');
  assert.equal(percent(5, 20), 25);
  assert.equal(buildBar(19, 20), '▰▰▰▰▰▰▰▰▰▱');
  assert.equal(percent(19, 20), 95);
  assert.equal(buildBar(20, 20), '▰▰▰▰▰▰▰▰▰▰');
  assert.equal(percent(20, 20), 100);
  assert.equal(percent(1, 3), 33);
});

test('release progress: parseTitle strips the commit prefix, a trailing aside and anything after ";"', () => {
  assert.deepEqual(parseTitle('feat(mirror): mirror a Discord server (5.3)'), {
    type: 'feat',
    scope: 'mirror',
    text: 'mirror a Discord server',
  });
  assert.equal(parseTitle('fix: audit leftovers (live-alert batches, DM lookups)').text, 'audit leftovers');
  assert.equal(parseTitle('feat(x): one thing; and another').text, 'one thing');
  assert.deepEqual(parseTitle('Release Sylo 5.3'), { type: null, scope: '', text: 'Release Sylo 5.3' });
});

test('release progress: shortName falls back to a plain title; fixes keep their area; no cutting', () => {
  const pr = (title) => ({ kind: 'pr', number: 1, title, done: false });
  assert.equal(
    shortName(pr('feat(bridge): link a Discord channel to a Fluxer channel')),
    'Link a Discord channel to a Fluxer channel'
  );
  assert.equal(
    shortName(pr("fix(honeypot): count every catch in the bait embed's channel")),
    "Honeypot: count every catch in the bait embed's channel"
  );
  assert.equal(
    shortName({ kind: 'issue', number: 2, title: 'Test 5.3 on the test bot', done: false }),
    'Test 5.3 on the test bot'
  );
  const long = shortName(pr('feat(x): ' + 'word '.repeat(40)));
  assert.ok(long.length > 150 && !long.includes('…'));
});

test('release progress: a "Roadmap:" line in the body gives the member-friendly name', () => {
  assert.equal(roadmapName('Some text\n\nRoadmap: Focused moderator view\n'), 'Focused moderator view');
  assert.equal(roadmapName('roadmap:   Lower case line  \r\nmore'), 'Lower case line');
  assert.equal(roadmapName('Roadmap: internal'), 'Smaller fixes and improvements');
  assert.equal(roadmapName('Mentions Roadmap: in the middle of a line'), '');
  assert.equal(roadmapName(null), '');
  assert.equal(
    shortName({ kind: 'pr', number: 1, title: 'feat: x', name: 'Nice name', done: true }),
    'Nice name'
  );
});

test('release progress: items with the same name share one line; internal ones collapse last', () => {
  const pr = (number, name, done) => ({ kind: 'pr', number, title: 'fix: x', name, done });
  assert.deepEqual(
    checklistRows([
      pr(1, 'Smaller fixes and improvements', true),
      pr(2, 'Alerts fix', true),
      pr(3, 'Smaller fixes and improvements', false),
      pr(4, 'Alerts fix', false),
      pr(5, 'Smaller fixes and improvements', true),
      pr(6, 'Done thing', true),
    ]),
    ['🔨 Alerts fix (1 of 2)', '✅ Done thing', '🔨 Smaller fixes and improvements (2 of 3)']
  );
  // Internal items count in the "fix" group even when their title says feat.
  assert.equal(
    groupOf({ kind: 'pr', title: 'feat(db): index', name: 'Smaller fixes and improvements' }),
    'fix'
  );
});

test('release progress: toItems counts merged PRs and closed issues, and drops abandoned PRs', () => {
  const items = toItems([
    { number: 1, title: 'feat: a', state: 'closed', pull_request: { merged_at: '2026-11-26T10:00:00Z' } },
    { number: 2, title: 'feat: b', state: 'open', pull_request: { merged_at: null } },
    { number: 3, title: 'feat: c', state: 'closed', pull_request: { merged_at: null } },
    { number: 4, title: 'Test it', state: 'closed' },
    { number: 5, title: 'Release it', state: 'open', body: 'Roadmap: Ship it' },
  ]);
  assert.deepEqual(
    items.map((i) => [i.number, i.kind, i.done, i.name]),
    [
      [1, 'pr', true, ''],
      [2, 'pr', false, ''],
      [4, 'issue', true, ''],
      [5, 'issue', false, 'Ship it'],
    ]
  );
});

test('release progress: groupOf puts features, fixes and non-code steps in separate groups', () => {
  assert.equal(groupOf({ kind: 'pr', title: 'feat(a): x' }), 'feature');
  assert.equal(groupOf({ kind: 'pr', title: 'fix(a): x' }), 'fix');
  assert.equal(groupOf({ kind: 'pr', title: 'chore: x' }), 'fix');
  assert.equal(groupOf({ kind: 'issue', title: 'Release Sylo 5.3' }), 'step');
});

test('release progress: buildEmbed groups the checklist, non-code steps last, within Discord limits', () => {
  const items = [
    { kind: 'issue', number: 9, title: 'Release Sylo 5.3', done: false },
    { kind: 'pr', number: 7, title: 'fix(honeypot): count every catch', done: true },
    { kind: 'pr', number: 5, title: 'feat(mirror): mirror a server', done: true },
    { kind: 'pr', number: 3, title: 'feat(bridge): link a channel', done: false },
    { kind: 'issue', number: 8, title: 'Test 5.3 on the test bot', done: false },
  ];
  const embed = buildEmbed('5.3', items);
  assert.equal(embed.title, 'Sylo 5.3 — progress');
  assert.equal(embed.footer.text, 'Updated automatically');
  assert.equal(embed.color, 0x38c8f0);
  assert.equal(
    embed.description,
    [
      '▰▰▰▰▱▱▱▱▱▱ **40%** · 2 done · 3 to go',
      '✅ done · ☑️ tested · 🧪 waiting for test · 🔨 in progress',
      '',
      '**New features**',
      '🔨 Link a channel',
      '✅ Mirror a server',
      '',
      '**Fixes**',
      '✅ Honeypot: count every catch',
      '',
      '**Still to do**',
      '🔨 Test 5.3 on the test bot',
      '🔨 Release Sylo 5.3',
    ].join('\n')
  );

  const many = Array.from({ length: 200 }, (_, i) => ({
    kind: 'pr',
    number: i,
    title: 'feat(x): ' + 'long feature name '.repeat(5),
    done: false,
  }));
  assert.ok(buildEmbed('5.3', many).description.length <= 4096);
  assert.match(buildEmbed('5.3', []).description, /Nothing is planned yet/);
});

test('release progress: stages - tested counts five sixths, ready four, and tested wins over ready', () => {
  const api = (number, state, labels, merged) => ({
    number,
    title: 'feat: x' + number,
    state,
    labels,
    pull_request: { merged_at: merged ? '2026-11-26T10:00:00Z' : null },
  });
  const items = toItems([
    api(1, 'closed', [], true),
    api(2, 'open', [{ name: 'ready-for-test' }], false),
    api(3, 'open', [{ name: 'enhancement' }], false),
    api(5, 'open', [{ name: 'tested' }], false),
    api(6, 'open', [{ name: 'ready-for-test' }, { name: 'tested' }], false),
    api(7, 'closed', [{ name: 'tested' }], true),
    { number: 4, title: 'Release it', state: 'open', labels: [] },
  ]);
  assert.deepEqual(items.map(stageOf), ['done', 'test', 'progress', 'tested', 'tested', 'done', 'progress']);
  assert.deepEqual(progressOf(items), { points: 6 + 4 + 0 + 5 + 5 + 6 + 0, max: 42 });
  assert.deepEqual(progressOf([]), { points: 0, max: 0 });
  const lines = buildEmbed('5.3', items).description.split('\n');
  assert.equal(lines[0], '▰▰▰▰▰▰▱▱▱▱ **61%** · 2 done · 2 tested · 1 waiting for test · 2 to go');
  assert.ok(lines.includes('🧪 X2'));
  assert.ok(lines.includes('☑️ X5'));
  const waiting = [{ kind: 'pr', number: 1, title: 'feat: a', stage: 'test' }];
  assert.equal(
    buildEmbed('5.3', waiting).description.split('\n')[0],
    '▰▰▰▰▰▰▱▱▱▱ **66%** · 0 done · 1 waiting for test'
  );
  const tested = [{ kind: 'pr', number: 1, title: 'feat: a', stage: 'tested' }];
  assert.equal(
    buildEmbed('5.3', tested).description.split('\n')[0],
    '▰▰▰▰▰▰▰▰▱▱ **83%** · 0 done · 1 tested'
  );
});

test('release progress: a group row shows its least advanced stage', () => {
  const pr = (number, stage) => ({ kind: 'pr', number, title: 'fix: x', name: 'Thing', stage });
  assert.deepEqual(checklistRows([pr(1, 'done'), pr(2, 'tested')]), ['☑️ Thing (1 of 2)']);
  assert.deepEqual(checklistRows([pr(1, 'tested'), pr(2, 'test')]), ['🧪 Thing (0 of 2)']);
  assert.deepEqual(checklistRows([pr(1, 'tested'), pr(2, 'tested')]), ['☑️ Thing (0 of 2)']);
  assert.deepEqual(checklistRows([pr(1, 'tested'), pr(2, 'progress')]), ['🔨 Thing (0 of 2)']);
});

test('release progress: a closed milestone is shown as released', () => {
  assert.equal(buildEmbed('5.3', [], { released: true }).title, 'Sylo 5.3 — released');
});

test('release progress: each version has its own message id variable', () => {
  assert.equal(messageVarName('5.3'), 'ROADMAP_MESSAGE_ID_5_3');
  assert.equal(messageVarName('5.10'), 'ROADMAP_MESSAGE_ID_5_10');
  assert.equal(messageVarName('iOS 1.3'), 'ROADMAP_MESSAGE_ID_IOS_1_3');
});

test('release progress: ROADMAP_MILESTONE may list several milestones', () => {
  assert.deepEqual(parseMilestones(undefined), ['5.3']);
  assert.deepEqual(parseMilestones(''), ['5.3']);
  assert.deepEqual(parseMilestones(' , '), ['5.3']);
  assert.deepEqual(parseMilestones('5.3'), ['5.3']);
  assert.deepEqual(parseMilestones('5.3, iOS 1.3'), ['5.3', 'iOS 1.3']);
  assert.deepEqual(parseMilestones('iOS 1.3,,5.3, iOS 1.3'), ['iOS 1.3', '5.3']);
});

test('release progress: iOS milestones are titled as the iOS app', () => {
  assert.equal(milestoneHeading('5.3'), 'Sylo 5.3');
  assert.equal(milestoneHeading('iOS 1.3'), 'Sylo iOS app 1.3');
  assert.equal(buildEmbed('iOS 1.3', []).title, 'Sylo iOS app 1.3 — progress');
  assert.equal(buildEmbed('iOS 1.3', [], { released: true }).title, 'Sylo iOS app 1.3 — released');
  assert.equal(buildEmbed('5.3', []).title, 'Sylo 5.3 — progress');
});

test('release progress: a new message is only posted when explicitly allowed', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init.method]);
    return init.method === 'POST'
      ? { ok: true, status: 200, json: async () => ({ id: '123' }) }
      : { ok: false, status: 404 };
  };
  try {
    const hook = 'https://discord.example/api/webhooks/1/token';
    assert.deepEqual(await sendToDiscord(hook, '', {}), { action: 'skipped' });
    assert.equal(calls.length, 0);
    assert.deepEqual(await sendToDiscord(hook, '42', {}), { action: 'missing', id: '42' });
    assert.equal(calls.at(-1)[1], 'PATCH');
    assert.equal(calls.length, 1);
    assert.deepEqual(await sendToDiscord(hook, '', {}, { allowPost: true }), { action: 'posted', id: '123' });
    assert.equal(calls.at(-1)[0], `${hook}?wait=true`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Runs the real script with a fake fetch, so the per-milestone loop is covered end to end.
function runRoadmap(env, { failIssuesFor } = {}) {
  const preload = `
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(String(url));
      const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
      if (u.hostname === 'api.github.com') {
        if (u.pathname.endsWith('/milestones')) {
          return json(200, u.searchParams.get('page') === '1'
            ? [{ number: 1, title: '5.3', state: 'open' }, { number: 2, title: 'iOS 1.3', state: 'open' }]
            : []);
        }
        if (u.searchParams.get('milestone') === ${JSON.stringify(failIssuesFor ?? '')}) return json(500, {});
        return json(200, []);
      }
      console.log('DISCORD ' + (init.method || 'GET') + ' ' + u.pathname + ' ' + JSON.parse(init.body).embeds[0].title);
      return json(200, { id: 'new-id' });
    };`;
  return spawnSync(
    process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'scripts/roadmap.mjs'],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_TOKEN: 't',
        ROADMAP_WEBHOOK_URL: 'https://discord.example/api/webhooks/1/secret-token',
        ...env,
      },
    }
  );
}

test('release progress: every listed milestone is updated, each with its own message id', () => {
  const r = runRoadmap({
    ROADMAP_MILESTONE: '5.3, iOS 1.3',
    ROADMAP_VARS: JSON.stringify({ ROADMAP_MESSAGE_ID_5_3: '11', ROADMAP_MESSAGE_ID_IOS_1_3: '22' }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DISCORD PATCH \/api\/webhooks\/1\/secret-token\/messages\/11 Sylo 5\.3 — progress/);
  assert.match(
    r.stdout,
    /DISCORD PATCH \/api\/webhooks\/1\/secret-token\/messages\/22 Sylo iOS app 1\.3 — progress/
  );
});

test('release progress: post only creates a message where the id variable is empty', () => {
  const r = runRoadmap({
    ROADMAP_MILESTONE: '5.3, iOS 1.3',
    ROADMAP_ALLOW_POST: 'true',
    ROADMAP_VARS: JSON.stringify({ ROADMAP_MESSAGE_ID_5_3: '11', ROADMAP_MESSAGE_ID_IOS_1_3: '' }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DISCORD PATCH .*\/messages\/11 Sylo 5\.3/);
  assert.match(r.stdout, /DISCORD POST \/api\/webhooks\/1\/secret-token Sylo iOS app 1\.3/);
  assert.equal(r.stdout.match(/DISCORD POST/g).length, 1);
});

test('release progress: one failing milestone does not stop the others, but the run fails', () => {
  const r = runRoadmap(
    {
      ROADMAP_MILESTONE: '5.3, iOS 1.3',
      ROADMAP_VARS: JSON.stringify({ ROADMAP_MESSAGE_ID_5_3: '11', ROADMAP_MESSAGE_ID_IOS_1_3: '22' }),
    },
    { failIssuesFor: '1' }
  );
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /Sylo 5\.3/);
  assert.match(r.stdout, /messages\/22 Sylo iOS app 1\.3/);
  assert.match(r.stderr, /failed for 5\.3/);
});
