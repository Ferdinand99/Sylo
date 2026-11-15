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

// A feed with a huge number of tiny items would mean one database lookup per item every poll.
test('parseFeed keeps at most 100 entries', () => {
  const items = Array.from({ length: 500 }, (_, i) => `<item><title>t${i}</title><guid>g${i}</guid></item>`);
  const entries = parseFeed(`<rss><channel><title>x</title>${items.join('')}</channel></rss>`);
  assert.equal(entries.length, 100);
});

// A hostile feed body must cost time linear in its size. These are the shapes that made the old
// regexes backtrack cubically (16 KB took seconds); the bodies below are far larger and must still
// parse in well under a second, and the real fields must still be found.
function timed(fn) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  return { out, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

test('parseFeed: crafted Atom feed-author shape parses in linear time', () => {
  const xml = '<feed <author>'.repeat(40_000); // 600 KB, no <name>
  const { ms } = timed(() => parseFeed(xml));
  assert.ok(ms < 1500, `took ${ms} ms`);
});

test('parseFeed: crafted enclosure / media:content shapes parse in linear time', () => {
  const rss = `<rss><channel><item>${'<enclosure url="x" '.repeat(15_000)}</item></channel></rss>`;
  const media = `<rss><channel><item>${'<media:content url="x" '.repeat(15_000)}</item></channel></rss>`;
  for (const xml of [rss, media]) {
    const { out, ms } = timed(() => parseFeed(xml));
    assert.ok(ms < 1500, `took ${ms} ms`);
    assert.equal(out[0].image, null);
  }
});

test('parseFeed: crafted unterminated <link> and <channel> shapes parse in linear time', () => {
  const link = `<feed><entry>${'<link '.repeat(60_000)}`;
  const chan = `<rss>${'<channel>'.repeat(30_000)}`;
  const title = `<rss><channel><item>${'<title '.repeat(40_000)}`;
  for (const xml of [link, chan, title]) {
    const { ms } = timed(() => parseFeed(xml));
    assert.ok(ms < 1500, `took ${ms} ms`);
  }
});

test('parseFeed: hostile prefix does not hide the real fields', () => {
  const xml =
    '<feed <author>'.repeat(500) +
    '<feed xmlns="http://www.w3.org/2005/Atom"><author><name>Real Author</name></author>' +
    '<entry><link rel="self" href="https://e.com/self"/><link rel="alternate" href="https://e.com/a"/>' +
    '<title>T</title><media:thumbnail url="https://e.com/t.png"/></entry></feed>';
  const [e] = parseFeed(xml);
  assert.equal(e.title, 'T');
  assert.equal(e.link, 'https://e.com/a');
  assert.equal(e.author, 'Real Author');
  assert.equal(e.image, 'https://e.com/t.png');
});

test('parseFeed: enclosure and media:content images need an image type', () => {
  const xml = `<rss><channel><item><title>x</title>
    <media:content url="https://e.com/v.mp4" type="video/mp4"/>
    <enclosure url="https://e.com/p.jpg" length="1" type="image/jpeg"/></item></channel></rss>`;
  assert.equal(parseFeed(xml)[0].image, 'https://e.com/p.jpg');
  const audio = `<rss><channel><item><enclosure url="https://e.com/a.mp3" type="audio/mpeg"/></item></channel></rss>`;
  assert.equal(parseFeed(audio)[0].image, null);
});
