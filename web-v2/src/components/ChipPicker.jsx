// Multi-select replacement for a native <select multiple> (which needs
// ctrl/cmd-click to pick more than one — not discoverable, flagged by the
// user). Selected items render as removable chips; a plain single-select
// dropdown adds more. Ports V1's chip-picker.ejs/chipPicker Alpine
// component to React with the same interaction shape.
export default function ChipPicker({ items, value, onChange, kind = 'role', placeholder }) {
  const selected = value || [];
  const selectedItems = selected.map((id) => items.find((i) => String(i.id) === String(id))).filter(Boolean);
  const available = items.filter((i) => !selected.includes(i.id));
  const defaultPlaceholder = kind === 'channel' ? '+ Add a channel…' : '+ Add a role…';

  function remove(id) {
    onChange(selected.filter((v) => v !== id));
  }

  function add(e) {
    const id = e.target.value;
    if (id) onChange([...selected, id]);
    e.target.value = '';
  }

  return (
    <div className="v2-chip-picker">
      <div className="v2-chip-row">
        {selectedItems.length === 0 ? <span className="v2-field-hint">None selected</span> : null}
        {selectedItems.map((item) => (
          <span className="v2-chip" key={item.id}>
            {kind === 'channel' ? (
              <span className="v2-chip-hash">#</span>
            ) : (
              <span className="v2-chip-dot" style={{ background: item.color || 'var(--text-muted)' }} />
            )}
            <span>{item.name}</span>
            <button
              type="button"
              className="v2-chip-x"
              aria-label={`Remove ${item.name}`}
              onClick={() => remove(item.id)}
            >
              &times;
            </button>
          </span>
        ))}
      </div>
      <select className="v2-chip-add" value="" onChange={add}>
        <option value="">{placeholder || defaultPlaceholder}</option>
        {available.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {kind === 'channel' ? '#' : ''}
            {opt.name}
          </option>
        ))}
      </select>
    </div>
  );
}
