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
  // A page's address can carry a credential in its query or fragment (the OAuth error page has
  // ?code= and ?state=, verify and appeal links have ?t=). Reports keep the path only.
  function scrubUrl(u) {
    if (typeof u !== 'string' || !u) return u;
    try {
      var x = new URL(u, window.location.href);
      return x.origin + x.pathname;
    } catch (e) {
      return u.split(/[?#]/)[0];
    }
  }
  function scrubCrumb(b) {
    if (!b) return b;
    var d = b.data;
    if (d) {
      ['url', 'from', 'to'].forEach(function (k) {
        if (typeof d[k] === 'string') d[k] = scrubUrl(d[k]);
      });
    }
    if (typeof b.message === 'string') b.message = b.message.replace(/([?&][^=\\s&#]+=)[^&\\s#]*/g, '$1***');
    return b;
  }
  load('/vendor/sentry.min.js', {}, function () {
    if (!window.Sentry) return;
    window.Sentry.init({
      dsn: c.dsn,
      release: c.release,
      environment: c.environment,
      sendDefaultPii: false,
      denyUrls: [/^chrome-extension:/i, /^moz-extension:/i, /^safari-(web-)?extension:/i],
      beforeBreadcrumb: scrubCrumb,
      beforeSend: function (event) {
        if (event.request) {
          if (event.request.url) event.request.url = scrubUrl(event.request.url);
          delete event.request.query_string;
          if (event.request.headers) {
            delete event.request.headers.Referer;
            delete event.request.headers.referer;
            delete event.request.headers.Cookie;
          }
        }
        var crumbs = event.breadcrumbs;
        if (crumbs) (Array.isArray(crumbs) ? crumbs : crumbs.values || []).forEach(scrubCrumb);
        return event;
      },
      initialScope: {
        tags: { component: 'dashboard', dashboard: 'v2' }
      }
    });
  });
  if (c.visits) load(c.visits.src, { 'data-key': c.visits.key });
})();
`;
}
