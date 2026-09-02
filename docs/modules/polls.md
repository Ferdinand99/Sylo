# Polls

Members create reaction polls with `/poll`. Polls close automatically on a timer
or a vote cap, and Sylo posts the results.

**Dashboard:** `/guilds/<id>/m/polls`.

## Needs

- **Send Messages**, **Embed Links**, **Add Reactions**, **Manage Messages** (to
  clear reactions on close).
- No privileged intents.

## Settings

- **Vote roles** — allow/deny list controlling who may vote.
- **Poll message** / **results message** — customise the embed (title, colour,
  footer, image) for the open poll and the results.

## Commands

| Command | |
|---|---|
| `/poll` | Create a poll: question, 2–N options, duration and/or vote cap. |
| `/poll-end` | Close a poll now and post results. |

## Notes

- Ineligible members' reactions are removed as they're added.
