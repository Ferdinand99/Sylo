/**
 * An on/off switch: <Switch checked={on} onChange={setOn} label="Enable logging" />.
 * A real <button role="switch"> (Space/Enter toggle it, screen readers hear
 * "Enable logging, switch, on"). `label` is required — it becomes the
 * accessible name; pass `labelledBy` instead when visible text already names it.
 * Looks like styles.css's .v2-toggle knob.
 */
export default function Switch({
  checked,
  onChange,
  label,
  labelledBy,
  describedBy,
  disabled,
  id,
  className = '',
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={Boolean(checked)}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      className={`v2-toggle v2-switch-btn${checked ? ' is-on' : ''}${className ? ` ${className}` : ''}`}
      onClick={() => onChange?.(!checked)}
    />
  );
}
