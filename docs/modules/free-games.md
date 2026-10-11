# Free games

Announces games that become free to claim on **Epic Games Store** and **Steam**,
in a channel of your choice. Both work without API keys. Steam offers come from
[GamerPower](https://www.gamerpower.com/api-read), not by scraping SteamDB.
An optional IsThereAnyDeal API key adds other stores and on-demand DLC.

**Dashboard:** `/guilds/<id>/m/free-games`.

## Needs

- **Send Messages**, **Embed Links**.
- No privileged intents.
- Optional: `ITAD_API_KEY` (IsThereAnyDeal) adds other stores and on-demand DLC.

## Settings

- **Channel** — where announcements go.
- **Ping role** — optional role to mention.

## Commands

| Command | |
|---|---|
| `/freegames` | Show what's currently free (works without the module on). |

## Notes

- Sylo polls periodically and posts each free offer once.

- Steam announcements cover permanent claims, excluding free weekends, demos,
  beta access and third-party key giveaways with additional tasks.
- GamerPower is an independent curated source, so coverage and update times may
  differ from SteamDB. Announcements link to the offer and credit GamerPower.
- An unavailable source does not block the remaining sources.
- Steam and Epic offers for the same title are announced separately.
- Steam deadlines are shown as dates supplied by GamerPower; no exact timezone
  is assumed. Always check the linked offer for regional availability and terms.
