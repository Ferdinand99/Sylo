import { useId } from 'react';

/**
 * A narrow number field with its unit after it: [ 90 ] days. For values of a few digits, where
 * a full-width field looks wrong. Takes the props of an <input type="number"> (id, value,
 * onChange, min, max, …) plus `unit`; wire the label with the usual htmlFor/id. The unit is also
 * announced as part of the field's description. `wide` allows a little more room (5-6 digits).
 *   <label htmlFor="days">Delete after</label>
 *   <UnitInput id="days" unit="days" value={n} onChange={…} min={1} max={365} />
 * Without a unit, use the .v2-input-num class on a plain input.
 */
export default function UnitInput({
  unit,
  wide = false,
  className = '',
  'aria-describedby': describedBy,
  ...rest
}) {
  const unitId = useId();
  const ids = [describedBy, unit ? unitId : null].filter(Boolean).join(' ') || undefined;
  return (
    <span className="v2-input-unit">
      <input
        {...rest}
        type="number"
        className={`v2-input-num${wide ? ' v2-input-num-wide' : ''}${className ? ` ${className}` : ''}`}
        aria-describedby={ids}
      />
      {unit ? (
        <span className="v2-input-unit-label" id={unitId}>
          {unit}
        </span>
      ) : null}
    </span>
  );
}
