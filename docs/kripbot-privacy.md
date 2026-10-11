# kripbot Privacy Policy

Last updated: 11 October 2026.

This notice applies to the kripbot instance operated by Kripusek (Discord application ID 1557837851427864648). Other deployments of this open-source project have their own operators and are not covered by this notice.

## Contact
Contact the bot operator on Discord (username: kripusek), or ask the administrators of a server using kripbot to forward a privacy or support request to the operator. Provide your Discord user ID and the relevant server ID. Do not send passwords, account tokens or sensitive personal information.

## Data and purposes
Depending on the modules enabled by server administrators, the bot processes Discord user, server, channel, message and role identifiers; usernames and avatars; member join, leave and role-change events; message text and attachment metadata or links; voice-channel join/leave events and participation counters; moderation actions and reasons; support-ticket messages and attachments; and optional feature data such as XP, invite records, birthdays, AFK messages, giveaway participation and appeals.

Data is used to provide server moderation, support tickets, administrator-configured logs, automatic roles and welcome messages, keyword responses and the optional community features requested by administrators. Voice-channel events do not record voice audio. The bot does not request other users' presence or game-activity data. Setting the bot's own displayed activity does not track members.

The dashboard uses Discord OAuth to identify the signed-in user and check server-management access. Login/session data and cookies support authentication. Dashboard requests may also be processed by Cloudflare and the hosting infrastructure, including network and security metadata.

## Storage and access
Some data is processed transiently in memory. Persistent feature records, moderation history, DM support-ticket contents, settings and dashboard audit records are stored in the self-hosted bot database. Database backups may contain copies of those records.

When message logging is enabled, message text and attachment links may be copied into configured Discord log channels. Ticket transcripts may also be posted to Discord. Those copies can remain after the original message or ticket channel is deleted.

The operator has access to the hosting system and database. Server administrators and configured staff may access relevant dashboard records and Discord logs or tickets according to their permissions. Discord processes content posted to its service; Cloudflare processes dashboard traffic. Optional integrations process information necessary for their enabled feature, for example an external player identifier deliberately supplied for a game-statistics lookup.

Discord API data is not sold, supplied to advertising/data-broker services, or used to train machine-learning or AI models.

## Retention
Retention depends on server configuration and the category of data. Configured ticket retention removes eligible closed DM tickets and their database messages. Configured moderation retention removes eligible inactive cases, not all active moderation records. A retention setting of zero does not automatically expire those records.

Discord log messages and exported transcripts are not deleted by the database retention scheduler and require separate administrator management. Backups rotate according to the instance's configured backup interval and retention count. Consequently, deleting a live database record does not immediately remove every older backup copy. Requests concerning remaining copies should be sent to the operator.

## Access, deletion and choices
Use /mydata in the relevant server to export the supported personal records from the database. Use /forget confirm:True to delete the supported records associated with your account in that server. These commands do not cover every operational record, Discord channel message, transcript or backup.

The /forget command is a deletion request, not a permanent opt-out: new records may be created if you continue using a server with applicable features enabled. There is currently no general per-user switch that disables all message-content processing or logging. Contact the operator and server administrators about access, correction, deletion or an objection to processing, including Discord log copies and backups.

Administrators can disable modules, configure logging exclusions and restrict the channels the bot can view. Sending a DM support request intentionally provides its content to the server's support staff. Do not submit sensitive personal information in tickets.

## Changes
This notice will be updated when the bot's data practices change. The date above identifies this version.
