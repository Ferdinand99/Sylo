// The server mirror of this process: one engine, started by src/bot/events/mirror.js and used by the dashboard
// routes (src/web/routes/v2Mirror.js). See engine.js for how a copy runs.
import { createEngine } from './engine.js';

export const mirror = createEngine();
