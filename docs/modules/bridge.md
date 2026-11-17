# Bridge (beta)

Share one conversation between a channel on **Discord** and a channel on **Fluxer**. Members on both
sides write as they always do; Sylo shows each message on the other side with the author's name and
picture, and carries replies, files, edits and deletes along.

This is Sylo's own implementation. A bridge needs a Sylo that is connected to both platforms (the hosted
Sylo is) and that is a member of both servers.

**Dashboard:** `/v2/guilds/<id>/m/bridge` - the linked channels, a form to ask for a link, a form to use a
code, what this server shares, and pause, resume and unlink.

**Setting up a whole Fluxer server?** Linking channels one by one is for single conversations. To copy a
Discord server's channels, roles and emoji to a Fluxer server and bridge every channel at once, use
[Mirror to Fluxer](../mirror.md). The Bridge page of a Discord server points to it with a short note and a
link; the note is shown only to the server's owner and only when Sylo is connected to both platforms. It is not
shown on a Fluxer server: the mirror's target is chosen from the Discord side.

## Who can use it: the server owner

**Only the owner of a server can use the bridge** (the Discord server owner, the Fluxer server owner), on
both sides. Administrators, people with **Edit** access to the dashboard and the bot-master roles cannot ask
for a link, use a code, change what a server shares, or pause, resume or unlink a bridge. People with **View**
access see the status of the links on the page, read-only. Ownership is checked again on every action, from
the owner the platform reports for the server.

Sylo records who owns each server when the link is made. **If the owner of either server changes, the link
pauses** (on both sides, with a notice and an audit entry) **until the new owner confirms it**: the new
owner opens the Bridge page and presses **Resume**. If both servers changed owner, both owners have to confirm.
A code that was made by a previous owner is refused. Messages check this as they come, and a check every five
minutes covers a quiet link.

## Linking: both servers agree

A link is never made from one side alone.

1. In the first server, the owner opens the Bridge page, picks a channel and presses
   **Get a code**. The code (`XXXX-XXXX-XXXX`) works once and for **15 minutes**. Sylo stores only a hash of
   it, so it is shown this one time.
2. They give the code to the owner of the other server. That owner opens the Bridge
   page there, pastes the code, picks the channel that should join it and presses **Link the channels**.
3. Sylo makes a webhook in each channel and posts a notice in both: "Bridge on. Messages in this channel are
   shared with #chat in Fluxer Home on Fluxer ...".

A link joins a Discord channel to a Fluxer channel, never two on the same platform. A channel is in one link
at a time, and a server has at most 10 links and 5 waiting requests. The Bridge module must be on in both
servers. Wrong codes are rate limited, and a few wrong ones in a row lock the attempts for a while.

**Either side can unlink at any time** (the owner). Both webhooks are deleted, the message map goes, and
both channels are told. If Sylo is removed from a server, the server on the other end loses its webhook and
is told too.

**Links made by the server mirror.** A [server mirror](../mirror.md) links its copied text channels through the
bridge without codes, because both owners already agreed to the mirror. Those links show "Name (server mirror)"
as who made them, follow the mirror (paused with it, running again with it; the Bridge page cannot resume one on
its own while the mirror is paused) and follow every rule on this page. A server can have 50 of them (10 when you
link by hand). Unlink works for them as for any other link, and an unlinked channel is not linked again. If the
mirror is removed, its links stay, paused by the server that removed it: only that server's owner can resume
them, and either owner can unlink them. The mirror switches this module on only the first time it links, and a
server that switches it off keeps it off.

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
- **Webhook messages never cross**, whatever the options say: they are what bridges post (this one and any other
  bridge on the same channels), and relaying them would make two bridges feed each other forever. Bot accounts
  whose name already carries a platform tag are skipped too.
- **Bots are off by default.** Each server decides for itself what it sends: **bot messages** (bot accounts), **who
  joins** and **copy files** are options of that server's side only, and the other server cannot change them.
  System messages (joins, pins, boosts) are never relayed.
- **Age restriction.** An age-restricted channel can only be linked to an age-restricted channel. On Fluxer a
  channel counts as age-restricted when its own setting, its category's or the server's says so (what Sylo cannot
  read counts as restricted); a Discord server marked age-restricted counts for all its channels. It is checked
  when linking, when resuming, and on **every message**: if one of the channels changes, the link stops.
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
  deleted. Its token is stored sealed (AES-256-GCM, keyed from the session secret) and never sent to the
  browser. If the session secret changes, the tokens cannot be read and Sylo makes new webhooks (also when it
  only wanted to edit a copy). A plain-text token from a development database is sealed the first time its link
  is read; accepting plain text at all is removed in a later version.
- **You can only bridge what you can see.** The person who asks for a link, and the one who uses a code, must
  be able to view, read and send in their channel themselves (an owner normally can).
- **Deletes always follow.** A copy is removed even if the link is paused or stopped, when the delete comes
  before the copy was posted, after a webhook was replaced (Sylo then deletes it as the bot, which needs Manage
  Messages), and for a purge of many messages. After an unlink the message map is gone, so copies already
  posted stay and a later delete of the original no longer reaches them.
- **File downloads share one budget** (4 files held at a time and 32 MB for the whole Sylo): a file is held from
  its download until its copy is sent, and a file that does not fit crosses as a link.
- **A delete that hits a temporary error is tried again** (with growing pauses), and the message map entry stays
  until the copy is really gone.

## Needs

- **Manage Webhooks**, View Channel and Send Messages in each bridged channel (the Health page checks them).
- The **Message Content** intent (`INTENT_MESSAGE_CONTENT`, on by default).
- Being the owner of the server that makes the request and of the server that uses the code.

## API

The Sylo app can read and change a bridge through `/api/v2` (`bridge` in the app's feature list). A GET at
View level, everything else for the server owner only (Edit access is not enough). See [mobile-app.md](../mobile-app.md).
