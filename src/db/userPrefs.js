// The user_prefs table once held a per-account dashboard-version choice (classic vs the new
// dashboard). The classic dashboard is gone and nothing reads or writes the column any more; the
// table stays because migrations only go forward, and account deletion still clears a row
// (src/db/accounts.js).
import { registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS user_prefs (
    user_id           TEXT PRIMARY KEY,
    dashboard_version TEXT NOT NULL DEFAULT 'v1',
    updated_at        BIGINT NOT NULL
  );
`);
