# Auto threads (beta)

Open a thread for every new post in the channels you choose, named from a template
(the poster, the date, the first words of the post). Good for question, feedback,
art and "looking for group" channels where each post is a conversation of its own.

**Discord only.** Fluxer has no threads yet, so on a Fluxer server the module does
nothing and posts stay as they are. The settings can still be saved there. See
[What works differently](../fluxer.md#what-works-differently).

**Dashboard:** `/v2/guilds/<id>/m/auto-threads`.

## Needs

- **Create Public Threads** and **Send Messages in Threads** in each channel. Without
  them Sylo skips the post and writes one warning line to its log, at most once per
  channel per hour (not one per post).
- **Message Content** intent: the "first words" of the post and the link filter read
  the text of the post.
- Text and announcement channels only. Forum channels are not listed: a forum already
  makes a thread for every post.
- No stored data: the module keeps only its settings.

## Settings

Up to **25 rules** per server, each for one channel. A channel may have several rules
(for example one for posts with pictures and one for the rest); the **first** rule
that fits a post is used.

- **Channel** - a text or announcement channel.
- **Thread name** - a template, up to 100 characters. Placeholders:
  - `{author}` - the poster's display name.
  - `{date}` - the day of the post as `YYYY-MM-DD` (UTC).
  - `{words}` - the first six words of the post, without mentions, custom
    emoji, link markup and markdown. When the post has no words (a picture alone) it is the
    poster's name instead.
  - Anything else stays as written. The finished name is cut at Discord's limit of
    100 characters. An empty template means `{words}`.
  - The dashboard shows a live preview from a sample post.
- **Archive after** - 1 hour, 24 hours, 3 days or 7 days without activity.
- **Only posts with an attachment** / **Only posts with a link** - with one on, posts
  without it are left alone. With both on, a post needs one of the two. A link is
  `http://` or `https://` in the text of the post.
- **Skip bots and webhooks** - on by default. Sylo's own posts (alerts, welcome
  messages, a sticky message) never open a thread, whatever this says.
- **Skip staff** - members with Administrator or Manage Server, plus the staff roles
  you pick on the rule.
- **First message** - optional, up to 2000 characters, posted in the new thread.
  `{author}` becomes a mention of the poster.
- **Slowmode** - 0 to 21600 seconds inside the thread, 0 = off.

## What gets skipped

System messages (joins, pins, boosts), posts inside threads, direct messages, posts
that already have a thread, Sylo's own posts, and anything the rule filters out.

## Rate safety

At most **one thread per channel every 2 seconds**. Further posts in that window get
no thread and no message; Sylo counts them in its debug log (`LOG_LEVEL=debug`).
This keeps a raid or a bulk import from flooding the channel and the API.

## Notes

- If the post is deleted before Sylo reacts (an automod filter, a mod), there is no
  thread and nothing is logged above debug level.
- Slowmode and the first message are extras: if Sylo cannot set them (for example it
  lacks Manage Threads), the thread is still created.
- The suggestions module can delete a post and replace it with its own embed; do not
  use both on the same channel.
