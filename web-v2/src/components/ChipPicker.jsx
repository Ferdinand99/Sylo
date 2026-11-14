import '../styles/wp5-lists.css';
import PickerHealth from './PickerHealth.jsx';

// Multi-select replacement for a native <select multiple> (which needs
// ctrl/cmd-click to pick more than one — not discoverable, flagged by the
// user). Selected items render as removable chips; a plain single-select
// dropdown adds more. While nothing is picked only the dropdown shows (no
// empty "None selected" box); once there are chips, the dropdown sits inline
// after the last one inside the same well. It is the same element either
// way, so the dropdown keeps its focus when the first chip is added.
// `health` ("role" or "channel") adds the note for each pick Sylo cannot use (PickerHealth): set it where
// Sylo gives the roles or posts in the channels, not where they are only allowed in or exempted.
export default function ChipPicker({ items, value, onChange, kind = 'role', placeholder, id, max, health }) {
  const selected = value || [];
  const selectedItems = selected.map((id) => items.find((i) => String(i.id) === String(id))).filter(Boolean);
  const available = items.filter((i) => !selected.includes(i.id));
  const full = max != null && selected.length >= max;
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
      <div className={`v2-chip-row${selectedItems.length === 0 ? ' is-bare' : ''}`}>
        {selectedItems.map((item) => (
          <span className="v2-chip" key={item.id}>
            {kind === 'channel' ? (
              <span className="v2-chip-hash">#</span>
            ) : (
              <span className="v2-chip-dot" style={{ background: item.color || 'var(--text-muted)' }} />
            )}
            <span className="v2-chip-name" title={item.name}>
              {item.name}
            </span>
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
        <select
          id={id}
          className="v2-chip-add"
          value=""
          disabled={full}
          onChange={add}
          aria-label={placeholder || (kind === 'channel' ? 'Add a channel' : 'Add a role')}
        >
          <option value="">{full ? `At most ${max} picked` : placeholder || defaultPlaceholder}</option>
          {available.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {kind === 'channel' ? '#' : ''}
              {opt.name}
            </option>
          ))}
        </select>
      </div>
      {health ? <PickerHealth kind={health} value={selected} items={items} /> : null}
    </div>
  );
}
