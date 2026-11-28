# Mirror to Fluxer (beta)

**Beta.** This feature is new and may still have rough edges. Report problems in the Sylo Discord.

A server that lives on Discord can get a copy on Fluxer. Sylo reads the Discord server and builds the same
categories, channels, roles, emoji and stickers on a Fluxer server you made, then keeps the copy in step when you
change the Discord server. The copy goes one way: Discord is the source, Fluxer is the copy.

Like every Sylo feature it is free. It needs a Sylo that runs on both platforms (a Discord login and a Fluxer
login, see [Fluxer](fluxer.md)), and Sylo has to be a member of both servers. Find it in the dashboard under
**Mirror to Fluxer**, in the Server group of the sidebar. The page also works on the Fluxer server, where it is
used to agree to a mirror and to pause or stop it.

## Only the server owner

**Only the owner of the Discord server and the owner of the Fluxer server can set up and run a mirror.** An
Administrator, someone with Edit access to the dashboard and a bot master cannot ask for a mirror, agree to one,
change what is mirrored, start the copy, pause, resume, stop or remove it. Everyone with dashboard access (View or
more) can look at the page, the preview and the report.

The reason is that a mirror copies the whole server, hidden channels and all, to another place, and keeps that place
acting on it. The people who agreed are recorded by their account on each platform, and Sylo checks before every
piece of work that each server still has the owner who agreed. If a server changes hands, the mirror pauses until
the new owner has confirmed it on that server's page.

## What you need

1. A Fluxer server for the copy. Create an empty one: Sylo never deletes anything it did not make itself, so an
   empty server gives the cleanest result.
2. Sylo in that server, with a role that has the **Administrator** permission, **at the very top of the role list**.
   Sylo can only order the roles below its own. Fluxer ranks roles by position and then by age, and every new role (a
   bot's too) starts at position 1, so a position number says nothing: what counts is the rank. On a fresh server where
   Sylo has just been invited, its role is already the top one and nothing needs doing. If another role ranks above or
   level with Sylo's, the preview refuses to start and names those roles: the Fluxer server's owner opens Server
   Settings, then Roles, and drags Sylo's role to the very top (Sylo cannot move its own role), and you look again.
   (Without this, a mirrored role with Manage Roles could end up above the mirrored Administrator role.)
3. To be the owner of the Discord server, and the owner of the Fluxer server to agree (or to own both).
   The Fluxer server shows up in the picker only if you are its owner.

## The steps

1. **Ask.** The Discord server's owner opens the Mirror page and **picks the Fluxer server from a list**. The
   list holds the Fluxer servers where Sylo is a member and where you are the owner, going by the Fluxer login
   you connected under Account. Each entry shows the server's name, icon and member count, and a note when Sylo's
   role there lacks the Administrator permission or is not the top role (the same checks the preview makes; they
   do not stop you from picking, the preview does). A server that is already part of a mirror is shown but cannot
   be picked. Picking one fills in the request. If you own the Fluxer server too, both sides agree at once (next
   step).
   - **No Fluxer login connected?** The page says "Connect Fluxer under Account to pick your Fluxer servers" and
     links to Account.
   - **The Fluxer server belongs to someone else?** Choose **Enter an id instead** and paste the server's id
     (copy it on Fluxer with Developer Mode on). Its owner then agrees with the code, as below.
2. **Agree.** Nothing is created until the owner of the Fluxer server has agreed:
   - If you own both servers with your own account (you signed in with Discord and also connected Fluxer under
     Account), both sides agree at once.
   - Otherwise Sylo shows a one-time code, once. The Fluxer server's owner opens the dashboard for that server,
     goes to **Mirror to Fluxer** and enters the code. The code works for 15 minutes, once, only for that Fluxer
     server, and five wrong tries cancel the request.
3. **Preview.** The dry run reads both servers and lists what the copy would do: what it creates, what it
   changes, what it skips, and everything that cannot be carried over. It creates nothing. You choose what is
   copied: the name, icon and banner, roles, channels, emoji, stickers, Sylo's own settings, whether Sylo keeps the
   copy in step afterwards, and whether deletions are mirrored (off by default, see below).
4. **Copy.** After you confirm, Sylo works through the list at a pace Fluxer accepts. The page shows the
   progress. You can pause the copy, resume it and stop it from either server's page.
5. **Report.** Every step and what became of it, the items that failed, and the list of what could not be
   carried over.

## Linking the channels through the bridge

The last step of a copy links every copied text and announcement channel through the [Bridge](modules/bridge.md),
so a message written on one side shows up on the other. Voice channels, categories and forums are not linked.

- **Both owners already agreed.** The mirror is the consent: no link code is used. Each link records the two
  people who agreed to the mirror (shown as "Name (server mirror)" on the Bridge page and in both audit logs), and
  both channels get the usual notice, which says the link was made by the server mirror.
- **The Bridge module is switched on in both servers** if it was off, but only the first time the mirror links
  channels (it has to be on for a link to carry anything). Both audit logs say so. If a server's owner switches it
  off afterwards, that stays off: the mirror reports the pairs it could not link ("the Bridge module is switched
  off") and does not switch it on again, and the links carry nothing.
- **Every rule of the bridge holds.** An age-restricted channel is linked only to an age-restricted channel; a
  private channel only to a private one (a channel everyone can read is never linked to one that only some can);
  each owner must be able to see, read and send in the channel, and Sylo needs Manage Webhooks, View Channel and
  Send Messages in both; bots are off; nobody is pinged across. The privacy rule is checked again whenever a
  paused link resumes and on every message: a channel that turns private later stops the link ("no longer open
  to the same people"). A pair that fails a rule is skipped, the reason
  is in the report ("Linking channels through the bridge" and the notes), and the rest are linked. The report sums
  up the whole step in one sentence, for example "35 channels linked, 2 were linked already, 1 not linked (see the
  notes)", also when the channels were linked in several batches.
- **Safe to run again.** "Copy again" links only the pairs that have no link yet. A channel that an owner
  unlinked on the Bridge page stays unlinked, and a pair the owners bridged by hand is never taken over or
  changed (it is reported as skipped). A server can have at most 100 bridged channels, links made by hand
  included (the operator can change this with `BRIDGE_MAX_LINKS`, 1 to 500). A mirror of a bigger server links
  up to the limit and lists the rest in the report as "not linked: the server's bridge limit (100) is reached";
  they are linked on a later "Copy again" once the limit is raised or links are removed. A copy links 25
  channels at a time. A channel made on Discord later (continuous mirroring)
  is linked too.
- **The links follow the mirror.** While the mirror is paused (by an owner, by Sylo after a failure, or because a
  server changed owner) or stopped, its links are paused, with no notice in each channel, and they run again when
  the mirror does. If a server changed owner, its link stays paused until the new owner confirms it on the Bridge
  page. **Removing** a mirror pauses its links and leaves them, paused by the server that removed it: only that
  server's owner can resume them on the Bridge page, and the other server's owner can unlink them. While the
  mirror is not running, none of its links can be resumed on the Bridge page.

## What is copied

| From Discord | To Fluxer |
| --- | --- |
| Server name, icon, banner | The same (each can be switched off). A missing icon or banner is left as it is on Fluxer. |
| Roles | Name, colour, hoist, mentionable, order and permissions. Managed roles (a bot's, an integration's) are not copied. |
| @everyone | Its permissions are set on the Fluxer @everyone role, without powerful permissions (Administrator, Manage Roles and the like are never copied onto @everyone). The role itself is never created or deleted. |
| Categories and channels | Text, voice, announcement, forum and media channels: name, topic, order, category, slowmode, age restriction (a server marked age-restricted gives every copied text, announcement, forum and media channel the flag; voice channels and categories carry no flag), bitrate, user limit, and the permission overwrites. A stage channel becomes a voice channel. Threads are not copied. |
| Emoji and stickers | Up to 500 of each, within 512 KB per emoji and per sticker. Lottie stickers are not copied. |
| Sylo's own settings | The settings and on/off state of each module (not the operator's own modules, and not the bridge), with channels and roles pointing at the new ones. See the checks below. A module that already has settings on the Fluxer server is left alone. |

Not copied: members (they join Fluxer themselves), the roles people hold, message history, threads, permission
overwrites for one specific member (accounts are not linked between the platforms), and anything Fluxer has no
counterpart for.

### Never more open than on Discord

A channel that @everyone cannot see on Discord is hidden from @everyone on Fluxer by an overwrite of its own,
whatever else is copied: with roles switched off, or if the @everyone step fails, a private channel is still private
(Fluxer's @everyone can see channels by default). A voice channel that @everyone cannot join also denies Connect.

### Sylo's settings get the dashboard's checks

The copied settings pass the same rules as saving them in the dashboard. A role with powerful permissions is not
handed out by the copied settings (autoroles, reaction roles, level rewards, the verified role, the birthday role,
command actions): that part is left out and the report says so. A giveaway that pings @here or @everyone is copied
with the ping off. The economy module comes over switched off (its settings are copied, so you can look at the income and the shop
first). Other ids that mean nothing on Fluxer (the ids of people, of messages, of things that were not
copied) are cleared, and the report counts them. Set them again on the Fluxer server if you need them.

### Permissions, bit by bit

Fluxer's permissions are laid out like Discord's, so most map one to one, including the thread permissions (Manage
Threads, Create Public and Private Threads, Send Messages in Threads). Discord permissions that Fluxer does not
have are dropped, and the preview and the report name them wherever they were dropped: View Server Insights,
Use Application Commands, Request to Speak, Manage Events, Use Activities, View Creator Analytics, Use
Soundboard, Create Events, Use External Sounds, Send Voice Messages, Set Voice Channel Status, Create Polls and Use
External Apps. Two Fluxer permissions have no Discord counterpart (Update RTC Region and View Channel Members): the
mirror never touches them, so a role or channel that already holds them on Fluxer keeps them.

A role with Administrator on Discord gets Administrator on Fluxer (except on @everyone); the report points it out.

## Keeping the copy in step

With **Keep the Fluxer server in step afterwards** on, a change on Discord is queued and applied on Fluxer:
a channel or role created, renamed, moved or deleted, a permission overwrite changed, an emoji or sticker added,
renamed or removed, and the server's name, icon or banner. Many changes to one item in a short time become one
update, and a drag that moves many channels becomes one reorder.

- The copy goes **one way**. Sylo reads Discord and writes Fluxer; it does not read Fluxer back. A change you make
  on Fluxer to a mirrored channel or role is overwritten the next time that item changes on Discord. Changing a
  mirrored category also changes the channels on Fluxer that are synced with it, including ones you put there
  yourself.
- **Deleting on Discord does not delete on Fluxer by default.** The Fluxer copy is locked instead: a channel is hidden
  from @everyone and made read-only (its messages are kept: deleting a Fluxer channel deletes its messages), a
  role loses its permissions, and it is listed on the Mirror page as "Removed on Discord" for the Fluxer owner to
  look at and delete. Only with **Delete on Fluxer what is deleted on Discord** switched on is the copy really
  deleted (with its messages). The option is off by default and carries a warning. The Discord owner can only *ask* for
  it: it stays off until the owner of the Fluxer server allows it on their Mirror page, because deleting a Fluxer channel
  destroys messages that exist only there. The Fluxer owner can switch it off again, and so can the Discord owner.
- **A burst of deletions pauses the mirror.** More than five deletions on Discord within ten minutes (a nuke, a
  mistaken clean-up) pause the mirror, with the reason in Health on both servers. The deletions wait in the queue and
  are applied only when the owner confirms in the dashboard, in a dialog that lists what will be locked or deleted
  (with real deletion on, only the Fluxer owner can confirm). The same confirmation is asked when a paused mirror is
  resumed with more than five deletions waiting.
- Sylo **never deletes something on Fluxer that it did not create.** A Fluxer channel that was there before the
  mirror stays, even with the same name as a copied one. Only what Sylo made (and what Sylo's id map shows as made
  by Sylo) is ever locked or deleted, and only when its Discord original is deleted.
- Channels and roles that were already on the Fluxer server are never adopted, with one exception: a job that was
  running when Sylo stopped, or whose answer was lost in a timeout, looks for what it may have made just before
  (matching, and made since the job started) and adopts it, as something Sylo may not delete.
- Settings of Sylo's modules are copied once with the copy and when you copy again; they are not followed.

## Safe by design

- **Only the owners**, who agreed on each side and are checked again before every piece of work (see above). Either
  owner can pause or stop the mirror at any time; a mirror one owner paused can be resumed only by that owner.
  Stopping removes the agreement; the copy that exists stays.
- **Per server.** Each mirror has its own queue, pace and failure count: one mirror going wrong never slows another.
  A few mirrors run at a time so that mirror work cannot starve the bridge and the other modules.
- **Paced.** Sylo spaces its calls to Fluxer, waits as long as Fluxer asks when it says to slow down, and backs
  off with a growing delay when Fluxer cannot be reached.
- **Resumable, and no second copy.** The work is a queue in the database. After a restart (or a crash) it goes on where
  it stopped. Only a real "not found" from Fluxer means a copy is gone: a timeout, a rate limit or a server error
  never makes a second one, and a role created but not finished is tracked and updated, not made again.
- **A failing mirror pauses itself** after a few failures in a row, with the reason, and shows up in
  [Health](dashboard-v2.md). Fix the cause (for example give Sylo's role the missing permission on Fluxer), then
  press **Resume**. A single item Fluxer refuses (a name it does not accept) is reported and the copy goes on.
- **The role order is exact, and powerful permissions come last.** Sylo sends a distinct position to every mirrored
  role, in Discord's order, all under its own role. A new role is first made without its powerful permissions
  (Administrator, Manage Roles and the like), because a new role starts at the bottom where a member with Manage Roles
  could hand it out; only after the order is set does Sylo give it its permissions. If a role ranks above Sylo's (the
  order cannot be set) the mirror pauses with the roles named, and the new role stays without its permissions until the
  Fluxer owner has fixed it and the mirror is resumed. If Fluxer refuses the order itself, the report shows "Role
  order" as failed with Fluxer's reason, the roles stay without their powerful permissions, and **Copy again** sends
  the order again (and then grants them).
- **The channel order is the one Discord shows.** Inside a category the text, announcement, forum and media channels
  come first and the voice channels after them (Discord numbers the two kinds separately, and Fluxer does not allow a
  voice channel above a text channel); at the top, the channels without a category come before the categories.
  Channels made on the Fluxer server by its own people stay where they are. A refused channel order is reported with
  Fluxer's reason, and **Copy again** tries it again.
- **Limits.** Sylo plans with Fluxer's defaults (500 emoji and 500 stickers per server, 512 KB per emoji and per
  sticker). If Fluxer refuses more because of its own limit, Sylo stops that kind and lists the rest in the report.

## Who can do what

Looking at the page, the preview and the report needs View access. Everything that changes anything needs the
server's owner (see the top), on the server the action is made on. Every action looks only at the mirror the server
is part of, so a code or an id of another server reaches nothing.

The list of Fluxer servers on the Ask step (`GET /api/v2/guilds/<id>/mirror/fluxer-servers`) is asked for only by
the owner of the Discord server, is rate limited, and names only Fluxer servers that the caller's own Fluxer login
lists and that Fluxer reports the caller as the owner of. A server somebody else owns is never named, even to its
Administrators. On an instance with sign-in switched off there is no account to compare, so every Fluxer server Sylo
is in is listed, as with the other access checks.

## For the app

A Sylo that has the mirror lists `mirror` in the `features` of `GET /api/mobile/info`. See the
[mobile app API](mobile-app.md) for the routes.

## Self-hosting

Nothing needs setting up besides both platforms' logins. The tables are created by the usual migration
(SQLite) or on start (Postgres); they hold the pair, an id map between the two servers and the queue, and are
removed with a server's data when Sylo leaves a server or the data is deleted. With sign-in switched off (a
private instance with no logins) there are no accounts to check, so the owner rule is not enforced there, as
Edit access is not.
