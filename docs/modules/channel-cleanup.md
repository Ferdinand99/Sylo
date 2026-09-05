# Channel cleanup

Auto-delete old messages from a channel, on a weekly schedule you pick. Deletes
only messages older than a configured age — not a full wipe.

**Dashboard:** `/guilds/<id>/m/channel-cleanup`.

## Needs

- **View Channel**, **Manage Messages**, **Read Message History** in the target
  channel.
- No privileged intents.

## Settings (per schedule)

- **Channel** to clean up.
- **Days** — which weekdays the cleanup runs on (any combination, Sun–Sat).
- **Time** — the time of day it runs, in the host's timezone (`TZ` env var; the
  Docker image defaults to `Europe/Oslo`).
- **Max age** — delete messages older than this many hours (1 hour – 90 days).
- **Skip pinned messages** — on by default.
- Enable/disable a schedule without deleting it.

## How it works

- A background tick checks every 5 minutes for schedules due to run, and fires
  each at most once per day.
- Deletion paginates back through the channel (up to 1,000 messages per run),
  bulk-deleting whatever Discord allows (messages under 14 days old) and
  individually deleting a capped number of older messages so one run can't
  turn into a long rate-limited loop against a large backlog — any remainder
  is picked up on the next scheduled run.
- If Sylo is missing a required permission in the channel, the run is skipped
  and logged rather than erroring.
