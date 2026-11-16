# Bridge (beta)

Share one conversation between a channel on **Discord** and a channel on **Fluxer**. Members on both
sides write as they always do; Sylo shows each message on the other side with the author's name and
picture, and carries replies, files, edits and deletes along.

This is Sylo's own implementation. A bridge needs a Sylo that is connected to both platforms (the hosted
Sylo is) and that is a member of both servers.

**Dashboard:** `/v2/guilds/<id>/m/bridge` - the linked channels, a form to ask for a link, a form to use a
code, what this server shares, and pause, resume and unlink.

## Linking: both servers agree

A link is never made from one side alone.

1. In the first server, someone with **Edit** access opens the Bridge page, picks a channel and presses
   **Get a code**. The code (`XXXX-XXXX-XXXX`) works once and for **15 minutes**. Sylo stores only a hash of
   it, so it is shown this one time.
2. They give the code to someone with **Edit** access in the other server. That person opens the Bridge
   page there, pastes the code, picks the channel that should join it and presses **Link the channels**.
3. Sylo makes a webhook in each channel and posts a notice in both: "Bridge on. Messages in this channel are
   shared with #chat in Fluxer Home on Fluxer ...".

A link joins a Discord channel to a Fluxer channel, never two on the same platform. A channel is in one link
at a time, and a server has at most 10 links and 5 waiting requests. The Bridge module must be on in both
servers. Wrong codes are rate limited, and a few wrong ones in a row lock the attempts for a while.

**Either side can unlink at any time** (Edit access). Both webhooks are deleted, the message map goes, and
both channels are told. If Sylo is removed from a server, the server on the other end loses its webhook and
is told too.

**Pause** stops the bridge from either side. Only the server that paused it can resume it. A link that Sylo
stopped itself (see below) can be resumed by either server once the cause is fixed.

## What crosses

| | |
|---|---|
| Messages | Posted by a webhook in the other channel under the author's display name and picture, with the platform in the name ("Alice [Discord]"). |
| Replies | A reply starts with a short quote of the message it answers, with a link to it on the other side when Sylo knows the copy. |
| Files | Re-uploaded up to **8 MB** each and 8 MB per message (at most 10 files). Larger files, files that cannot be fetched, and every file when a server turns uploads off, cross as a link. |
| Emoji | Unicode emoji as they are. A custom emoji crosses as the custom emoji **with the same name** in the other server, otherwise as `:name:`. |
| Stickers | As a picture link. |
| Embeds | Rich embeds (from bots) with their text made harmless. A link preview is left out: the other platform makes its own. |
| Polls | As text: the question and the answers. Fluxer has no polls and a vote cannot count on both sides, so the vote stays where the poll is. |
| Edits and deletes | Mirrored through a message map that keeps a message for **30 days** (the daily retention job removes older rows). An edit or delete of an older message is not followed. Deleting a copy does not delete the original. |
| Joins | Optional, per server: a line "👋 Zed joined Discord Home" on the other side. Needs the Server Members intent on Discord. |

## Safety rules

- **No ping crosses.** Every copy is sent with allowed mentions set to none, and the text itself is changed:
  `@everyone` and `@here` get an invisible character that breaks them, and users, roles and channels become
  plain names ("@Bobby", "@moderators", "#rules").
- **No loops or echoes.** A message posted by any Sylo bridge webhook, or by Sylo itself, is never relayed.
  A channel is in only one link, so a copy cannot find its way back.
- **Bots are off by default.** Each server decides for itself what it sends: **bot messages**, **who
  joins** and **copy files** are options of that server's side only, and the other server cannot change them.
  System messages (joins, pins, boosts) are never relayed.
- **Age restriction.** An age-restricted channel can only be linked to an age-restricted channel. It is
  checked when linking, when resuming, and on **every message**: if one of the channels changes, the link
  stops.
- **Visible notice.** Both channels get a notice while a bridge is on, and when it is paused, stopped or
  ended.
- **Rate limits.** Each webhook has its own queue: sends are spaced out, a rate limit from the platform is
  waited out, a short outage is retried with growing pauses, and a message that waited more than five
  minutes is dropped. A queue holds at most 100 messages; a flooded channel drops the newest and counts it.
  One server's queue never slows another's.
- **A failing link stops.** No permission, a webhook Sylo cannot make again, a deleted channel, or five
  failed deliveries in a row stop the link. Sylo says so in both channels, the **Health** page shows it as a
  problem with the reason, and it is not retried until someone presses **Resume**.
- **Webhooks are Sylo's.** Sylo makes and manages the webhook of each channel and makes a new one if it is
  deleted. Its token is stored in the database and never sent to the browser. A database backup therefore
  holds it, like every other secret; encrypt off-site backups.

## Needs

- **Manage Webhooks**, View Channel and Send Messages in each bridged channel (the Health page checks them).
- The **Message Content** intent (`INTENT_MESSAGE_CONTENT`, on by default).
- Edit access to the dashboard in the server that makes the request and in the server that uses the code.

## API

The Sylo app can read and change a bridge through `/api/v2` (`bridge` in the app's feature list). A GET at
View level, everything else at Edit level. See [mobile-app.md](../mobile-app.md).
