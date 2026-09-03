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
- **XP rate** — a global ×0.25–×3 scale on all XP.
- **Announce** — `channel` / `reply` / `dm` / `off`, with a channel and a
  template for level-up messages.
- **Voice XP** — optional; a base XP-per-active-voice-minute (default 10),
  folded into the same level. "Only when active" requires 2+ non-bot members in
  the channel, not deafened, not the AFK channel.
- **XP multipliers** — up to 25 `{ role | channel, factor }` entries. The
  highest matching role factor is multiplied by the channel factor (each
  defaulting to 1×), capped at 10×. Applies to chat and voice XP, on top of the
  XP rate.
- **No-XP channels / roles** — excluded from earning.
- **Rewards** — `{ level, role }` pairs; **stack rewards** keeps lower reward
  roles or swaps to only the highest.

## Commands

| Command | |
|---|---|
| `/rank [member]` | Your (or another member's) level, rank and progress, as a card. Shows the chat / voice XP split when any voice XP has been earned. |
| `/leaderboard` | Top members by XP, as a card, with a link to the web leaderboard. |

## Notes

- The public leaderboard is at `<DASHBOARD_URL>/leaderboard/<guildId>`; a vanity
  slug (`/lb/<slug>`) can be set on the Leaderboard page. `?period=week` /
  `?period=month` switch to a calendar-week / calendar-month view (UTC); the
  dashboard Leaderboard page has the same toggle.
- Weekly / monthly XP is rolled up into `leveling_periods` (kept ~10 weeks /
  ~6 months, then pruned); the all-time totals in `leveling` are never reset by
  a period roll.
- Member XP can be set or reset per server from the Leaderboard page.
- `/forget` removes a member's leveling record (all-time and per-period).
