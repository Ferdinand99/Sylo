import { useEffect, useRef, useState } from 'react';
import { readRecentColors, addRecentColor } from '../util.js';

const HEX_RE = /^#[0-9a-f]{6}$/i;

// A reasonable round default palette — not lifted from any specific
// product's exact values, just the same "curated preset row" idea every
// colour picker has.
const PRESETS = [
  '#99aab5',
  '#5865f2',
  '#eb459e',
  '#ed4245',
  '#e67e22',
  '#f1c40f',
  '#2ecc71',
  '#1abc9c',
  '#3498db',
  '#9b59b6',
];

// Native <details>/<summary> for open/close, same outside-click/Escape
// pattern as ServerSwitcher.jsx — each instance is independent, so this
// works fine with one embed card per colour, no shared state needed.
export default function ColorPicker({ value, onChange, title }) {
  const detailsRef = useRef(null);
  const nativeRef = useRef(null);
  const [hexDraft, setHexDraft] = useState(value);

  useEffect(() => setHexDraft(value), [value]);

  function close() {
    if (detailsRef.current) detailsRef.current.open = false;
  }

  useEffect(() => {
    function onDocClick(e) {
      if (detailsRef.current?.open && !detailsRef.current.contains(e.target)) close();
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  function pick(color, closeAfter = true) {
    onChange(color);
    addRecentColor(color);
    if (closeAfter) close();
  }

  function onHexInput(raw) {
    setHexDraft(raw);
    const withHash = raw.startsWith('#') ? raw : `#${raw}`;
    if (HEX_RE.test(withHash)) pick(withHash, false);
  }

  const recent = readRecentColors().filter((c) => !PRESETS.includes(c));

  return (
    <details className="v2-colorpicker" ref={detailsRef}>
      <summary
        className="v2-colorpicker-swatch"
        style={{ background: value }}
        title={title || 'Embed colour'}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="13.5" cy="6.5" r="0.6" fill="currentColor" />
          <circle cx="17.5" cy="10.5" r="0.6" fill="currentColor" />
          <circle cx="8.5" cy="7.5" r="0.6" fill="currentColor" />
          <circle cx="6.5" cy="12.5" r="0.6" fill="currentColor" />
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1a1.6 1.6 0 0 1 1.7-1.7h2c3 0 5.5-2.5 5.5-5.6C22 6 17.5 2 12 2z" />
        </svg>
      </summary>
      <div className="v2-colorpicker-panel">
        <div className="v2-colorpicker-label">Discord colors</div>
        <div className="v2-colorpicker-row">
          {PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              className="v2-colorpicker-dot"
              style={{ background: c }}
              title={c}
              onClick={() => pick(c)}
            />
          ))}
        </div>

        {recent.length > 0 ? (
          <>
            <div className="v2-colorpicker-label">History</div>
            <div className="v2-colorpicker-row">
              {recent.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="v2-colorpicker-dot"
                  style={{ background: c }}
                  title={c}
                  onClick={() => pick(c)}
                />
              ))}
            </div>
          </>
        ) : null}

        <div className="v2-colorpicker-footer">
          <button
            type="button"
            className="v2-colorpicker-more"
            style={{ background: value }}
            title="More colours…"
            onClick={() => nativeRef.current?.click()}
          />
          <input
            type="text"
            className="v2-colorpicker-hex"
            value={hexDraft}
            maxLength={7}
            onChange={(e) => onHexInput(e.target.value)}
          />
          <input
            ref={nativeRef}
            type="color"
            className="v2-colorpicker-native"
            value={HEX_RE.test(value) ? value : '#5865f2'}
            onChange={(e) => pick(e.target.value, false)}
            tabIndex={-1}
          />
        </div>
      </div>
    </details>
  );
}
