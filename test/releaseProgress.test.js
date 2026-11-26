import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBar,
  percent,
  parseTitle,
  shortName,
  groupOf,
  toItems,
  buildEmbed,
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

test('release progress: shortName is plain, capitalised and short; fixes keep their area', () => {
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
  assert.ok(long.length <= 72 && long.endsWith('…'));
});

test('release progress: toItems counts merged PRs and closed issues, and drops abandoned PRs', () => {
  const items = toItems([
    { number: 1, title: 'feat: a', state: 'closed', pull_request: { merged_at: '2026-11-26T10:00:00Z' } },
    { number: 2, title: 'feat: b', state: 'open', pull_request: { merged_at: null } },
    { number: 3, title: 'feat: c', state: 'closed', pull_request: { merged_at: null } },
    { number: 4, title: 'Test it', state: 'closed' },
    { number: 5, title: 'Release it', state: 'open' },
  ]);
  assert.deepEqual(
    items.map((i) => [i.number, i.kind, i.done]),
    [
      [1, 'pr', true],
      [2, 'pr', false],
      [4, 'issue', true],
      [5, 'issue', false],
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
      '▰▰▰▰▱▱▱▱▱▱ **40%** · 2 of 5 done',
      '',
      '**New features**',
      '🔄 Link a channel',
      '✅ Mirror a server',
      '',
      '**Fixes**',
      '✅ Honeypot: count every catch',
      '',
      '**Still to do**',
      '🔄 Test 5.3 on the test bot',
      '🔄 Release Sylo 5.3',
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
