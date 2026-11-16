# Mirror to Fluxer

A server that lives on Discord can get a copy on Fluxer. Sylo reads the Discord server and builds the same
categories, channels, roles, emoji and stickers on a Fluxer server you made, then keeps the copy in step when you
change the Discord server. The copy goes one way: Discord is the source, Fluxer is the copy.

Like every Sylo feature it is free. It needs a Sylo that runs on both platforms (a Discord login and a Fluxer
login, see [Fluxer](fluxer.md)), and Sylo has to be a member of both servers. Find it in the dashboard under
**Mirror to Fluxer**, in the Server group of the sidebar. The page also works on the Fluxer server, where it is
used to agree to a mirror and to pause or stop it.

## What you need

1. A Fluxer server for the copy. Create an empty one: Sylo never deletes anything it did not make itself, so an
   empty server gives the cleanest result.
2. Sylo in that server, with a role that has the **Administrator** permission. (Sylo needs Manage Channels, Manage
   Roles, Manage Expressions and Manage Server at least; Administrator covers all of them.) Place Sylo's role as
   high as you like in the role list: Sylo can only order roles below its own.
3. Edit access in the dashboard on the Discord server, and someone with Edit access on the Fluxer server.

## The steps

1. **Ask.** On the Discord server's Mirror page, enter the id of the Fluxer server.
2. **Agree.** Nothing is created until someone with Edit access on the Fluxer server has agreed:
   - If you hold Edit access on both servers with your own account (you signed in with Discord and also connected
     Fluxer under Account), both sides agree at once.
   - Otherwise Sylo shows a one-time code, once. Someone with Edit access opens the dashboard for the Fluxer
     server, goes to **Mirror to Fluxer** and enters the code. The code works for an hour, once, only for that
     Fluxer server, and five wrong tries cancel the request.
3. **Preview.** The dry run reads both servers and lists what the copy would do: what it creates, what it
   changes, what it skips, and everything that cannot be carried over. It creates nothing. You choose what is
   copied: the name, icon and banner, roles, channels, emoji, stickers, Sylo's own settings, and whether Sylo
   keeps the copy in step afterwards.
4. **Copy.** After you confirm, Sylo works through the list at a pace Fluxer accepts. The page shows the
   progress. You can pause the copy, resume it and stop it from either server.
5. **Report.** Every step and what became of it, the items that failed, and the list of what could not be
   carried over.

The last step of a copy is linking every copied channel through the bridge, so a message written on one side
shows up on the other. Until the bridge module is installed that step reports "not available yet" and the copy
still finishes.

## What is copied

| From Discord | To Fluxer |
| --- | --- |
| Server name, icon, banner | The same (each can be switched off). A missing icon or banner is left as it is on Fluxer. |
| Roles | Name, colour, hoist, mentionable, order and permissions. Managed roles (a bot's, an integration's) are not copied. |
| @everyone | Its permissions are set on the Fluxer @everyone role. The role itself is never created or deleted. |
| Categories and channels | Text, voice, announcement and forum channels: name, topic, order, category, slowmode, age restriction, bitrate and user limit, and the permission overwrites. A stage channel becomes a voice channel. Threads are not copied. |
| Emoji and stickers | Up to 50 of each, within 256 KB per emoji and 512 KB per sticker. Lottie stickers are not copied. |
| Sylo's own settings | The settings and on/off state of each module, with channels and roles pointing at the new ones. A setting that points at something that is not copied is cleared, and the id of a message is cleared (the message is not copied). A module that already has settings on the Fluxer server is left alone. |

Not copied: members (they join Fluxer themselves), the roles people hold, message history, threads, permission
overwrites for one specific member (accounts are not linked between the platforms), and anything Fluxer has no
counterpart for.

### Permissions, bit by bit

Fluxer's permissions are laid out like Discord's, so most map one to one. Discord permissions that Fluxer does not
have are dropped, and the preview and the report name them wherever they were dropped: View Server Insights,
Use Application Commands, Request to Speak, Manage Events, Manage Threads, Create Public and Private Threads,
Send Messages in Threads, Use Activities, View Creator Analytics, Use Soundboard, Create Events, Use External
Sounds, Send Voice Messages, Set Voice Channel Status, Create Polls and Use External Apps. Two Fluxer permissions
have no Discord counterpart (Update RTC Region and View Channel Members): the mirror never touches them, so a role
or channel that already holds them on Fluxer keeps them.

A role with Administrator on Discord gets Administrator on Fluxer; the report points it out.

## Keeping the copy in step

With **Keep the Fluxer server in step afterwards** on, a change on Discord is queued and applied on Fluxer:
a channel or role created, renamed, moved or deleted, a permission overwrite changed, an emoji or sticker added,
renamed or removed, and the server's name, icon or banner. Many changes to one item in a short time become one
update, and a drag that moves many channels becomes one reorder.

- The copy goes **one way**. Sylo reads Discord and writes Fluxer; it does not read Fluxer back. A change you make
  on Fluxer to a mirrored channel or role is overwritten the next time that item changes on Discord.
- Sylo **never deletes something on Fluxer that it did not create.** A Fluxer channel that was there before the
  mirror stays, even with the same name as a copied one. Only what Sylo made (and what Sylo's id map shows as made
  by Sylo) is deleted, and only when its Discord original is deleted.
- Channels and roles that were already on the Fluxer server are never adopted, with one exception: a job that was
  running when Sylo stopped looks for what it may have made just before, and adopts it (as something Sylo may not
  delete).
- Settings of Sylo's modules are copied once with the copy and when you copy again; they are not followed.

## Safe by design

- **Both sides agree** (see above), and either side can pause or stop the mirror at any time. Stopping removes
  the agreement; the copy that exists stays.
- **Per server.** Each mirror has its own queue, pace and failure count: one mirror going wrong never slows another.
- **Paced.** Sylo spaces its calls to Fluxer, waits as long as Fluxer asks when it says to slow down, and backs
  off with a growing delay when Fluxer cannot be reached.
- **Resumable.** The work is a queue in the database. After a restart (or a crash) it goes on where it stopped,
  and nothing is made twice.
- **A failing mirror pauses itself** after a few failures in a row, with the reason, and shows up in
  [Health](dashboard-v2.md). Fix the cause (for example give Sylo's role the missing permission on Fluxer), then
  press **Resume**. A single item Fluxer refuses (a name it does not accept) is reported and the copy goes on.
- **Limits.** Sylo plans with 50 emoji and 50 stickers for a Fluxer server. If Fluxer refuses more because of its
  own limit, Sylo stops that kind and lists the rest in the report.

## Who can do what

Looking at the page, the preview and the report needs View access. Asking, agreeing, changing the options,
starting, pausing, resuming, stopping and removing need Edit access on the server the action is made on. Every
action looks only at the mirror the server is part of, so a code or an id of another server reaches nothing.

## For the app

A Sylo that has the mirror lists `mirror` in the `features` of `GET /api/mobile/info`. See the
[mobile app API](mobile-app.md) for the routes.

## Self-hosting

Nothing needs setting up besides both platforms' logins. The tables are created by the usual migration
(SQLite) or on start (Postgres); they hold the pair, an id map between the two servers and the queue, and are
removed with a server's data when Sylo leaves a server or the data is deleted.
