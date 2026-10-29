# Vendored front-end libraries

Committed as static files (no build step). Served from `/vendor/…`.

| File            | Library         | Version | Source                                                                                                                                         |
| --------------- | --------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `sentry.min.js` | @sentry/browser | 11.9.0  | https://browser.sentry-cdn.com/11.9.0/bundle.min.js (sha384-xE/bmsH+mppbFLN9Cj+Lyc7rR9sTBh9p6GEswhQcoZPRAZbv5k6MRfdRIGnB+azV) |

`/telemetry.js` loads it when `DASHBOARD_ERROR_DSN` is set.

## Upgrading

```sh
curl -fsS -o src/web/public/vendor/sentry.min.js https://browser.sentry-cdn.com/<ver>/bundle.min.js
```

Then bump the version in this table, test the dashboard, and commit.
