# Vendored front-end libraries

Committed as static files (no build step). Served from `/vendor/…`.

| File            | Library   | Version | Source |
|-----------------|-----------|---------|--------|
| `htmx.min.js`   | htmx.org  | 2.0.4   | https://cdn.jsdelivr.net/npm/htmx.org@2.0.4/dist/htmx.min.js |
| `alpine.min.js` | Alpine.js | 3.14.8  | https://cdn.jsdelivr.net/npm/alpinejs@3.14.8/dist/cdn.min.js |

## Upgrading

```sh
curl -fsS -o src/web/public/vendor/htmx.min.js   https://cdn.jsdelivr.net/npm/htmx.org@<ver>/dist/htmx.min.js
curl -fsS -o src/web/public/vendor/alpine.min.js https://cdn.jsdelivr.net/npm/alpinejs@<ver>/dist/cdn.min.js
```

Then bump the versions in this table, test the dashboard, and commit.
