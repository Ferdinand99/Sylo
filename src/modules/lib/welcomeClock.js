// Pure helper for the Welcome module's "when a role starts counting" times, kept apart so the module
// storage (src/db/modules.js) can use it without importing the module itself.

/**
 * A welcome config with every listed trigger role stamped `now` in `triggerSince`, as when the mode was
 * just switched on. While Welcome is off its handlers do not run, so role gains in that time are never
 * seen; stamping again when it is switched back on keeps those members from being welcomed late, on
 * their next update of any kind (see the fallback in src/modules/welcome.js). A config that does not
 * welcome on roles is returned as it is.
 * @param {object} config
 * @param {number} [now]
 */
export function restartTriggerClock(config, now = Date.now()) {
  if (config?.trigger !== 'role' || !Array.isArray(config.triggerRoleIds)) return config;
  const ids = config.triggerRoleIds.filter((id) => typeof id === 'string' && /^\d{17,20}$/.test(id));
  return { ...config, triggerSince: Object.fromEntries(ids.map((id) => [id, now])) };
}
