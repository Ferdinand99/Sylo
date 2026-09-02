# RSS alerts

Post a message when a followed **RSS 2.0** or **Atom** feed publishes a new item.

**Dashboard:** `/guilds/<id>/m/rss`.

## Needs

- **Send Messages**, **Embed Links** in the target channels.
- No privileged intents. No API key — Sylo fetches the feed URL directly.

## Settings

- **Feeds** — a list of `{ feed URL, channel, optional ping role, message
  template }`. Up to 15 per server.
- Template placeholders: `{title}` `{link}` `{author}` `{feed}` (`{feed}` is the
  feed's host, e.g. `example.com`). Blank uses `📰 **{title}**\n{link}`.

## Notes

- Polled every ~5 minutes. The **first** check for a feed only records the
  current items — nothing is posted — so adding a feed never dumps its backlog.
  After that, new items are posted oldest-first, capped at 3 per feed per check
  (a larger burst is still marked seen, just not all posted).
- Dedupe state lives in the shared `posted_keys` table (scope `rss:<feedId>`),
  keyed by each item's `guid` / `id` / `link`. Removing a feed clears its state.
- Works with blogs, news sites, Reddit (`https://www.reddit.com/r/<sub>/.rss`),
  Mastodon (`https://<instance>/@<user>.rss`), GitHub releases
  (`https://github.com/<owner>/<repo>/releases.atom`), status pages, etc.
- Twitter/X and TikTok have no usable public feed and are not supported.
