# Server insights

Charts of server activity over time — messages, joins, leaves and voice-channel
usage — per hour or per day, plus the busiest text and voice channels.

**Dashboard:** `/guilds/<id>/insights` (also linked from the sidebar and the
overview grid).

## Needs

- No privileged intents. Message **counting** uses the `MessageCreate` gateway
  event only — the Message Content intent is not required, since only the count,
  author id and channel id are read, never the text. Voice tracking uses
  `VoiceStateUpdate` (the `GuildVoiceStates` intent is always on).
- **View Channel** on a channel for its name to show in the "top channels" lists
  (otherwise the id is shown).

## What it stores

One aggregate row per server per UTC **day** in `guild_daily`, and a parallel row
per UTC **hour** in `guild_hourly` (kept ~3 days):

- `messages`, `joins`, `leaves`
- `active_members` — distinct message authors that period (a running max)
- `voice_minutes` — total member-minutes spent in voice
- `voice_active_members` — distinct members who were in voice (running max)
- `voice_peak` — most members in voice at once
- `channels` / `voice_channels` (daily only) — JSON maps of channel id → messages
  / minutes, for the "top channels" lists

**No message content and no per-user rows** are stored. Daily rows older than
~180 days and hourly rows older than ~3 days are pruned. Guild-leave and
`/forget` remove a server's rows via `GUILD_TABLES`.

## Notes

- Off by default — enabling it is what starts the counting, so charts only fill
  in from that point forward.
- Counters are held in memory and flushed to both tables **every ~10 minutes**,
  on the UTC day roll, and on demand via the page's **Refresh now** button. A
  restart loses at most the last few minutes; a voice call in progress loses only
  its unflushed tail. Peak-concurrent is read from the live voice-state cache, so
  it survives a restart.
- The page has a **24h / 48h / 7d / 30d / 90d** range switch — the shorter two
  read the hourly table.
