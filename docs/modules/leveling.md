# Leveling

XP and levels from chat activity, with role rewards, per-channel/role
multipliers, no-XP lists, and a public leaderboard.

**Dashboard:** `/guilds/<id>/m/leveling`.

## Needs

- **Manage Roles** (above the reward roles) for level rewards.
- **Attach Files** for the `/rank` and `/leaderboard` image cards.
- **Server Members** intent (`INTENT_GUILD_MEMBERS`).

## Settings

- **XP cooldown** — seconds between XP-earning messages (anti-spam).
- **Announce** — `channel` / `reply` / `dm` / `off`, with a channel and a
  template for level-up messages.
- **No-XP channels / roles** — excluded from earning.
- **Rewards** — `{ level, role }` pairs; **stack rewards** keeps lower reward
  roles or swaps to only the highest.

## Commands

| Command | |
|---|---|
| `/rank [member]` | Your (or another member's) level, rank and progress, as a card. |
| `/leaderboard` | Top members by XP, as a card, with a link to the web leaderboard. |

## Notes

- The public leaderboard is at `<DASHBOARD_URL>/leaderboard/<guildId>`; a vanity
  slug (`/lb/<slug>`) can be set on the Leaderboard page.
- Member XP can be set or reset per server from the Leaderboard page.
- `/forget` removes a member's leveling record.
