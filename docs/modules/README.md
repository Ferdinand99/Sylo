# Modules

Every Sylo feature is a **module** — toggled and configured per server from the
dashboard (`/guilds/<id>/m/<module>`), like MEE6 or Dyno plugins. Modules are
**off by default** unless noted; enable them on the module's page.

Each page below lists what the module does, the Discord permissions and gateway
intents it needs, its settings, and any slash commands.

| Module | What it does | Default | Privileged intents |
|---|---|---|---|
| [Moderation](moderation.md) | Warnings, warning auto-actions, mod-log, ban/lock tools | **on** | — |
| [Auto-moderation](automod.md) | Filter invites, links, spam, caps, banned words | off | Message Content |
| [Server logging](logging.md) | Send member/message/role/channel events to log channels | off | Server Members + Message Content |
| [Verification](verification.md) | Gate new members behind a button or captcha | off | Server Members |
| [Ban appeals](appeals.md) | DM banned members an appeal form; staff decide from the dashboard | off | — |
| [Tickets (modmail)](tickets.md) | Members DM the bot; staff reply from the dashboard | off | — |
| [Welcome & leave](welcome.md) | Greet joiners (with an optional image) and announce leavers | off | Server Members |
| [Welcome channel](welcome-channel.md) | One rich pinned message for a read-only welcome channel | off | — |
| [Birthdays](birthdays.md) | Members save a birthday; Sylo greets them and can grant a role | off | — |
| [Reaction roles & autoroles](roles.md) | Self-assign roles from a message; roles automatically on join | off | Server Members |
| [Leveling](leveling.md) | XP and levels from activity, role rewards, leaderboard | off | Server Members |
| [Invite tracker](invite-tracker.md) | Track who invited each member; inviter leaderboard | off | Server Members |
| [Counting](counting.md) | Members count upward one number at a time | off | Message Content |
| [Starboard](starboard.md) | Re-post well-reacted messages into a highlights channel | off | Message Content |
| [Autoresponder](autoresponder.md) | Auto-reply when a message matches a trigger | off | Message Content |
| [Custom commands](custom-commands.md) | Build `/slash` commands from an action list | off | — |
| [Reminders](reminders.md) | Post a message to a channel once or on a schedule | off | — |
| [Sticky messages](sticky.md) | Keep a message pinned to the bottom of a channel | off | — |
| [Polls](polls.md) | Reaction polls that auto-close on a timer or vote cap | off | — |
| [Giveaways](giveaways.md) | Prize giveaways with an Enter button; auto-drawn winners | off | — |
| [AFK](afk.md) | Members mark themselves away; Sylo replies to mentions | off | — |
| [Temporary voice channels](temp-voice.md) | Join-to-create voice hubs controlled with `/voice-*` | off | — |
| [Server statistics](server-stats.md) | Voice channels named with live member/role/boost counts | off | Server Members |
| [Twitch alerts](twitch-alerts.md) | Announce when a Twitch streamer goes live | off | — |
| [YouTube alerts](youtube-alerts.md) | Announce a channel's new uploads and going live | off | — |
| [Free games](free-games.md) | Announce games free to claim on the Epic Games Store | off | — |
| [Game stats](game-stats.md) | Battlefield-series player lookups via `/stats` | off | — |

See also [self-hosting.md](../self-hosting.md) for the privileged-intent env
vars and the bot's permission set.
