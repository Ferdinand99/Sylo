# Server insights

Charts of server activity over time — messages, joins and leaves per day, and the
busiest channels.

**Dashboard:** `/guilds/<id>/insights` (also linked from the sidebar and the
overview grid).

## Needs

- No privileged intents. Message **counting** uses the `MessageCreate` gateway
  event only — the Message Content intent is not required, since only the count,
  author id and channel id are read, never the text.
- **View Channel** on a channel for its name to show in "Top channels"
  (otherwise the id is shown).

## What it stores

One aggregate row per server per UTC day in `guild_daily`:

- `messages`, `joins`, `leaves`
- `active_members` — distinct message authors that day (a running max)
- `channels` — a JSON map of channel id → message count for that day

**No message content and no per-user rows** are stored. Rows older than ~180 days
are pruned. Guild-leave and `/forget` remove a server's rows via `GUILD_TABLES`.

## Notes

- Off by default — enabling it is what starts the counting, so charts only fill
  in from that point forward.
- Counters are held in memory and flushed hourly (and when the UTC day rolls
  over). A restart loses at most the last hour.
- The page has a 7 / 30 / 90-day range switch.
