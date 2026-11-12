// One question of an application form, as the member sees it: used by the web form (pages/Apply.jsx)
// and by the preview in the forms editor. `value` is a string for text and yes/no, a list of option ids
// for a choice or a role question.
export default function ApplicationQuestion({ q, value, onChange, error, disabled = false, idPrefix = 'q' }) {
  const id = `${idPrefix}-${q.id}`;
  const optional = q.required ? null : <span className="v2-field-hint"> (optional)</span>;

  let input;
  if (q.type === 'text') {
    const common = {
      id,
      value: value ?? '',
      maxLength: q.maxLength,
      disabled,
      'aria-invalid': Boolean(error),
      'aria-describedby': error ? `${id}-error` : undefined,
      onChange: (e) => onChange(e.target.value),
    };
    input = q.long ? (
      <>
        <textarea rows={6} {...common} />
        <p className="v2-field-hint">
          {String(value ?? '').length} / {q.maxLength}
          {q.minLength > 0 ? ` (at least ${q.minLength})` : ''}
        </p>
      </>
    ) : (
      <input type="text" {...common} />
    );
  } else if (q.type === 'yesno') {
    input = (
      <div className="v2-field-row" role="radiogroup" aria-labelledby={`${id}-label`}>
        {['yes', 'no'].map((v) => (
          <label className="v2-check" key={v}>
            <input
              type="radio"
              name={id}
              checked={value === v}
              disabled={disabled}
              onChange={() => onChange(v)}
            />
            {v === 'yes' ? 'Yes' : 'No'}
          </label>
        ))}
      </div>
    );
  } else {
    const chosen = Array.isArray(value) ? value : [];
    const toggle = (optionId) => {
      if (q.multiple) {
        onChange(chosen.includes(optionId) ? chosen.filter((x) => x !== optionId) : [...chosen, optionId]);
      } else {
        onChange([optionId]);
      }
    };
    input = (
      <div role={q.multiple ? 'group' : 'radiogroup'} aria-labelledby={`${id}-label`}>
        {q.options.map((o) => (
          <label className="v2-check" key={o.id} style={{ display: 'flex' }}>
            <input
              type={q.multiple ? 'checkbox' : 'radio'}
              name={id}
              checked={chosen.includes(o.id)}
              disabled={disabled}
              onChange={() => toggle(o.id)}
            />
            {o.label || 'A role'}
          </label>
        ))}
        {!q.multiple && !q.required && chosen.length > 0 ? (
          <button type="button" className="v2-btn-ghost" disabled={disabled} onClick={() => onChange([])}>
            Clear
          </button>
        ) : null}
        {q.multiple ? (
          <p className="v2-field-hint">
            {q.minChoices > 0
              ? `Choose ${q.minChoices} to ${q.maxChoices}.`
              : `Choose up to ${q.maxChoices}.`}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="v2-field">
      <label id={`${id}-label`} htmlFor={q.type === 'text' ? id : undefined}>
        {q.label}
        {optional}
      </label>
      {q.help ? <p className="v2-field-hint">{q.help}</p> : null}
      {input}
      {error ? (
        <p id={`${id}-error`} className="v2-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
