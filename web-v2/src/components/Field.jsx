import { Children, cloneElement, isValidElement, useId } from 'react';

/**
 * One labelled form control, wired up for assistive tech without the
 * after-the-fact patching useLabelLinks.js does:
 *
 *   <Field label="Channel" hint="Where alerts are posted" error={errors.channel}>
 *     <select value={…} onChange={…}>…</select>
 *   </Field>
 *
 * The single child gets an `id` (unless it has one), `aria-describedby`
 * pointing at the hint / error, and `aria-invalid` while `error` is set.
 * `labelNote` renders muted after the label ("— optional"). For a custom
 * control that isn't a native input (ChipPicker), pass `group` to get a
 * role="group" labelled by the label text instead of a <label for>.
 */
export default function Field({ label, labelNote, hint, error, group = false, className = '', children }) {
  const auto = useId();
  const child = Children.only(children);
  const id = (isValidElement(child) && child.props.id) || `f${auto}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const labelId = `${id}-label`;
  const describedBy =
    [child.props['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;

  const labelContent = (
    <>
      {label}
      {labelNote ? <span className="v2-field-hint"> {labelNote}</span> : null}
    </>
  );

  if (group) {
    return (
      <div
        className={`v2-field${error ? ' is-invalid' : ''}${className ? ` ${className}` : ''}`}
        role="group"
        aria-labelledby={labelId}
        aria-describedby={describedBy}
      >
        <label id={labelId}>{labelContent}</label>
        {child}
        {hint ? (
          <p id={hintId} className="v2-field-hint">
            {hint}
          </p>
        ) : null}
        {error ? (
          <p id={errorId} className="v2-field-error">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`v2-field${error ? ' is-invalid' : ''}${className ? ` ${className}` : ''}`}>
      <label id={labelId} htmlFor={id}>
        {labelContent}
      </label>
      {cloneElement(child, {
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : child.props['aria-invalid'],
      })}
      {hint ? (
        <p id={hintId} className="v2-field-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="v2-field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
