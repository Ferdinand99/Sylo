# Temporary roles (beta)

Give a member a role for a set time and Sylo takes it back by itself: a trial
membership, a "muted from events" role, a seven-day supporter perk. Staff use
`/temprole` or the dashboard. Every addition, early removal and expiry is written
to the mod log, and the member can get a DM about it (off by default).

**Dashboard:** `/v2/guilds/<id>/m/temp-roles` - settings, a form that gives a
temporary role (member search, role list, duration), and the list of active
temporary roles with a search, a role filter and a Remove button on every row.

## Needs

- **Manage Roles** for Sylo, and Sylo's own role must sit **above** the roles it
  hands out. Sylo cannot give or take a role that is above its own highest role, a
  role managed by an integration (bots, boosters) or @everyone.
- A mod-log channel in the server settings, if you want the log entries (Sylo needs
  **View Channel**, **Send Messages** and **Embed Links** there). Without one, the
  module works and writes no log.
- No privileged intents. With the **Server Members** intent Sylo also notices at
  once when someone is removed from a role by hand or leaves (see below); without
  it the minute sweep finds out when the time is up.

## Settings

- **Staff roles** - may use `/temprole` without the Manage Roles permission.
- **Send the member a DM** - off by default. A message when they get the role,
  when it is taken back early and when it ends. A member with DMs closed is skipped
  without any message.
- **Default duration** - what the dashboard's Give form starts with. The
  commands always need a duration.

## Commands

| Command | |
|---|---|
| `/temprole add <member> <role> <duration> [reason]` | Give a member a role for a time. |
| `/temprole remove <member> <role> [reason]` | Take a temporary role back now. |
| `/temprole list [member]` | The active temporary roles of the server, or of one member. |

**Duration** is `30m`, `12h`, `7d` or `2w`, or a combination such as `1d12h` (each
unit once, spaces allowed). The shortest is **1 minute**, the longest **365 days**.
A bare number is refused, because minutes or days would be a guess.

**Who may use it.** Manage Roles, Administrator, or one of the staff roles. Sylo
checks this itself, so the command is visible to everyone and refuses anyone else
with a private message. On top of that the same grant rules as the rest of Sylo
apply: the role must be **below the caller's highest role** (the server owner and
Administrators may use any role), and a role with moderator or admin permissions
also needs Manage Roles. The role must also be below Sylo's role, not managed, and
not @everyone. Anything refused says why in a private reply.

## Adding the same role again

Giving the same member the same role again **replaces** the end time: the new
duration counts from now, whether that is shorter or longer than what was left. The
reply and the mod log say that the earlier time was replaced. There is one record
per member and role.

If the member already had the role before (for example from a reaction role), it is
still a temporary role from then on: Sylo takes it away when the time is up, and
says so in the reply.

## When the time is up

Every record is stored in the database, so nothing is lost when Sylo restarts. A
sweep runs **every minute** and, for each record that has run out:

- removes the role from the member, deletes the record, writes a mod-log entry
  ("Temporary role expired") and sends the DM if that is on;
- if the **member has left** the server, deletes the record;
- if the **role was deleted**, deletes the record;
- if the **role was already taken off by hand**, deletes the record without a log
  entry. With the Server Members intent this happens the moment it is removed, so
  the record also stops counting towards the limit;
- if Sylo **cannot** take the role away right now (it lost Manage Roles, or its role
  was moved below the role), keeps the record and tries again every minute, and
  writes one line to the bot log. The Remove button on the dashboard drops the
  record at any time, even when Sylo cannot touch the role; it then says the role
  is still on the member.

After downtime, everything that ran out meanwhile is handled by the first sweep.
Roles are removed up to a minute after the end time.

## Limits

- 500 characters of reason.
- At most **2000** active temporary roles per server. Past that, new ones are refused
  until some end or are removed. Replacing the time of an existing one is always
  allowed.
- 1 minute to 365 days per role.

## Privacy and `/forget`

- `/forget` deletes the member's **temporary-role records**. Their roles **stay on
  Discord**: Sylo no longer knows to take them away, so staff must remove them by
  hand if that is wanted. Records that name the member as the staff member who set
  them lose that name.
- `/mydata` lists the member's temporary roles and the ones they set, with counts.
- The mod-log entries are messages in a channel and are not edited by `/forget`.
- The records are removed when Sylo leaves the server.

## On Fluxer

Fluxer has no slash commands yet, so staff use chat commands with the prefix:
`!temprole add @member @role 7d reason:"Trial period"`, `!temprole remove @member
@role` and `!temprole list`. Quote values that contain spaces. Replies are sent as a
short message that Sylo deletes after about 15 seconds. Expiry, the mod log, the DM
and the dashboard work exactly as on Discord. Not verified against a live Fluxer
server.
