# Giveaways

Run prize giveaways with an **Enter** button. Winners are drawn automatically at
the end time.

**Dashboard:** `/guilds/<id>/m/giveaways`.

## Needs

- **Send Messages**, **Embed Links**.
- No privileged intents.

## Settings

- **Ping** — `none` / `@here` / `@everyone` when a giveaway is drawn.
- **DM winners** — also DM each winner.

## Commands

| Command | |
|---|---|
| `/giveaway start` | Prize, number of winners, duration, optional required role. |
| `/giveaway end` | Draw now. |
| `/giveaway reroll` | Pick new winner(s), excluding previous ones. |
| `/giveaway list` | Active giveaways in the server. |

## Notes

- A background tick ends due giveaways. Only entrants still in the server (and
  still holding the required role) are eligible.
- `end` and `reroll` are also available on the dashboard.
- `/forget` removes a member's giveaway entries; a completed giveaway's winner
  list is a server record and is only cleared when Sylo leaves the server.
