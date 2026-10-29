// Error reports and visit counts from the dashboard's pages, for the hosted Sylo.
// The dashboard loads /telemetry.js (routes/telemetry.js), which is built here: with
// DASHBOARD_ERROR_DSN set it loads the vendored Sentry browser SDK (public/vendor/sentry.min.js)
// and sends uncaught errors to that DSN (Keen Kestrel or Sentry); with DASHBOARD_VISIT_STATS
// too, it loads Keen Kestrel's k.js, which counts page views without cookies. Without the DSN
// the script does nothing, so a self-hosted instance sends nothing anywhere unless its
// operator sets one.

/**
 * A DSN's parts, or null when `raw` isn't one: `https://<public key>@<host>[/path]/<project id>`.
 * `envelope` is where its error reports go.
 * @param {string | null | undefined} raw
 * @returns {{ dsn: string, key: string, origin: string, envelope: string } | null}
 */
export function parseDsn(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const project = parts.pop();
  if (!/^[0-9a-f]{16,64}$/i.test(url.username) || url.password || !/^\d+$/.test(project ?? '')) {
    return null;
  }
  const prefix = parts.length ? `/${parts.join('/')}` : '';
  return {
    dsn: raw,
    key: url.username,
    origin: url.origin,
    envelope: `${url.origin}${prefix}/api/${project}/envelope/`,
  };
}

/**
 * What /telemetry.js does on this instance, or null when it does nothing.
 * @param {{ dsn: string | null, visitStats: boolean, environment: string, release: string }} opts
 */
export function telemetrySettings({ dsn, visitStats, environment, release }) {
  const parsed = parseDsn(dsn);
  if (!parsed) return null;
  return {
    dsn: parsed.dsn,
    environment,
    release,
    // k.js takes the same public key as the DSN and lives on the same Keen Kestrel.
    visits: visitStats ? { src: `${parsed.origin}/js/k.js`, key: parsed.key } : null,
  };
}

const OFF = '// Error reports and visit counts are off on this instance.\n';

/**
 * The script both dashboards load.
 * @param {ReturnType<typeof telemetrySettings>} settings
 */
export function telemetryScript(settings) {
  if (!settings) return OFF;
  const c = JSON.stringify(settings).replace(/</g, '\\u003c');
  return `(function () {
  var c = ${c};
  function load(src, attrs, onload) {
    var s = document.createElement('script');
    s.src = src;
    s.async = true;
    for (var k in attrs) s.setAttribute(k, attrs[k]);
    if (onload) s.onload = onload;
    document.head.appendChild(s);
  }
  load('/vendor/sentry.min.js', {}, function () {
    if (!window.Sentry) return;
    window.Sentry.init({
      dsn: c.dsn,
      release: c.release,
      environment: c.environment,
      sendDefaultPii: false,
      initialScope: {
        tags: { component: 'dashboard', dashboard: 'v2' }
      }
    });
  });
  if (c.visits) load(c.visits.src, { 'data-key': c.visits.key });
})();
`;
}
