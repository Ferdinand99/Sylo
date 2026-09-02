# Temporary voice channels

Join-to-create voice hubs: a member joins a **hub** channel and Sylo spawns a
personal voice channel (and optional text channel) they own and control with
`/voice-*` commands. Empty channels are cleaned up.

**Dashboard:** `/guilds/<id>/m/temp-voice`.

## Needs

- **Manage Channels**, **Move Members**, and **Manage Roles** if you use
  role-based access.
- No privileged intents.

## Settings (per hub)

- **Hub channel** + **category** for the spawned channels.
- **Name template** (`{index}`, `{username}`), **user limit**, **bitrate**.
- **Keep-alive minutes**, **ownership lock**, sync name/permissions from the
  category, and an allow/deny **role list** for who can join.

## Commands

Owner (or a voice moderator) controls: `/voice-rename`, `/voice-limit`,
`/voice-lock` / `/voice-unlock`, `/voice-hide` / `/voice-reveal`, `/voice-kick`,
`/voice-ban` / `/voice-unban`, `/voice-transfer`, `/voice-claim` (if the owner
left), `/voice-owner`. `/voice-clean` deletes all empty temp channels.

## Notes

- Up to 25 hubs per server.
