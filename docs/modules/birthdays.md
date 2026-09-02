# Birthdays

Members save their birthday with `/birthday`; once a day Sylo posts a greeting in
a configured channel and can grant a **birthday role** for the day.

**Dashboard:** `/guilds/<id>/m/birthdays`.

## Needs

- **Send Messages**, **Embed Links** in the announcement channel.
- **Manage Roles** (with Sylo's role above the birthday role) if you use the role.
- No privileged intents.

## Settings

- **Announcement channel** — leave empty for role-only, no message.
- **Message** — placeholders `{user}` and `{age}` (`{age}` is blank unless a year
  was saved).
- **Birthday role** — granted on the day, removed the day after.
- **Ping the birthday role** in the announcement — on/off.

## Commands

| Command | |
|---|---|
| `/birthday set day:<1-31> month:<name> [year:<yyyy>]` | Save your birthday (Feb 29 allowed). |
| `/birthday remove` | Delete your saved birthday. |
| `/birthday list` | The next birthdays coming up in the server. |

## Notes

- The sweep runs once per calendar day (checked hourly and ~15 s after start),
  guarded so a mid-day restart doesn't re-post.
- Feb 29 birthdays are celebrated on Feb 28 in non-leap years.
- A saved birthday is per-server and is removed by `/forget`.
