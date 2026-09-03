import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseRssConfig,
  fillTemplate,
  feedSource,
  buildPayload,
  parseFeedRef,
  sourceLabel,
} from '../src/modules/rss.js';

const CH = '123456789012345678';

test('normaliseRssConfig: validates url + channel, assigns/keeps ids, dedupes, caps', () => {
  const c = normaliseRssConfig({
    feeds: [
      { id: 'abcdef12', url: 'https://a.com/feed', channelId: CH, roleId: '999999999999999999' },
      { url: 'https://b.com/rss', channelId: CH }, // gets a fresh id
      { url: 'ftp://c.com/x', channelId: CH }, // dropped: bad scheme
      { url: 'https://a.com/feed', channelId: CH }, // dropped: dupe url+channel
      { url: 'https://d.com/feed', channelId: 'nope' }, // dropped: bad channel
    ],
  });
  assert.equal(c.feeds.length, 2);
  assert.equal(c.feeds[0].id, 'abcdef12'); // valid id kept
  assert.match(c.feeds[1].id, /^[0-9a-f]{8}$/); // fresh id assigned
  assert.equal(c.feeds[0].roleId, '999999999999999999');
});

test('normaliseRssConfig: back-compat — a feed with only `url` becomes type:url, ref:url', () => {
  const c = normaliseRssConfig({ feeds: [{ url: 'https://a.com/feed', channelId: CH }] });
  assert.equal(c.feeds[0].type, 'url');
  assert.equal(c.feeds[0].ref, 'https://a.com/feed');
  assert.equal(c.feeds[0].url, 'https://a.com/feed');
});

test('normaliseRssConfig: friendly types resolve ref -> url, bad refs drop', () => {
  const c = normaliseRssConfig({
    feeds: [
      { type: 'reddit', ref: 'r/programming', channelId: CH },
      { type: 'mastodon', ref: '@Gargron@mastodon.social', channelId: CH },
      { type: 'bluesky', ref: 'no dots here', channelId: CH }, // unresolvable -> dropped
    ],
  });
  assert.equal(c.feeds.length, 2);
  assert.equal(c.feeds[0].url, 'https://www.reddit.com/r/programming/new/.rss');
  assert.equal(c.feeds[1].url, 'https://mastodon.social/@Gargron.rss');
});

test('parseFeedRef: reddit forms', () => {
  const want = 'https://www.reddit.com/r/webdev/new/.rss';
  for (const ref of [
    'r/webdev',
    '/r/webdev',
    'webdev',
    'https://www.reddit.com/r/webdev/',
    'https://old.reddit.com/r/webdev/comments/x',
  ]) {
    assert.equal(parseFeedRef('reddit', ref).url, want, ref);
  }
  assert.equal(parseFeedRef('reddit', 'u/spez').url, 'https://www.reddit.com/user/spez/new/.rss');
  assert.equal(parseFeedRef('reddit', 'u/spez').label, 'u/spez');
  assert.equal(parseFeedRef('reddit', '').url, '');
});

test('parseFeedRef: mastodon forms', () => {
  const want = 'https://mastodon.social/@Gargron.rss';
  for (const ref of [
    '@Gargron@mastodon.social',
    'Gargron@mastodon.social',
    'https://mastodon.social/@Gargron',
  ]) {
    assert.equal(parseFeedRef('mastodon', ref).url, want, ref);
  }
  assert.equal(parseFeedRef('mastodon', '@Gargron@Mastodon.Social').label, '@Gargron@mastodon.social');
  assert.equal(parseFeedRef('mastodon', 'not-an-account').url, '');
});

test('parseFeedRef: bluesky forms', () => {
  const want = 'https://bsky.app/profile/jay.bsky.team/rss';
  for (const ref of ['jay.bsky.team', '@jay.bsky.team', 'https://bsky.app/profile/jay.bsky.team']) {
    assert.equal(parseFeedRef('bluesky', ref).url, want, ref);
  }
  assert.equal(
    parseFeedRef('bluesky', 'did:plc:abcdefghijklmnop').url,
    'https://bsky.app/profile/did:plc:abcdefghijklmnop/rss'
  );
  assert.equal(parseFeedRef('bluesky', 'nodot').url, ''); // handles need a dot
});

test('parseFeedRef: url passes valid through, rejects non-http', () => {
  assert.equal(parseFeedRef('url', 'https://x.com/feed').url, 'https://x.com/feed');
  assert.equal(parseFeedRef('url', 'ftp://x.com/feed').url, '');
});

test('sourceLabel: handle for friendly types, host for url', () => {
  assert.equal(
    sourceLabel({
      type: 'reddit',
      ref: 'r/programming',
      url: 'https://www.reddit.com/r/programming/new/.rss',
    }),
    'r/programming'
  );
  assert.equal(sourceLabel({ type: 'bluesky', ref: '@jay.bsky.team', url: 'x' }), '@jay.bsky.team');
  assert.equal(sourceLabel({ type: 'url', url: 'https://blog.example.com/feed' }), 'blog.example.com');
});

test('normaliseRssConfig: caps at 15 feeds', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ url: `https://x${i}.com/feed`, channelId: CH }));
  assert.equal(normaliseRssConfig({ feeds: many }).feeds.length, 15);
});

test('feedSource: host without www, junk falls back', () => {
  assert.equal(feedSource('https://www.example.com/path/feed.xml'), 'example.com');
  assert.equal(feedSource('https://blog.example.co.uk/atom'), 'blog.example.co.uk');
  assert.equal(feedSource('not a url'), 'feed');
});

test('fillTemplate: placeholders + default', () => {
  assert.equal(
    fillTemplate('{title} @ {feed} — {link} ({author})', {
      title: 'Post',
      link: 'https://x/1',
      author: 'Al',
      feed: 'x.com',
    }),
    'Post @ x.com — https://x/1 (Al)'
  );
  assert.match(fillTemplate('', { title: 'T', link: 'L' }), /\*\*T\*\*\nL/);
});

test('buildPayload: embed + role ping; relative link is not used as a URL', () => {
  const feed = { url: 'https://blog.example.com/feed', roleId: CH, template: '' };
  const p = buildPayload(feed, {
    title: 'Hello',
    link: 'https://blog.example.com/hello',
    author: 'Dev',
    published: Date.parse('2024-01-01T00:00:00Z'),
    image: 'https://blog.example.com/img.png',
  });
  assert.match(p.content, /^<@&123456789012345678> /);
  assert.equal(p.embeds[0].data.url, 'https://blog.example.com/hello');
  assert.equal(p.embeds[0].data.footer.text, 'blog.example.com');
  assert.match(p.embeds[0].data.description, /by Dev/);
  assert.deepEqual(p.allowedMentions, { roles: [CH] });

  const rel = buildPayload(
    { url: 'https://x.com/feed', template: '{link}' },
    { title: 'T', link: '/relative' }
  );
  assert.equal(rel.embeds[0].data.url, undefined); // relative link not passed to setURL
  assert.equal(rel.content, undefined); // {link} -> '' -> trimmed empty -> undefined
});
