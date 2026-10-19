// The changelog parser (src/lib/changelog.js) reads CHANGELOG.md (release-please's format)
// for the V2 page and the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  changelogFeed,
  parseChangelog,
  parseInline,
  sectionKind,
  sectionLabel,
} from '../src/lib/changelog.js';

const sample = `# Changelog

## [4.5.0](https://github.com/Ferdinand99/Sylo/compare/v4.4.0...v4.5.0) (2026-10-18)


### Features

* **dashboard:** bring the V2 dashboard level ([#261](https://github.com/Ferdinand99/Sylo/issues/261)) ([d8fdf6c](https://github.com/Ferdinand99/Sylo/commit/d8fdf6c))

### Bug Fixes

* keep the dashboard signed in ([#256](https://github.com/Ferdinand99/Sylo/issues/256))

## 3.0.0 (2026-09-01)

### ⚠ BREAKING CHANGES

- Node 22 is now required
`;

test('releases come out newest first with version, link and date', () => {
  const releases = parseChangelog(sample);
  assert.equal(releases.length, 2);
  assert.deepEqual(
    { version: releases[0].version, url: releases[0].url, date: releases[0].date },
    {
      version: '4.5.0',
      url: 'https://github.com/Ferdinand99/Sylo/compare/v4.4.0...v4.5.0',
      date: '2026-10-18',
    }
  );
  assert.equal(releases[1].version, '3.0.0');
  assert.equal(releases[1].url, null);
});

test('sections keep their titles and items', () => {
  const [latest, old] = parseChangelog(sample);
  assert.deepEqual(
    latest.sections.map((s) => [s.title, s.items.length]),
    [
      ['Features', 1],
      ['Bug Fixes', 1],
    ]
  );
  assert.equal(old.sections[0].title, '⚠ BREAKING CHANGES');
  assert.equal(old.sections[0].items[0].text, 'Node 22 is now required');
});

test('an item splits into its scope, its text and its PR, and drops the commit hash', () => {
  const item = parseChangelog(sample)[0].sections[0].items[0];
  assert.equal(item.scope, 'dashboard');
  assert.equal(item.text, 'Bring the V2 dashboard level', 'starts with a capital, as a sentence');
  assert.deepEqual(item.refs, [{ label: '#261', url: 'https://github.com/Ferdinand99/Sylo/issues/261' }]);
});

test('inline links and code become segments, never raw HTML', () => {
  assert.deepEqual(parseInline('use `/rank` or see [docs](https://x.test) <b>'), [
    { text: 'use ' },
    { code: '/rank' },
    { text: ' or see ' },
    { text: 'docs', href: 'https://x.test' },
    { text: ' <b>' },
  ]);
  assert.deepEqual(parseInline('a [bad](javascript:alert(1)) link'), [
    { text: 'a ' },
    { text: 'bad' },
    { text: ' link' },
  ]);
});

test("the repo's own CHANGELOG.md parses into releases with items", () => {
  const releases = parseChangelog(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'));
  assert.ok(releases.length > 50);
  assert.match(releases[0].version, /^\d+\.\d+\.\d+$/);
  assert.ok(releases.every((r) => r.sections.every((s) => s.items.every((i) => i.text.length > 0))));
});

test("release-please's section titles map to a kind and the words the page and the app use", () => {
  const cases = [
    ['Features', 'features', 'New'],
    ['Bug Fixes', 'fixes', 'Fixes'],
    ['Performance Improvements', 'performance', 'Faster'],
    ['⚠ BREAKING CHANGES', 'breaking', 'Breaking changes'],
    ['BREAKING CHANGES', 'breaking', 'BREAKING CHANGES'],
    ['Miscellaneous Chores', 'other', 'Miscellaneous Chores'],
    ['Changes', 'other', 'Changes'],
  ];
  for (const [title, kind, label] of cases) {
    assert.equal(sectionKind(title), kind, title);
    assert.equal(sectionLabel(title), label, title);
  }
});

test('the feed is the parsed releases in the API shape: labelled sections, no render segments', () => {
  const [latest, old] = changelogFeed(sample);
  assert.deepEqual(latest, {
    version: '4.5.0',
    date: '2026-10-18',
    url: 'https://github.com/Ferdinand99/Sylo/compare/v4.4.0...v4.5.0',
    sections: [
      {
        title: 'New',
        kind: 'features',
        items: [
          {
            scope: 'dashboard',
            text: 'Bring the V2 dashboard level',
            refs: [{ label: '#261', url: 'https://github.com/Ferdinand99/Sylo/issues/261' }],
          },
        ],
      },
      {
        title: 'Fixes',
        kind: 'fixes',
        items: [
          {
            scope: null,
            text: 'Keep the dashboard signed in',
            refs: [{ label: '#256', url: 'https://github.com/Ferdinand99/Sylo/issues/256' }],
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    old.sections.map((s) => [s.title, s.kind]),
    [['Breaking changes', 'breaking']]
  );
});

test('the feed keeps the newest `limit` releases', () => {
  assert.deepEqual(
    changelogFeed(sample, { limit: 1 }).map((r) => r.version),
    ['4.5.0']
  );
  assert.equal(changelogFeed(sample).length, 2, 'no limit: every release');
});
