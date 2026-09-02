# Game stats

Battlefield-series player stat lookups via `/stats`. Full support for BF1, BF3,
BF4, BFV and Battlefield Hardline; best-effort for BF2042 and BF6.

**Dashboard:** `/guilds/<id>/m/game-stats` (just the on/off toggle — no settings).

## Needs

- **Send Messages**, **Embed Links**.
- No privileged intents.
- Data comes from the GameTools API (`GAMETOOLS_API_BASE`, overridable);
  responses are cached for `STATS_CACHE_TTL_MINUTES` (default 5).

## Commands

| Command | |
|---|---|
| `/stats battlefield` | `game`, `platform`, `player` — returns an embed of K/D, W/L, playtime, top classes/weapons/vehicles. |

## Notes

- This is the feature Sylo was originally built around; see
  [Adding another game](../../README.md#adding-another-game) to extend it.
