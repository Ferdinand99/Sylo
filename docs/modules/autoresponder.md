# Autoresponder

Automatically reply when a message matches a trigger phrase.

**Dashboard:** `/guilds/<id>/m/autoresponder`.

## Needs

- **Message Content** intent (`INTENT_MESSAGE_CONTENT`).
- **Send Messages** (and **Embed Links** for embed replies).

## Settings

- **Rules** — each has a trigger (exact / contains / startswith / wholeword), a reply
  (text, embed or random media), optionally delete the trigger message.
  Media pools support up to 25 image and MP4/WebM URLs, mixed in one list.
- **Cooldown** — per-channel seconds between triggered replies (anti-spam).
- **Ignore channels** — never respond in these.

## Notes

- Sylo never responds to other bots.
- For user-invocable commands rather than passive triggers, use [Custom
  commands](custom-commands.md).

## Video replies

Select the random image/video response and enter direct media URLs, one per
line. Optional captions keep the existing placeholders. Existing random-image
rules remain compatible and also recognize videos by URL pathname, including
signed MP4 URLs with query parameters.

Videos from packaged-media.redd.it, v.redd.it and Discord's media CDNs are
uploaded as attachments up to 8 MiB; the bot needs Attach Files. Downloads have
a 10-second timeout, a streaming size limit, no redirects and at most two
concurrent transfers. Other hosts, failed/oversized downloads, missing upload
permission and failed Discord uploads fall back to the original URL.
No arbitrary configured URL is downloaded from the hosting network.

Signed Reddit/Discord media links can expire; use a stable direct URL for a
long-lived response. Reddit DASH streams may contain video without audio;
the bot does not merge separate tracks or transcode files.
