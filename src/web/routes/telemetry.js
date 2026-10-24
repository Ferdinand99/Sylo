// GET /telemetry.js: the script both dashboards (V1's header partial, V2's index.html) load
// for error reports and visit counts. Public, so the login page reports too; it carries only
// what any page sends anyway (the DSN's public key). See lib/telemetry.js.
import { createRequire } from 'node:module';
import { Router } from 'express';
import { config } from '../../config.js';
import { telemetryScript, telemetrySettings } from '../lib/telemetry.js';

const { version } = createRequire(import.meta.url)('../../../package.json');

const settings = telemetrySettings({
  dsn: config.dashboardErrorDsn,
  visitStats: config.dashboardVisitStats,
  environment: config.dashboardErrorEnvironment,
  release: `sylo@${version}`,
});
if (config.dashboardErrorDsn && !settings) {
  console.error(
    '[config] DASHBOARD_ERROR_DSN is not a DSN (https://<public key>@<host>/<project id>); dashboard error reports are off.'
  );
}
const body = telemetryScript(settings);

const router = Router();

router.get('/', (_req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-cache').send(body);
});

export default router;
