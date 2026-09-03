# Game stats

Player stat lookups via `/stats`. Pick a game from the `game` dropdown:

- **Battlefield** — BF1, BF3, BF4, BFV and Hardline are fully supported;
  BF2042 and BF6 are best-effort. Data from the
  [gametools.network](https://gametools.network) community API.
- **RuneScape** — Old School (OSRS) and RuneScape 3 (RS3), from Jagex's official
  Hiscores. `platform` optionally selects an Ironman account type
  (`ironman` / `hardcore` / `ultimate`, OSRS only).

**Dashboard:** `/guilds/<id>/m/game-stats` (just the on/off toggle — no settings).

## Needs

- **Send Messages**, **Embed Links**.
- No privileged intents.
- Battlefield data comes from `GAMETOOLS_API_BASE` (overridable); RuneScape data
  from `secure.runescape.com`. Responses are cached for
  `STATS_CACHE_TTL_MINUTES` (default 5).

## Commands

| Command | |
|---|---|
| `/stats game:… username:… [platform:…]` | Returns a stats embed. Battlefield needs `platform`; RuneScape uses it for the Ironman account type (default: normal). |

## Notes

- RuneScape combat level is computed from the combat skills — the Hiscores feed
  doesn't include it.
- This is the feature Sylo was originally built around; see
  [Adding another game](../../README.md#adding-another-game) to extend it — a new
  adapter file plus one `game` choice in `src/bot/commands/stats.js`.
