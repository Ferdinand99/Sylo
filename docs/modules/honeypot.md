# Honeypot (beta)

Trap channels and trap messages for scrapers and raid bots. A bot that joins,
grabs every role and posts or reacts everywhere will hit the trap. Any member who
posts in a trap channel, or reacts to a trap message, is punished at once: kick,
timeout or ban. There is no warning and no grace period. Administrators and
members with an **exempt role** are always skipped, and Sylo never acts on other
bots.

**Dashboard:** `/v2/guilds/<id>/m/honeypot`.

## Needs

- **Kick Members** for the kick action, **Moderate Members** for the timeout
  action and **Ban Members** for the ban action. Sylo's highest role must sit
  **above** the member's role, or the action is skipped (see below).
- **Manage Messages** to delete the message posted in a trap channel (optional,
  see *Delete the triggering message*).
- For a **message honeypot**, in the channel that holds the trap message:
  **View Channel**, **Send Messages**, **Embed Links** and **Read Message
  History**. Without them Sylo cannot post the trap message or update its catch
  count, and it writes a warning to its log instead.
- A mod-log channel in the server settings, if you want the log entry (Sylo needs
  **View Channel**, **Send Messages** and **Embed Links** there). Without one the
  module still works and writes no log entry.
- No privileged intents.

## Settings

The module has two kinds of trap and one shared list of exemptions.

**Channel honeypots** — any message posted in the channel triggers the punishment.

- **Channel** — the trap channel. One entry per channel.
- **Action** — **Kick**, **Timeout** or **Ban** (default Kick).
- **Timeout (min)** — how long a timeout lasts (default 10; only used by the
  Timeout action).
- **Delete the triggering message** — on by default.

**Message honeypots** — Sylo posts a trap message in the channel you choose, and
any reaction to it triggers the punishment.

- **Channel**, **Action** and **Timeout (min)** — as above. One message honeypot
  per channel.
- **Bait text** — shown in the trap message, for example "Click here to verify
  your account." Optional.

**Exempt roles** — members with any of these roles are never punished.
Administrators are always exempt.

The page also lists the **Recent catches** (the last 25): who, which channel,
channel or message trap, the action taken and how long ago.

## What happens on a trigger

1. Sylo checks the member. Administrators, exempt roles and bots are skipped.
2. Sylo applies the action:
   - **Kick** and **Ban** — Sylo sends the member a DM first ("You were kicked /
     banned in …"), then removes them. A member with DMs closed is removed anyway.
   - **Timeout** — Sylo times the member out for the set minutes, then sends the
     DM. The longest possible timeout is 28 days (40320 minutes).
3. Sylo records a moderation case (action *kick*, *timeout* or *ban*, moderator
   `honeypot`, with the reason "Honeypot: message posted in trap channel" or
   "Honeypot: reacted to trap message") and posts **Honeypot triggered** to the
   mod-log channel with the case number, the member and the action.
4. Sylo adds the catch to the **Recent catches** list and raises the trap's
   counter.
5. In a channel honeypot, the triggering message is deleted if that option is on.

A message honeypot's trap message carries a live **Catches** field named after
its action, for example "Bans: 14". Sylo edits it after every catch.

Sylo posts the trap message when you save the settings. If someone deletes it,
the next save posts a new one. Sylo edits the existing message in place when the
bait text or counter changes. Removing a message honeypot from the settings does
not delete the message in the channel; delete it by hand. Sylo does not remove the
reaction that set off a catch.

## Notes

- If Sylo cannot apply the action, it does nothing to the member: for a kick or a
  timeout the member must be below Sylo's highest role and not the server owner,
  and for a ban Sylo needs **Ban Members**. In that case there is no case, no
  mod-log entry, no catch and no counter change. In a channel honeypot the message
  is still deleted when that option is on.
- A chat command posted in a trap channel counts as a trap hit and does not run.
- Put the trap where real members have no reason to go, such as a decoy channel
  named "free-nitro" that is visible to new members. Say in its name or topic
  that it is a trap, so a human who wanders in is not caught by surprise.
- Test with a second account that has no exempt role and no Administrator
  permission. An Administrator account is skipped.

## Limits

| Setting | Limit |
|---|---|
| Channel honeypots | up to 25 |
| Message honeypots | up to 25 |
| Timeout | 1 to 40320 minutes (28 days) |
| Bait text | 500 characters |
| Catch log | the newest 200 catches per server are kept |

## Fluxer

The module works the same way on [Fluxer](../fluxer.md). A command posted with the
chat prefix in a trap channel counts as a message and does not run, and
reactions on a trap message count too.

## Data and privacy

For every catch Sylo stores the member's ID and tag (name) at that moment, the
trap type (channel or message), the channel, the action and the time, so the
dashboard can show a real name for someone who has since been kicked or banned.
Only the newest 200 catches per server are kept. The moderation case is stored
with the other cases of the server.

Honeypot catches are a **safety record**: a member cannot erase them with `/forget`.
The `/mydata` export includes them. Deleting a server's data removes them. See the
[privacy policy](../privacy-policy.md).
