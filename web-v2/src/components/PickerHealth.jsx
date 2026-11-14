import { useHealth } from '../HealthContext.jsx';
import { pickerWarnings } from '../healthModel.js';

/**
 * The note under a role or channel picker when Sylo cannot use the pick: "Sylo can't give this role: move
 * Sylo's role above it ..." It checks the picked value itself, so it warns before the form is saved.
 * Place it right after the picker, for a role Sylo gives or takes away (kind "role") or a channel Sylo
 * posts in (kind "channel"). `value` is the picked id, or the picked ids of a multi-select (then `items`
 * names the failing ones). `embed` is for a channel the module sends embeds in: only then does a missing
 * Embed Links count. Shows nothing when the pick is fine, or when the health is not known.
 */
export default function PickerHealth({ kind, value, items, embed = false }) {
  const warnings = pickerWarnings(useHealth()?.health, kind, value, items, { embed });
  if (!warnings.length) return null;
  return (
    <div className="v2-picker-warn" role="note" aria-live="polite">
      <span className="v2-picker-warn-mark" aria-hidden="true">
        !
      </span>
      <span>
        {warnings.map((text) => (
          <span key={text} className="v2-picker-warn-line">
            {text}
          </span>
        ))}
      </span>
    </div>
  );
}
