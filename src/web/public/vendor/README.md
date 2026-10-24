# Vendored front-end libraries

Committed as static files (no build step). Served from `/vendor/…`.

| File            | Library   | Version | Source |
|-----------------|-----------|---------|--------|
| `htmx.min.js`   | htmx.org  | 2.0.4   | https://cdn.jsdelivr.net/npm/htmx.org@2.0.4/dist/htmx.min.js |
| `alpine.min.js` | Alpine.js | 3.14.8  | https://cdn.jsdelivr.net/npm/alpinejs@3.14.8/dist/cdn.min.js |
| `sentry.min.js` | @sentry/browser | 11.9.0 | https://browser.sentry-cdn.com/11.9.0/bundle.min.js (sha384-xE/bmsH+mppbFLN9Cj+Lyc7rR9sTBh9p6GEswhQcoZPRAZbv5k6MRfdRIGnB+azV) |

## Upgrading

```sh
curl -fsS -o src/web/public/vendor/htmx.min.js   https://cdn.jsdelivr.net/npm/htmx.org@<ver>/dist/htmx.min.js
curl -fsS -o src/web/public/vendor/alpine.min.js https://cdn.jsdelivr.net/npm/alpinejs@<ver>/dist/cdn.min.js
curl -fsS -o src/web/public/vendor/sentry.min.js https://browser.sentry-cdn.com/<ver>/bundle.min.js
```

Then bump the versions in this table, test the dashboard, and commit.
