# The Sylo app

A native iOS app (SwiftUI, source in `apps/sylo-ios`) that signs in to a Sylo
instance, the hosted one or your own, and manages your servers through the same
JSON API the dashboard uses. This page covers what a self-hosted instance
needs for the app to work, and how the app's sign-in works for anyone reading or
reviewing it.

> **On the App Store.** The app ("Sylo – Server Manager") is
> [on the App Store](https://apps.apple.com/app/sylo-server-manager/id6824036901). The server side described here is part of Sylo; it does nothing
> until an app signs in.

- [What a self-hosted instance needs](#what-a-self-hosted-instance-needs)
- [Behind a proxy with its own login](#behind-a-proxy-with-its-own-login)
- [How sign-in works](#how-sign-in-works)
- [Adding the other login](#adding-the-other-login)
- [Endpoints](#endpoints)
- [Tokens and signed-in devices](#tokens-and-signed-in-devices)
- [Permissions](#permissions)
- [Notifications](#notifications)
- [Health and the dev log (operators)](#health-and-the-dev-log-operators)
- [Security notes](#security-notes)

---

## What a self-hosted instance needs

**Nothing new to configure.** The app signs in with the dashboard login you
already have:

- Discord login: `DISCORD_CLIENT_SECRET` and the `<DASHBOARD_URL>/auth/discord/callback`
  redirect, see [Dashboard authentication](self-hosting.md#dashboard-authentication).
- Fluxer login: `FLUXER_CLIENT_SECRET` and the `<DASHBOARD_URL>/auth/fluxer/callback`
  redirect, see [Dashboard login](fluxer.md#dashboard-login).
- Either one, or both. With both, the app's sign-in sheet shows the usual choice.

The phone has to reach the instance at the address you type into the app, so
`DASHBOARD_URL` should be that same address (typically the public HTTPS URL
behind your [reverse proxy](self-hosting.md#behind-a-reverse-proxy)).

**Open mode does not work with the app.** Without a client secret the dashboard
has no accounts, so there is nobody to sign in as: `/api/mobile/info` reports
`"login": false`, the sign-in routes (`/auth/mobile/*`, `/api/mobile/token`)
answer `404`, and the app says this server has no login.
Open mode is meant for a trusted LAN only and never hands out tokens.

---

## Behind a proxy with its own login

If something in front of Sylo asks for its own login (Pangolin, Cloudflare
Access, Authelia, nginx basic auth and so on), split the paths:

- **The sign-in sheet is a browser.** It can show the proxy's login page and
  keeps the proxy's cookie, so `/auth/*` (including `/auth/mobile/*`) can stay
  behind the proxy login.
- **The app's own requests are not a browser.** They carry the app token but no
  proxy cookie, so the proxy would answer them with its login page. `/api/mobile/*`
  and `/api/v2/*` must be reachable **without** the proxy login. Sylo
  authenticates those requests itself, with the app token or the dashboard
  session, and refuses anything without one.

| Path | Proxy login |
| --- | --- |
| `/auth/*` | May stay on |
| `/api/mobile/*` | Bypass |
| `/api/v2/*` | Bypass |
| Everything else | Up to you |

For example, in Pangolin turn on the resource's **Access Rules** and add two
rules with the action **Bypass Auth**, match type **Path**, for `/api/mobile/*`
and `/api/v2/*`; in Cloudflare Access add a second application for
`sylo.example.com/api/mobile` and `sylo.example.com/api/v2` with a **Bypass**
policy; in Authelia add rules for `^/api/(mobile|v2)/` with `policy: bypass`
above the rule that protects the domain; in nginx put `auth_basic off;` in a
`location ~ ^/api/(mobile|v2)/` block.

Only bypass these paths when Sylo's own login is on (a client secret is set).
In open mode the proxy login is the only thing protecting `/api/v2`.

---

## How sign-in works

The app uses `ASWebAuthenticationSession` with the custom URL scheme `sylo://`
(universal links would need a file on the server's domain, which a self-hosted
instance cannot provide for the app). It follows the shape of OAuth's
authorization-code flow with PKCE (RFC 7636, S256 only).

1. The app makes a random `verifier` (43 to 128 characters of
   `A-Z a-z 0-9 . _ ~ -`), its `challenge = base64url(sha256(verifier))` (43
   characters) and a random `state` (8 to 128 of the same characters).
2. It opens a browser sheet on
   `GET /auth/mobile/start?challenge=…&state=…[&platform=discord|fluxer]`.
   Sylo remembers the challenge and state in the browser session for 10 minutes.
   A missing or malformed value, or a `platform` that is not configured, gives an
   error page.
3. The person signs in through the normal login: straight to that platform's
   login when `platform` is given or only one is configured, else the login
   chooser. Someone already signed in in that browser skips this step.
4. The login returns to `GET /auth/mobile/confirm`: "Sign in to the Sylo app?",
   showing the account name and platforms, with **Allow** and **Cancel**.
5. **Allow** posts the form back (with a per-flow nonce). Sylo creates a
   one-time code and redirects to `sylo://auth?code=…&state=…`. **Cancel** goes
   to `sylo://auth?error=access_denied&state=…`.
6. The app checks that `state` is the one it sent, then exchanges the code:

   ```http
   POST /api/mobile/token
   Content-Type: application/json

   { "code": "…", "verifier": "…", "deviceName": "iPhone" }
   ```

   ```json
   {
     "token": "sylo_…",
     "expiresAt": 1799999999999,
     "account": {
       "name": "ferdi",
       "avatar": "https://cdn.discordapp.com/avatars/…png?size=…",
       "platforms": ["discord", "fluxer"],
       "owner": false
     }
   }
   ```

   `expiresAt` is in milliseconds since the epoch. `avatar` may be `null`.
   `owner` is true for an account listed in `OWNER_IDS` / `FLUXER_OWNER_IDS`.
   `deviceName` is optional (control characters are removed, at most 100
   characters, `Sylo app` when empty). Any failure (unknown, used or expired
   code, wrong verifier, malformed body) is `400 { "error": "invalid_grant" }`.
7. Every API request then sends `Authorization: Bearer sylo_…`.
8. Signing out in the app calls `DELETE /api/mobile/token` with that header,
   which answers `204` and revokes the token at once.

---

## Adding the other login

An account holds one Discord and one Fluxer login. On a Sylo that has both set up
(`app-connect` in the [features](#endpoints)), the app can add the one the account
lacks, so a Discord account can also sign in with Fluxer, or the other way round.
Disconnecting needs nothing new: the account page does it.

The login is finished **in the app**, with its token, not by the browser. That is what
keeps someone else's link from attaching your login to their account.

1. The app asks for a code. It needs its token, and only for a platform the account
   does not have yet:

   ```http
   POST /api/mobile/connect/fluxer
   Authorization: Bearer sylo_…
   ```

   ```json
   { "code": "…", "expiresAt": 1799999999999 }
   ```

   `400 { "error": "invalid_platform" }` for a platform that is unknown or not set
   up here, `409 { "error": "already_connected" }` when the account has it. The code
   names the account and the token that asked.
2. The app opens `GET /auth/mobile/connect?code=…` in the browser sheet, on the same
   address. The page asks "Add Fluxer to the Sylo account *name*?" and says which
   account that is. If the browser is signed in to the dashboard as somebody else, it
   warns that someone else may have started this.
3. **Continue** leads to the other platform's login, which is asked to show its consent
   screen (`prompt=consent`), so the person sees which of their accounts there is used.
4. The callback links nothing. It keeps the verified login under a **result code** (120
   seconds, single use, stored as a hash, bound to the account and the token from step 1)
   and ends the sheet at

   ```
   sylo://connected?platform=fluxer&result=<code>
   ```

   or, when nothing was kept, `sylo://connected?platform=fluxer&error=<word>` with one of
   `access-denied` (cancelled), `invalid-response`, `expired` (took more than ten
   minutes), `provider-error`, `token-revoked` (the app was signed out meanwhile),
   `identity-linked` (that login already belongs to another account) or `already-linked`
   (the account already has a login on that platform).
5. The app completes the link with the same token:

   ```http
   POST /api/mobile/connect/complete
   Authorization: Bearer sylo_…
   Content-Type: application/json

   { "result": "<code>" }
   ```

   ```json
   { "ok": true, "platform": "fluxer", "platforms": ["discord", "fluxer"] }
   ```

   The login is linked only when this token is the one that asked for the code in step 1.
   Anything else is `400 { "error": "invalid_result" }` (unknown, used, expired, or made for
   another token or account), and the code is used up by the attempt. `409` with
   `identity_linked` or `already_linked` when the login or the platform was taken in the
   meantime; `401` when the token is no longer valid.

The browser is not signed in to Sylo at any point: nothing here starts, replaces or
extends a web session.

**For app developers.** In the case this design exists for (someone else's link opened in
the person's ordinary browser), the `sylo://connected?…&result=…` redirect goes through
the operating system's URL-scheme dispatcher, and an app on the device that also claims
`sylo://` could receive it. The server cannot prevent that, because the one who started
the flow is the attacker. So the app must act only on the callback that comes back from its
own `ASWebAuthenticationSession` (the one it opened in step 2), and must ignore a
`sylo://connected` URL that arrives through the normal URL handler. Without the matching
token a result code is useless to anyone else anyway.

---

## Endpoints

| Method and path | Auth | Answer |
| --- | --- | --- |
| `GET /api/mobile/info` | None | What this server is (below) |
| `GET /auth/mobile/start` | None (browser) | Redirect to the login, or to the confirmation page |
| `GET /auth/mobile/confirm` | Browser session | The confirmation page |
| `POST /auth/mobile/confirm` | Browser session + nonce | Redirect to `sylo://auth?code=…&state=…` |
| `POST /api/mobile/token` | Code + verifier | `{ token, expiresAt, account }`, or `400 invalid_grant` |
| `DELETE /api/mobile/token` | Bearer token | `204`, or `401` without a valid token |
| `POST /api/mobile/connect/:platform` | Bearer token | `{ code, expiresAt }`: a one-time code to add that platform's login ([Adding the other login](#adding-the-other-login)); `400`, `401`, `403` or `409` |
| `GET /auth/mobile/connect?code=…` | None (browser) | The confirmation page; the link is used up when it is opened |
| `POST /api/mobile/connect/complete` | Bearer token | `{ ok, platform, platforms }`: links the login the sheet ended with, for the token that began the flow only; `400 invalid_result`, `401`, `403` or `409` |
| `GET /auth/mobile/connect/continue?nonce=…` | Browser session + nonce | Redirect to the other platform's login |
| `/api/v2/*` | Bearer token | The dashboard's JSON API |
| `GET /api/v2/changelog?limit=N` | Bearer token or session | `{ version, releases: [{ version, date, url, sections: [{ title, kind, items: [{ scope, text, refs }] }] }] }`, newest first; the same release notes as the dashboard's What's new page |
| `GET /api/v2/guilds/:id/members?q=` | Bearer token or session, Manage Server | `{ members: [{ id, name, username }] }`: the server's members by name (those Sylo has cached) or one pasted id (looked up live), never a bot, at most 25. 100 searches per minute per account and server |
| `GET /api/v2/guilds/:id/health` | Bearer token, server admin | The permission and role-hierarchy health check of one server (below) |

`GET /api/mobile/info` is public. The app calls it when you type a server
address, to tell whether the address is a Sylo server and whether it can sign
in there:

| Field | Meaning |
| --- | --- |
| `name` | Always `"Sylo"` |
| `version` | The Sylo version, for example `"4.0.0"` |
| `apiVersion` | The app API version, currently `1` |
| `login` | Whether sign-in is available (false in open mode) |
| `loginProviders` | The configured logins, for example `["discord", "fluxer"]`; empty when `login` is false |
| `platforms` | The platforms the bot runs on, for example `["discord"]` |
| `features` | What this version's app API supports, so the app can hide what an older Sylo lacks. Today: `app-login`, `live-access`, `changelog`, `collectibles`, `welcome-trigger`, `member-search`, `access-levels`, `health` and `app-connect`, plus `push` and `push-pigeon` when this instance can send notifications. See the list below |

The feature strings:

- `app-login`: the app sign-in above.
- `live-access`: server access is checked live through the bot on every request.
- `changelog`: `GET /api/v2/changelog`.
- `collectibles`: the Economy shop's collectible items, their picture upload and the inventory.
- `welcome-trigger`: the Welcome module's `trigger` setting (a member joins, or first gets a role).
- `member-search`: `GET /api/v2/guilds/:id/members?q=`.
- `access-levels`: the dashboard [access levels](#access-levels) (View, Inbox, Edit).
- `health`: `GET /api/v2/guilds/:id/health`, the [health check](#health-check).
- `app-connect`: [adding the other login](#adding-the-other-login). Only where sign-in is on and both Discord and Fluxer logins are set up.
- `push`, `push-pigeon`: this instance can send notifications to signed-in apps.

An older Sylo without this endpoint answers `404`, and the app says the server
is too old for it. A Sylo that has the endpoint but lacks a string does not have
that feature: the app hides the control.

### Health check

`GET /api/v2/guilds/:id/health` tells a server admin what Sylo cannot do in the places its modules are
set up to use: a channel it cannot post in, a role it cannot give because Sylo's role is not above it,
a permission an action needs. Only the modules that are switched on are checked. The answer is cached for
a minute per server and is dropped when a setting is saved; `?refresh=1` checks again at once (6 per minute).

```json
{
  "guildId": "…", "available": true, "platform": "discord", "checkedAt": 1760000000000,
  "summary": { "errors": 1, "warnings": 0 },
  "checks": [{
    "module": "verification", "moduleName": "Verification", "severity": "error",
    "code": "role-above", "kind": "role-hierarchy",
    "message": "Sylo can't give Verified: Sylo's role is not above it.",
    "fix": "In the server's role settings, move Sylo's role above Verified.",
    "href": "/v2/guilds/…/m/verification", "targetKind": "role", "targetId": "…", "targetName": "Verified"
  }],
  "targets": {
    "roles": { "blockedAll": null, "blocked": { "<roleId>": "above | managed" } },
    "channels": { "blocked": { "<channelId>": ["View Channel", "Send Messages"] }, "noEmbed": ["<channelId>"] }
  }
}
```

`severity` is `error` when a module cannot do that part of its job and `warning` when it still works.
`targets` lists only the roles Sylo cannot give and the channels it cannot send in (`blocked`), and the
channels where it can send but lacks Embed Links (`noEmbed`, which matters only to a module that sends an
embed there), for a picker to warn about a choice that is not saved yet. A permission the platform does not
have (Fluxer has no thread permissions) is never reported. The same checks come with the overview, in `attention.health`.

On a token request, "not signed in" and "not allowed" are JSON, never a
redirect or an HTML page:

| Status | Body |
| --- | --- |
| `401` | `{ "error": "Not signed in, or the token is no longer valid." }` |
| `403` | `{ "error": "You do not manage this server." }` |
| `403` | `{ "error": "Your dashboard access in this server is View only, so you can't do this.", "access": "view", "required": "edit" }` |
| `403` | `{ "error": "Restricted to Sylo's operators." }` |

The usual per-IP rate limits apply. On top of them, per minute: 60 calls to
`/api/mobile/info`, 30 to the `/auth/mobile` pages and 20 code exchanges. Adding a login
allows 10 codes and 10 completions per token and 10 visits to its two pages per client.
Actions that post to the platform (test messages, publishing a message or role
menu, locking or unlocking every channel) share a limit of 10 per minute per
server and account, answered with `429` and an `{ "error" }`.

---

## Tokens and signed-in devices

- A token is `sylo_` followed by 32 random bytes (base64url). The prefix makes a
  leaked token easy to find in a scan.
- **Lifetime 90 days, sliding.** Each use moves the expiry 90 days forward
  (written at most once an hour). A token unused for 90 days stops working and
  is purged with the session sweep.
- **Only a SHA-256 hash is stored**, with the account it belongs to, the device
  name, when it was created and last used, and its expiry. A copy of the
  database cannot be used to act as anyone.
- **Signed-in devices.** The account page (**Account** in the dashboard,
  `/v2/account`) lists each device with its name and last
  use, and a **Revoke** button.
- A token stops working, at once, when:
  - the app signs out (`DELETE /api/mobile/token`),
  - the device is revoked on the account page,
  - the account is deleted (**Settings → Delete Account** in the app, or the
    account page on the web, `POST /api/v2/account/delete` with
    `{ "confirm": true }`): every token of the account goes with it,
  - a sign-in (Discord or Fluxer) is disconnected from the account: this revokes
    all of the account's app tokens, and the app has to sign in again,
  - it has not been used for 90 days,
  - the account signs in on a 21st device: an account keeps at most 20, and the
    least recently used one is signed out.

Device names are shown as sent, minus control and invisible formatting
characters, cut to 100 characters.

Token lookups are not cached, so a revocation counts on the next request.

---

## Permissions

The app has exactly the rights the web dashboard gives the same person. The one
difference is how server access is checked:

- Both use the server list stored at login. The bot keeps it current: when it
  sees someone gain or lose Manage Server or Administrator, or become the owner,
  that server is added to or removed from their list. Neither the dashboard nor
  the app sends anyone through the platform login again to refresh it.
- The web dashboard trusts that list for 10 minutes after login, then checks
  live through the bot, like the app.
- For app requests Sylo checks **live, through the bot, on every request**:
  the person must own the server, have Manage Server or Administrator there, or
  hold one of its dashboard access roles (below). Someone who loses those rights
  loses access from the app at once. The bot has to be in the server. The live
  check only runs for a server that was in the stored list at sign-in, or that
  has access roles set, so a token cannot make the bot look people up in every
  server it is in. This covers the ticket pages too.
- The server list (`GET /api/v2/guilds`) is the stored list filtered by the same
  live check, plus the servers where the bot sees you holding an access role.
  Each entry carries `access`: `"edit"`, `"inbox"` or `"view"`. A server where
  you newly gained Manage Server shows up after the next sign-in.
- Owner-only modules and bot-wide pages stay limited to `OWNER_IDS` /
  `FLUXER_OWNER_IDS`, the same as in the browser.

### Access levels

Every per-server route needs one of three levels (`access-levels` in `features`):

| Level | Who | May |
| --- | --- | --- |
| `edit` | The owner, Manage Server, Administrator, the bot-master roles | Everything, as before |
| `inbox` | The server's Inbox roles, and ticket staff roles for tickets | Read everything, including what the inboxes contain; reply to and close tickets, decide appeals, applications and suggestions |
| `view` | The server's View roles | Read the pages, lists and settings; change nothing |

A request above the person's level gets `403` with `access` (their level) and
`required` (the level the route needs).

- What the inboxes contain needs `inbox`: `GET .../tickets/:id` (and its
  `/messages` and `/transcript`), `GET .../applications/submissions/:id` and
  `GET .../applications/export`. With `view`, the lists still answer, but
  without that content, and with `contentHidden: true`: the tickets' `preview`
  and `previewKind`, the appeals' `answers` and `decisionReason`, the
  applications' `reason`, and the author of an anonymous suggestion are empty.
- Settings that hold a secret show it only with `edit`: GitHub webhook secrets
  and addresses are `null`, and RSS feed URLs show only their origin. The
  configuration download (`GET .../export`) and the insights refresh need `edit`.
- Deciding an application checks the person deciding: they must be able to hand
  out every role the decision gives (as when saving the form), no such role may
  give more dashboard access than their own, and nobody decides their own
  application. With `inbox`, accepting an appeal (which lifts the ban) also needs
  Ban Members.
- `GET /api/v2/guilds/:id/access` answers
  `{ level, editRoleIds, inboxRoleIds, viewRoleIds, canChangeEditRoles }`.
  `POST` to the same path with any of `editRoleIds`, `inboxRoleIds` and
  `viewRoleIds` changes them; it needs `edit`, and changing `editRoleIds` (the
  bot-master roles) also needs Manage Server, as on the settings page.
- Ticket notifications go to `inbox` and `edit` (and ticket staff) only.

---

## Notifications

The app can tell a server's staff about new ticket messages: a notification
when a member opens a ticket, and one for each new message a member writes in
an open ticket. Staff and system messages never notify. It shows the server's
name, the member and the first 180 characters of the message; iOS groups a
ticket's notifications, and a tap opens the conversation.

- **Who gets one:** every signed-in device with notifications turned on whose
  account may see that server's tickets at that moment (the same live check as
  for the app's requests, or a tickets staff role), unless that server is muted
  in the app's settings.
- **Turning it on:** the app asks the first time you open a server's Tickets
  tab; the app's settings have the switch and one per server. Signing out or
  revoking the device stops its notifications at once.

### How they reach the phone

An instance has three ways to notify a device, and picks one per device by what
that device's app sign-in holds. A newer app uses Postal Pigeon when this
instance offers it; an older app build keeps using the relay or the direct way,
so nobody loses notifications when an instance turns Pigeon on.

- **Postal Pigeon (`PIGEON_URL`):** [Postal Pigeon](https://github.com/Ferdinand99/Postal-Pigeon)
  is the Hedgerow push relay, `https://pigeon.hedgerow.tools`. `/api/mobile/info`
  names it (`pigeon`) and lists the feature `push-pigeon`. The **app** registers
  its device with Pigeon and gives your instance only a handle (`hrh_…`), so your
  instance never sees the device's push token. A notification then carries **no
  text**: your instance asks Pigeon to push to the handle, with a random
  reference and a collapse key (below), and Pigeon and Apple deliver a generic
  notification. That is all your instance gives Pigeon about a notification. The app's
  notification extension asks your instance for the text with that reference
  (`GET /api/mobile/push/events/:ref`), so the server name, the member's name and
  the message never go through Pigeon or Apple. The app only uses the official
  Pigeon; an instance that names another gets no notifications from it. Your
  instance registers itself with Pigeon when it starts, or else the first time it
  sends (a small proof of work, about a second, then a credential kept in its
  settings, sealed with a key derived from `SESSION_SECRET`), and only makes
  outgoing HTTPS requests. While it sends, it logs problems with Pigeon at debug
  level only, because the dev-log notifications go through Pigeon too.
  - Pigeon allows a device 6 notifications an hour, 3 at once. Your instance keeps
    to the same budget; a notification beyond it is dropped (the app lists the
    tickets when it is opened). Notifications for one ticket replace each other
    on the phone: the collapse key that does this is an HMAC-SHA256 of the
    sign-in and the ticket (or the dev log), with a key derived from
    `SESSION_SECRET` for this purpose alone. Pigeon sees an opaque value that
    cannot be traced to a server or a ticket without that secret, and that is
    different for each device.
  - A device Pigeon has not yet accepted a push for is sent to slowly (one a
    minute across all such devices, 3 an hour for one), so a made-up handle
    cannot use up the instance's allowance for unknown handles at Pigeon.
  - The text is kept for two hours (Apple stops trying after one) under the
    reference, and is only given to the app sign-in it was made for, only while
    that account may still see the ticket (operators only, for the dev log).
    Anything else, a reference that is unknown, expired or someone else's,
    is a `404`.
- **Off:** leave `PIGEON_URL` unset or empty. Nothing changes for the other two.

The two older ways, for app builds that do not know Pigeon. Apple only accepts
notifications for the Sylo app from whoever holds the app's push key, so a
self-hosted instance cannot send them to Apple itself. It sends them through the
hosted Sylo instead:

- **Self-hosted (the default):** `/api/mobile/info` names the relay
  (`pushRelay`, from `PUSH_RELAY_URL`, default `https://app.sylobot.com`). When
  notifications are turned on, the **app** registers the device with that relay
  itself and gives your instance only the relay token it got back, so your
  instance never sees the device's push token. Each notification goes from your
  instance to the relay, which passes it to Apple and keeps no copy of its text.
  The app only uses the hosted relay; an instance that names another one gets no
  notifications. Your instance only makes outgoing HTTPS requests; nothing needs
  to reach it from outside, and a login proxy in front of it needs no new rule.
- **Off:** set `PUSH_RELAY_URL` to an empty value. `/api/mobile/info` then
  leaves out `push` (which is what the older apps look for) and they say
  notifications aren't available. With `PIGEON_URL` set, apps that know Pigeon
  still get notifications.
- **The hosted Sylo** holds the key (`APNS_KEY_ID`, `APNS_TEAM_ID`,
  `APNS_PRIVATE_KEY`, `APNS_TOPIC`) and talks to Apple directly.

The relay only sends ticket and dev-log notifications in a fixed shape, at most 60 an hour
for one device (across all its registrations, at most 10), and forgets a registration when the app turns
notifications off, when Apple reports the device gone, or after 90 days
without use.

### Endpoints

| Method and path | Auth | Answer |
| --- | --- | --- |
| `POST /api/mobile/push` | Bearer token | `{ pigeonHandle, environment }` (Pigeon), `{ relayToken, environment }` (relay) or `{ deviceToken, environment }` (direct) → `{ ok: true }`; `400` `invalid_push_token`, or `relay_token_required` / `device_token_required` / `pigeon_handle_required` for the kind this instance does not take; `503` when this instance can't send |
| `GET /api/mobile/push/events/:ref` | Bearer token | The text of a Pigeon notification: `{ title, subtitle?, body, threadId, kind, data }`, no server address, `Cache-Control: no-store`. `404` for an unknown, expired or someone else's reference, or a ticket the account may no longer see. At most 30 a minute per sign-in |
| `GET /api/mobile/push` | Bearer token | `{ enabled, mutedServers }`, plus `devLog` for an operator |
| `PUT /api/mobile/push/dev-log` | Bearer token, operators only | `{ level: "off" \| "errors" \| "warnings" }` → `{ devLog }` |
| `PUT /api/mobile/push/servers/:guildId` | Bearer token | `{ muted }` → `{ mutedServers }` |
| `DELETE /api/mobile/push` | Bearer token | `204`; notifications off for this device |
| `POST /api/push-relay/v1/register` | None (called by the app) | `{ deviceToken, environment, instance }` → `{ relayToken }`; only on an instance with the APNs key |
| `POST /api/push-relay/v1/send`, `/unregister` | Relay token | Called by the instance; only on an instance with the APNs key |

## Health and the dev log (operators)

The people who run an instance, its operators (`OWNER_IDS` and
`FLUXER_OWNER_IDS`), get two more things in the app. Someone who only has Manage
Server never does: the app hides them, and the server answers `403` to anyone
else.

- **Health**, under Settings: whether the bot is up, its version, uptime,
  gateway ping, servers and members, the database and the latest backups, and
  the dev log. It is read only; backups are made, restored and downloaded from
  the web dashboard.
- **The dev log**: Sylo's own errors and warnings, stored in the database for
  30 days (the newest 500). It works with or without a dev-log channel
  (`DEV_LOG_CHANNEL_ID`); the channel still gets errors only.
- **Dev-log notifications**: each device chooses Off, Errors, or Errors and
  Warnings in the notification settings (Errors to begin with). A notification
  names the instance, the level and where in Sylo it happened, and a tap opens
  Health. The same message is sent at most once every 5 minutes.

| Method and path | Auth | Answer |
| --- | --- | --- |
| `GET /api/v2/health` | Operators only | The Health report |
| `GET /api/v2/dev-log?level=error&limit=100` | Operators only | `{ entries: [{ id, level, scope, message, at }] }`, newest first |
| `POST /api/v2/health/dev-log-test` | Operators only | Posts a test message to the dev-log channel; `{ ok }` or `{ ok: false, error }` |
| `GET /api/v2/account` | Bearer token or session | Includes `operator: true` for an operator |

---

## Security notes

- **PKCE S256 only.** The code is bound to the challenge from the start of the
  flow; without the matching verifier it is worthless.
- **Codes are single use and live 60 seconds.** Only their hash is stored, and
  a code is deleted on the first attempt to redeem it, right or wrong, so it
  cannot be guessed at or replayed.
- **The confirmation page stops login CSRF.** Without it, someone could send you
  a link that signs in as you in your browser and delivers the code to an app on
  their side. Allow is a POST with a per-flow nonce, and the app rejects a
  callback whose `state` it did not send.
- **Adding a login is finished by the app, not by the browser.** The link that opens the
  sheet is made for one account by one app token, so anyone can make one for their own
  account and send it to someone else. If the browser's login were linked on the spot,
  that person's Discord or Fluxer login (and the servers they manage, and operator
  rights if they have them) would end up on the attacker's account. So the callback
  links nothing: it keeps the verified login under a result code bound to the account and
  token of the connect code, and `sylo://connected?result=…` opens on the device of
  whoever is in the browser. Only the app holding that very token can complete the link;
  the victim's own app has another token and is refused. The confirmation page names the
  account and warns when the browser is signed in as somebody else, as defence in depth.
- **The codes.** Connect code and result code are 256 random bits each, stored only as a
  SHA-256 hash, deleted in the statement that reads them (so they work once, also under
  concurrency), and swept with expired tokens; a connect code lives 60 seconds, a result
  code 120. One live connect code per account. Both stop working when the token is signed
  out or revoked (checked when the sheet opens, at the callback and at completion), and
  they are deleted with the account.
- **No session, no open redirect.** The browser is never signed in or given a session; the
  only places it is sent are the platform's own login and `sylo://connected`, with a
  platform, result and error word that Sylo chose, never one from the request. One login
  per platform and account is a database rule (a unique index), so two completions at
  the same moment cannot give an account two logins; the loser gets `409`.
- **Tokens only work on `/api/` paths.** The HTML dashboard stays cookie-only,
  and a request that presents a token is judged by the token alone (a bad token
  never falls back to a cookie).
- **No CSRF token for bearer requests.** CSRF works because a browser attaches
  cookies to a cross-site request by itself. It never attaches an
  `Authorization` header by itself: a page would have to set it, which needs a
  CORS preflight, and Sylo answers no preflight and sends no CORS headers. A
  bearer request therefore cannot be forged from another site.
