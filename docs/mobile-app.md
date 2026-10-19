# The Sylo app

A native iOS app (SwiftUI, source in `apps/sylo-ios`) that signs in to a Sylo
instance, the hosted one or your own, and manages your servers through the same
JSON API the new dashboard uses. This page covers what a self-hosted instance
needs for the app to work, and how the app's sign-in works for anyone reading or
reviewing it.

> **In TestFlight.** The app ("Sylo – Server Manager") is in public beta and not
> on the App Store yet. [Join the beta](https://testflight.apple.com/join/6FXxPjxu). The server side described here is part of Sylo; it does nothing
> until an app signs in.

- [What a self-hosted instance needs](#what-a-self-hosted-instance-needs)
- [Behind a proxy with its own login](#behind-a-proxy-with-its-own-login)
- [How sign-in works](#how-sign-in-works)
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

## Endpoints

| Method and path | Auth | Answer |
| --- | --- | --- |
| `GET /api/mobile/info` | None | What this server is (below) |
| `GET /auth/mobile/start` | None (browser) | Redirect to the login, or to the confirmation page |
| `GET /auth/mobile/confirm` | Browser session | The confirmation page |
| `POST /auth/mobile/confirm` | Browser session + nonce | Redirect to `sylo://auth?code=…&state=…` |
| `POST /api/mobile/token` | Code + verifier | `{ token, expiresAt, account }`, or `400 invalid_grant` |
| `DELETE /api/mobile/token` | Bearer token | `204`, or `401` without a valid token |
| `/api/v2/*` | Bearer token | The dashboard's JSON API |

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
| `features` | What this version's app API supports, for example `["app-login", "live-access"]`, so the app can hide what an older Sylo lacks |

An older Sylo without this endpoint answers `404`, and the app says the server
is too old for it.

On a token request, "not signed in" and "not allowed" are JSON, never a
redirect or an HTML page:

| Status | Body |
| --- | --- |
| `401` | `{ "error": "Not signed in, or the token is no longer valid." }` |
| `403` | `{ "error": "You do not manage this server." }` |
| `403` | `{ "error": "Restricted to Sylo's operators." }` |

The usual per-IP rate limits apply. On top of them, per minute: 60 calls to
`/api/mobile/info`, 30 to the `/auth/mobile` pages and 20 code exchanges.
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
- **Signed-in devices.** The account page (`/account` in the classic dashboard,
  **Account** in the new dashboard) lists each device with its name and last
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
  hold one of its bot-master roles. Someone who loses those rights loses access
  from the app at once. The bot has to be in the server. The live check only
  runs for a server that was in the stored list at sign-in, or that has
  bot-master roles set, so a token cannot make the bot look people up in every
  server it is in. This covers the ticket pages too.
- The server list (`GET /api/v2/guilds`) is the stored list filtered by the same
  live check. A server where you newly gained rights shows up after the next
  sign-in.
- Owner-only modules and bot-wide pages stay limited to `OWNER_IDS` /
  `FLUXER_OWNER_IDS`, the same as in the browser.

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

Apple only accepts notifications for the Sylo app from whoever holds the app's
push key, so a self-hosted instance cannot send them to Apple itself. It sends
them through the hosted Sylo instead:

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
  leaves out `push` and the app says notifications aren't available.
- **The hosted Sylo** holds the key (`APNS_KEY_ID`, `APNS_TEAM_ID`,
  `APNS_PRIVATE_KEY`, `APNS_TOPIC`) and talks to Apple directly.

The relay only sends ticket and dev-log notifications in a fixed shape, at most 60 an hour
for one device (across all its registrations, at most 10), and forgets a registration when the app turns
notifications off, when Apple reports the device gone, or after 90 days
without use.

### Endpoints

| Method and path | Auth | Answer |
| --- | --- | --- |
| `POST /api/mobile/push` | Bearer token | `{ relayToken, environment }` (relay) or `{ deviceToken, environment }` (direct) → `{ ok: true }`; `503` when this instance can't send |
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
- **Tokens only work on `/api/` paths.** The HTML dashboard stays cookie-only,
  and a request that presents a token is judged by the token alone (a bad token
  never falls back to a cookie).
- **No CSRF token for bearer requests.** CSRF works because a browser attaches
  cookies to a cross-site request by itself. It never attaches an
  `Authorization` header by itself: a page would have to set it, which needs a
  CORS preflight, and Sylo answers no preflight and sends no CORS headers. A
  bearer request therefore cannot be forged from another site.
