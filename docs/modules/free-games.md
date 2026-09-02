# Free games

Announces games (and DLC) that become free to claim on the **Epic Games Store**,
in a channel of your choice. With an optional API key it also covers other
stores.

**Dashboard:** `/guilds/<id>/m/free-games`.

## Needs

- **Send Messages**, **Embed Links**.
- No privileged intents.
- Optional: `ITAD_API_KEY` (IsThereAnyDeal) adds non-Epic stores.

## Settings

- **Channel** — where announcements go.
- **Ping role** — optional role to mention.

## Commands

| Command | |
|---|---|
| `/freegames` | Show what's currently free (works without the module on). |

## Notes

- Sylo polls periodically and posts each free offer once.
