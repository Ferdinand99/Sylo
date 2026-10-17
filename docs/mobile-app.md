# The Sylo app

A native iOS app (SwiftUI, source in `apps/sylo-ios`) that signs in to a Sylo
instance, the hosted one or your own, and manages your servers through the same
JSON API the new dashboard uses. This page covers what a self-hosted instance
needs for the app to work, and how the app's sign-in works for anyone reading or
reviewing it.

> **In development.** The app is not on the App Store yet. The server side
> described here is part of Sylo; it does nothing until an app signs in.

- [What a self-hosted instance needs](#what-a-self-hosted-instance-needs)
- [Behind a proxy with its own login](#behind-a-proxy-with-its-own-login)
- [How sign-in works](#how-sign-in-works)
- [Endpoints](#endpoints)
- [Tokens and signed-in devices](#tokens-and-signed-in-devices)
- [Permissions](#permissions)
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

For example, in Pangolin add resource rules with the action **Always Allow**
for the paths `/api/mobile/*` and `/api/v2/*`; in Cloudflare Access add a second application for
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
  - a sign-in (Discord or Fluxer) is disconnected from the account: this revokes
    all of the account's app tokens, and the app has to sign in again,
  - it has not been used for 90 days.

Token lookups are not cached, so a revocation counts on the next request.

---

## Permissions

The app has exactly the rights the web dashboard gives the same person. The one
difference is how server access is checked:

- The web dashboard uses the server list stored at login and refreshes it by
  re-running the platform login about every 10 minutes. The app cannot do that
  in the background.
- So for app requests Sylo checks **live, through the bot, on every request**:
  the person must own the server, have Manage Server or Administrator there, or
  hold one of its bot-master roles. Someone who loses those rights loses access
  from the app at once. The bot has to be in the server.
- The server list (`GET /api/v2/guilds`) is the stored list filtered by the same
  live check. A server where you newly gained rights shows up after the next
  sign-in.
- Owner-only modules and bot-wide pages stay limited to `OWNER_IDS` /
  `FLUXER_OWNER_IDS`, the same as in the browser.

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
