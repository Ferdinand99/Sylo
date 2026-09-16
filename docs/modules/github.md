# GitHub alerts

Post a repo's activity — pushes, releases, issues, pull requests, stars,
forks — to a channel. Unlike every other alert module, this one is
**push-based**: GitHub sends the event to Sylo the moment it happens, instead
of Sylo polling on a timer.

**Dashboard:** `/guilds/<id>/m/github`.

## Needs

- **Send Messages**, **Embed Links** in the target channel.
- `DASHBOARD_URL` set to a **public, reachable HTTPS URL** — GitHub has to be
  able to reach Sylo to deliver events. This only works on a deployment that's
  actually exposed to the internet (like the hosted instance); a self-host
  behind a private LAN with no reverse proxy can't use this module.
- No privileged intents.

## Settings

Each server can watch any number of repos. For each one:

- **Repo** — `owner/repo`, or paste the full `github.com/owner/repo` URL.
- **Channel** — where its activity is posted.
- **Ping role** — optional. Mentioned alongside every post from this watch.
- **Events** — which of these to announce: commits pushed, release published,
  issue opened/closed, pull request opened/merged/closed, repo starred, repo
  forked.

Saving a watch generates a unique **webhook URL** and **secret**. Paste both
into the repo's own **Settings → Webhooks → Add webhook** page on GitHub
(content type `application/json`, events "Send me everything" — Sylo filters
by the event types checked above regardless of what GitHub sends). GitHub
fires a **ping** event the instant the webhook is saved; Sylo posts a short
"connected" confirmation in the channel, so there's no separate test button.

**Regenerate secret** issues a new one — the old value in GitHub's webhook
settings stops working immediately, so update it there too.

## Notes

- Every inbound event is verified against its watch's own secret
  (`X-Hub-Signature-256`, HMAC-SHA256) before anything is trusted or posted —
  an unsigned or wrongly-signed request is rejected outright.
- Two different servers can watch the same public repo independently; each
  gets its own URL/secret pair, so neither needs to know the other's.
- A push with zero new commits (a branch/tag delete, some force-pushes) and a
  release being edited (rather than published) are received but intentionally
  not posted, to avoid noise.
- Pausing a watch (or disabling the module) still acknowledges GitHub's
  delivery — it's just not acted on — so GitHub never sees a failure and
  disables the webhook on its side.
