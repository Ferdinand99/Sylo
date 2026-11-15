# Tickets

Members open a ticket by **DMing the bot**. Staff read the conversation and reply
from the dashboard — replies are delivered to the member as a DM from Sylo.

**Dashboard:** `/v2/guilds/<id>/tickets` (list) and `/v2/guilds/<id>/tickets/<n>`
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
- **Include the opening message in the staff notification** — off by default;
  when on, the "new ticket" ping in the notification channel also embeds the
  member's first message (truncated past 1000 characters), so staff can see
  what it's about before opening it.
- **Delete closed tickets after** — days. A daily job removes closed tickets and
  every message in them once they are older than this. `0` (the default) keeps
  them forever; open tickets are never affected.

## How it works

A member's DM to the bot opens (or appends to) their one open ticket for that
server. Staff reply as **Staff** from the ticket page; the member sees Sylo's DM.
**Close ticket** sends a final reply (or the default closing notice if the box is
empty) and closes it. The member can open a new one by DMing again.

To find the servers a member shares with the bot, Sylo uses its member cache first. A server
whose full member list is cached (Server Members intent on) answers without any request to
Discord. For the others it asks Discord for the one member, at most 8 servers per message, at most
120 requests a minute for the whole bot, and it remembers "not a member" for two minutes. Without
the Server Members intent a member is still found this way; if a message could not check every
server yet, the member is asked to send it again a few seconds later, which continues with the
servers not checked yet.

`/forget` removes the member's ticket history: every message in their tickets,
staff replies included. Replies already delivered by DM are not clawed back.
