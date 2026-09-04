# Tickets (modmail)

Members open a ticket by **DMing the bot**. Staff read the conversation and reply
from the dashboard — replies are delivered to the member as a DM from Sylo.

**Dashboard:** `/guilds/<id>/tickets` (list) and `/guilds/<id>/tickets/<n>`
(conversation).

## Needs

- No extra Discord permissions and no privileged intents — just leave the bot
  able to receive DMs (Discord *Settings → Privacy* on the shared server).

## Settings

- **Enabled** — the module toggle is the on/off switch.
- **Staff roles** — who may view and reply to tickets on the dashboard (in
  addition to Manage Server / bot-master).
- **Open / close messages** — the DM text sent when a ticket opens and closes.
- **Log channel** — optional transcript summary when a ticket closes.
- **Delete closed tickets after** — days. A daily job removes closed tickets and
  every message in them once they are older than this. `0` (the default) keeps
  them forever; open tickets are never affected.

## How it works

A member's DM to the bot opens (or appends to) their one open ticket for that
server. Staff reply as **Staff** from the ticket page; the member sees Sylo's DM.
**Close ticket** sends a final reply (or the default closing notice if the box is
empty) and closes it. The member can open a new one by DMing again.

`/forget` removes the member's ticket history and the messages they sent; staff
replies already delivered are not clawed back.
