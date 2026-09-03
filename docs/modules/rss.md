# RSS alerts

Post a message when a followed feed publishes a new item. Handles a raw
**RSS 2.0** or **Atom** URL, and also resolves a **Reddit**, **Mastodon** or
**Bluesky** handle to that platform's own feed.

**Dashboard:** `/guilds/<id>/m/rss`.

## Needs

- **Send Messages**, **Embed Links** in the target channels.
- No privileged intents. No API key — Sylo fetches the feed URL directly.

## Settings

- **Feeds** — a list of `{ source, channel, optional ping role, message
  template }`. Up to 15 per server. Each source is one of:
  - **RSS / Atom URL** — a feed URL as-is
    (`https://github.com/<owner>/<repo>/releases.atom`, a blog's `/feed.xml`, …).
  - **Reddit** — `r/<sub>`, `u/<user>`, a bare subreddit name, or any
    `reddit.com/…` link → `https://www.reddit.com/r/<sub>/new/.rss`.
  - **Mastodon** — `@user@instance`, `user@instance`, or a profile URL →
    `https://<instance>/@<user>.rss`.
  - **Bluesky** — `name.bsky.social`, `@handle`, a `did:…`, or a
    `bsky.app/profile/…` link → `https://bsky.app/profile/<handle>/rss`.
- Template placeholders: `{title}` `{link}` `{author}` `{feed}`. `{feed}` is the
  short source label — the handle for Reddit/Mastodon/Bluesky (e.g.
  `r/programming`, `@user@instance`), otherwise the feed's host. Blank uses
  `📰 **{title}**\n{link}`.

## Notes

- Polled every ~5 minutes. The **first** check for a feed only records the
  current items — nothing is posted — so adding a feed never dumps its backlog.
  After that, new items are posted oldest-first, capped at 3 per feed per check
  (a larger burst is still marked seen, just not all posted).
- Dedupe state lives in the shared `posted_keys` table (scope `rss:<feedId>`),
  keyed by each item's `guid` / `id` / `link`. Removing a feed clears its state.
- Reddit rate-limits unauthenticated requests aggressively; an occasional check
  may be skipped and retried on the next tick.
- Twitter/X and TikTok have no usable public feed and are not supported.
