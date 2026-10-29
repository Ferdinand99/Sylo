# Security review, October 2026

Date: 29 October 2026. Covers Sylo 5.0 (the `v5` branch, from `e9eeca1`). The fixes are on the same branch.

## Method and limits

This was a read-only code review. It was not an external audit and it was not done by a professional security firm.
The reviewer read the code, traced each candidate finding to the lines that cause it, tried to refute it, and rated
it. Two throwaway probe scripts were run against the real Express application (the test harness with a temporary
database) to confirm the one Medium finding, and `npm audit --omit=dev` was run. No live instance was tested, and no
fuzzing, load test or scanner other than `npm audit` was used. Each fix below was written with tests.

Treat this as one careful review, not as a guarantee.

## Scope

The dashboard and its APIs (`/api/v2`, the mobile API and the push relay), sign-in (OAuth for Discord and Fluxer,
sessions, CSRF, app tokens), the public pages (leaderboard, quote board, verify, appeal), the inbound webhooks (GitHub
and YouTube WebSub), the bot-side modules that post to channels (mentions, role grants, hierarchy), outbound fetches
(the SSRF guard), data deletion (`/forget`, `/mydata`), error reporting, and the production dependencies.

The attackers considered were an anonymous internet client, a signed-in member of a server, a bot master (a role that
may use the dashboard without Manage Server), and a server administrator acting beyond their own server.

Held up in review: authorisation on every `/api/v2` route (guild-scoped lookups, live permission re-checks, owner-only
routes), CSRF (same-origin check, header token, narrow exempt list), OAuth (single-use state, session rotation,
internal-only `returnTo`), the mobile sign-in (PKCE, nonce, single-use codes, hashed tokens), webhook signature
checks, the SSRF guard for user-typed URLs, escaping on the public pages and their Content Security Policy, and the
absence of user-controlled regular expressions and string-built SQL. `npm audit --omit=dev` reported 0
vulnerabilities.

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| M-1 | Medium | Any malformed or oversized request body became an error alert (dev-log channel, operator phones, `/health`, error reports) | Fixed |
| L-1 | Low | Bot masters could make Sylo ping `@everyone`, `@here` or any role through a reminder | Fixed |
| L-2 | Low | The public quote page kept showing a quote after its channel became private | Fixed for channel changes. Deleted messages: accepted, see below |
| L-3 | Low | The public leaderboard answered differently for an unknown server, leveling off and the page off | Fixed. Public by default: accepted, see below |
| L-4 | Low | `/forget` and `/mydata` missed some columns that hold a user id | Fixed. Staff-side moderation columns kept on purpose |
| L-5 | Low | The dashboard error reports carried page addresses with codes and tokens; bot log redaction was narrow | Fixed |
| L-6 | Low | A few addresses could use up the push relay's shared hourly registration budget | Fixed |
| L-7 | Low | A device token is the only credential for push, so re-registering it moves it | Accepted, see below. Moves are now logged |
| L-8 | Low | The default `trust proxy` believes any private peer, which includes the Docker bridge | Documented and warned about. Default kept: accepted, see below |
| L-9 | Low | `undici` was a development dependency but imported at run time by the SSRF guard | Fixed |
| L-10 | Low | Unbounded response reads for changelog and YouTube fetches | Fixed |
| I-1 | Info | One session secret signs both the cookie and the verify and appeal link tokens | Accepted: different primitives and inputs |
| I-2 | Info | Verify and appeal link tokens travel in the query string | Accepted: referrer policy limits leakage to proxy logs |
| I-3 | Info | The Markdown renderer put generated markup inside `href` | Fixed (cosmetic) |
| I-4 | Info | `/health` and `/metrics` are public on the hosted instance | Accepted: by design, rate limited, no secrets |
| I-5 | Info | Off-site backups are plaintext unless `BACKUP_ENCRYPTION_KEY` is set | Accepted: documented, the operator's choice |
| I-6 | Info | No replay protection on GitHub deliveries; an app token can delete the account | Accepted |

### What was changed

- **M-1.** Body-parser errors that are the client's mistake (a body over the cap, invalid JSON) now answer 413 or 400
  and are logged at debug level only, so they no longer reach the dev-log channel, push notifications, `/health` or the
  error report sink. A real server fault is logged with the route pattern (for example `POST /webhooks/github/:token`),
  never the path the client sent, so each request no longer produces a unique message and a webhook token is never
  written to an error. The debug request log masks the GitHub webhook token as well. The global rate limit (300 a
  minute per client) now runs before the body parsers, so a flood of junk bodies is limited, and the GitHub webhook
  answers 413 over its cap as the YouTube one already did. A test sends 60 malformed and oversized requests and checks
  that no error-level event, dev-log event or error-history entry is produced and that the token never appears in a
  log line.
- **L-1.** Reminders post with `allowedMentions: { parse: [] }` unless a new Reminders setting, "Let reminders ping
  @everyone, @here and roles", is on: then `@everyone`, `@here` and role mentions in the text notify, as before. The
  setting is on for a server that already had reminders when it upgraded, so nothing changes for it, and off for new
  servers. Only the server owner or someone with Manage Server (checked live) can change it; a bot master is
  refused with a 403.
- **L-2.** When the public quote page is drawn, each channel its quotes came from is checked again for public
  visibility (not readable by `@everyone`, age-restricted, or a private thread hides it). The answer is cached for two
  minutes per channel; there is no background job. Hidden quotes are not listed and not counted. A channel Sylo cannot
  find (deleted, or an archived thread that is not cached) keeps the verdict the quote was saved with.
- **L-3.** Every not-found variant of the leaderboard (malformed id, a server Sylo is not in, a Fluxer id, leveling off,
  the page switched off, an unused or hidden vanity link) now returns the same 404 page, byte for byte, as the quote
  page already did.
- **L-4.** `/forget` now also takes the member off `polls.created_by`, `giveaways.host_id` and
  `temp_voice_channels.owner_id` (the poll, giveaway and channel stay, with no owner), deletes their
  `verification_kicks` row, and removes their id from `tickets.closed_by` and `appeals.decided_by`. All of these are
  listed by `/mydata` and the dashboard. A test lists every column in the schema that holds a user id and fails for a
  new one that is not handled, kept on purpose, or account data; the Postgres purge test covers the same columns.
- **L-5.** The dashboard's error reporting now strips the query string and fragment from the page address, from
  request and breadcrumb addresses, and removes the `Referer` and `Cookie` headers, and ignores browser-extension
  scripts. On the bot side, log redaction also masks secrets in query strings (`token`, `key`, `secret`, `code`, `t`,
  and similar), `Authorization`-like header values, bearer tokens and `sylo_` tokens. RSS error lines name the feed's
  host instead of its full address.
- **L-6.** One client (an IPv4 address or an IPv6 /64) may register 60 new devices an hour and is refused past that. Only
  a client's first 10 registrations an hour count against the shared 5000 an hour budget, so a few addresses at their
  own cap use at most 10 each of it. A warning is logged, at most once an hour, when the shared budget runs out.
- **L-8.** `docs/self-hosting.md` has a new section, "Set `TRUST_PROXY` explicitly", that explains the risk and the three
  ways to close it, and Sylo logs a warning at startup when the default is in force with a public https
  `DASHBOARD_URL`.
- **L-9.** `undici` is a runtime dependency, pinned to 8.12.2, the version the tests use. Note that this version needs
  Node 22.19 or later; the Docker image uses `node:22-alpine`.
- **L-10.** The GitHub changelog fetch is read up to 2 MB, and the YouTube channel lookup, feed and live check up to
  3 MB, using the byte-capped reader from the SSRF guard's module. Larger bodies are dropped.
- **I-3.** `*` and `_` inside a link address are written as entities, so no markup is generated inside an `href`.

## Accepted and open items

- **L-2, deleted messages, accepted.** A quote is not hidden when its source message is deleted, and the default
  `saveMode` (anyone can save another member's message) is unchanged. A quote is a copy the server chose to keep, and a
  moderator can remove it from the dashboard or with `/quote remove`. Hiding on `messageDelete` would also need the
  bot to see every deletion (and the message content intent), which was out of scope.
- **L-3, public by default, accepted.** The leaderboard stays public when Leveling is on, because servers rely on it.
  It shows display names, avatars and XP, no ids. A server turns it off in the Leveling settings.
- **L-4, staff-side columns, kept on purpose.** `infractions.moderator_id` (the moderation cases themselves are kept,
  and `/mydata` now lists a moderator's actions) and `config_audit.actor` (a display name in the server's config log,
  not an id). A completed giveaway's winner list is also kept: it was announced in the channel.
- **L-7, device token is the only credential for push, accepted.** Moving a device token from one app token to another
  is also what a device signing in again does, and the previous app token may be lost, so the old token cannot be
  required. The hardening suggested in the review, a random per-install identifier that must match when a token moves,
  needs a change in the iOS app and the push protocol, so it is not done here. The attack needs the victim's APNs
  device token, which is not guessable and is known only to Apple, the app and the instance. Moves are now logged at
  info level (without the token) so a pattern can be seen.
- **L-8, default `trust proxy`, accepted.** Changing the default would break self-hosted installs with a reverse proxy in a
  neighbouring Docker container, which is the common setup. Operators are told in the docs and at startup, and can
  set `TRUST_PROXY` or publish the port on the loopback address only.
- **SSRF block list.** 6to4 (`2002::/16`) and Teredo (`2001::/32`) addresses, which embed an IPv4 address, are not in the
  block list. They are only reachable when the host routes them. Not changed.
- **Feed parsing.** `src/bot/lib/feed.js` scans for each start tag with a bounded pattern, so there is no catastrophic
  backtracking, only repeated scanning over a body already capped at 4 MB. Not changed.
- **Dev-log throttle.** The dev-log throttle is still keyed by scope and message. With M-1 fixed, anonymous requests
  can no longer create unique messages, so normalising the key was not needed.
- **I-1, I-2, I-4, I-5, I-6.** Left as they are, for the reasons in the table. The suggestions (separate keys for cookies and
  links, a POST-only link exchange, a bearer token for `/metrics`, mandatory backup encryption for the webhook target,
  a delivery-id check for GitHub, a fresh confirmation for account deletion) are reasonable future hardening.

## Not covered

- Development dependencies (`npm audit --omit=dev` was the only dependency check) and the build and release pipeline.
- The Sylo iOS app and the Fluxer platform itself; the review read how Sylo talks to them.
- The PostgreSQL driver paths beyond the statements in the files reviewed, and the migration scripts.
- Any particular deployment: firewall, proxy configuration, volume permissions, the Docker image beyond its build file.
- Dynamic behaviour beyond the two probes: no load or fuzz testing, and no test against the live Discord and Fluxer
  APIs.
- The text content of translations and templates beyond escaping.

## Notes for operators

- **Reminders and pings.** A server that already had reminders keeps pinging as before. For new servers a reminder
  that contains `@everyone`, `@here` or a role mention shows the text but notifies nobody until someone with Manage
  Server turns pings on in the Reminders module settings.
- **Rate limit.** The 300 requests a minute per client limit now also counts the public pages (health, leaderboard, quotes,
  verify, appeal, roadmap) because it runs before the body parsers. Normal use is far below it.
- **Behind a reverse proxy**, set `TRUST_PROXY` to the proxy's address. See "Behind a reverse proxy" in
  `docs/self-hosting.md`. Sylo warns at startup when it is not set and `DASHBOARD_URL` is a public https address.
- **Push relay.** One client can register 60 devices an hour; the shared budget is unchanged at 5000 an hour.
- **`/forget`** now also clears the member from polls, giveaways, temporary voice channels, verification deadlines, and
  the staff-side ticket and appeal columns. A temporary voice channel left without an owner passes to the next member
  in it, as when an owner leaves.
