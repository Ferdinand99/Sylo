import { useHealth } from '../HealthContext.jsx';
import { moduleChecks } from '../healthModel.js';
import Callout from './Callout.jsx';

/**
 * The permission and role-hierarchy problems of one module, at the top of its settings page: what Sylo
 * cannot do with the channels and roles the module is set up to use, and what to do about it. It shows
 * nothing while all is well (or while the module is off, which the server does not check), and has a
 * "Check again" button for after the fix.
 */
export default function ModuleHealth({ moduleId }) {
  const ctx = useHealth();
  const checks = moduleChecks(ctx?.health, moduleId);
  if (!checks.length) return null;
  return (
    <Callout tone="warning" title="Sylo can't do everything this module needs" className="v2-module-health">
      <ul className="v2-module-health-list">
        {checks.map((c, i) => (
          <li key={`${c.code}-${c.targetId ?? c.permission ?? i}`}>
            <strong>{c.message}</strong> <span>{c.fix}</span>
          </li>
        ))}
      </ul>
      <button type="button" className="v2-btn-ghost v2-module-health-recheck" onClick={ctx.recheck}>
        Check again
      </button>
    </Callout>
  );
}
