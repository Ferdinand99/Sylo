# Kick alerts

Announce in a channel when a [Kick.com](https://kick.com) streamer goes live.

**Dashboard:** `/guilds/<id>/m/kick-alerts`.

## Needs

- **Send Messages**, **Embed Links** in the alert channels.
- No privileged intents.
- `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` — a free app under
  [kick.com/settings/developer](https://kick.com/settings/developer). Sylo uses
  the OAuth2 client-credentials flow (an app access token, no user login). When
  either is unset the poll loop no-ops and the dashboard shows a note.

## Settings

- **Alerts** — a list of `{ Kick username, channel, optional ping role,
  message }`. Up to 50.
- Message placeholders: `{name}` `{title}` `{game}` `{url}` `{viewers}`.

## Notes

- Sylo polls the Kick API about once a minute and de-duplicates on the stream
  start time, so one "went live" event posts once per broadcast — a new stream by
  the same channel fires again.
- Dedupe state lives in the shared `posted_keys` table (scope `kick`).
