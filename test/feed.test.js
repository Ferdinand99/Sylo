import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, decodeEntities } from '../src/bot/lib/feed.js';

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Example Blog</title>
    <item>
      <title>Older post</title>
      <link>https://example.com/older</link>
      <guid isPermaLink="false">tag:example.com,2024:1</guid>
      <pubDate>Mon, 01 Jan 2024 09:00:00 +0000</pubDate>
      <dc:creator>Alice</dc:creator>
    </item>
    <item>
      <title><![CDATA[New &amp; shiny — caf&#233;]]></title>
      <link>https://example.com/new</link>
      <guid>https://example.com/new</guid>
      <pubDate>Wed, 05 Jun 2024 12:00:00 +0000</pubDate>
      <media:thumbnail url="https://example.com/thumb.png" />
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Feed</title>
  <author><name>Feed Author</name></author>
  <entry>
    <title>Atom entry</title>
    <id>urn:uuid:1234</id>
    <link rel="self" href="https://example.com/self"/>
    <link rel="alternate" href="https://example.com/post"/>
    <updated>2024-03-03T00:00:00Z</updated>
  </entry>
  <entry>
    <title>No id, no explicit link</title>
    <published>2024-02-02T00:00:00Z</published>
  </entry>
</feed>`;

test('parseFeed: RSS 2.0 items, newest first, CDATA + entities decoded', () => {
  const out = parseFeed(RSS);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'New & shiny — café');
  assert.equal(out[0].key, 'https://example.com/new');
  assert.equal(out[0].link, 'https://example.com/new');
  assert.equal(out[0].image, 'https://example.com/thumb.png');
  assert.ok(out[0].published > out[1].published, 'sorted newest-first');

  assert.equal(out[1].title, 'Older post');
  assert.equal(out[1].key, 'tag:example.com,2024:1'); // guid preferred over link
  assert.equal(out[1].author, 'Alice');
  assert.equal(out[1].image, null);
});

test('parseFeed: Atom entries — alternate link wins, feed author falls through', () => {
  const out = parseFeed(ATOM);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'Atom entry');
  assert.equal(out[0].key, 'urn:uuid:1234');
  assert.equal(out[0].link, 'https://example.com/post'); // not the rel="self" one
  assert.equal(out[1].author, 'Feed Author'); // inherited from <feed><author>
  assert.equal(out[1].key, 'No id, no explicit link'); // falls back to title
});

test('parseFeed: empty / junk input yields no entries', () => {
  assert.deepEqual(parseFeed(''), []);
  assert.deepEqual(parseFeed('<html><body>not a feed</body></html>'), []);
});

test('decodeEntities: named, numeric and hex references', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;'), `a & b <c> "d" 'e'`);
  assert.equal(decodeEntities('caf&#233; &#x2014; done'), 'café — done');
  assert.equal(decodeEntities('&amp;lt;'), '&lt;'); // single pass, no over-decode
});
