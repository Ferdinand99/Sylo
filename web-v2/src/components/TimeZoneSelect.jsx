import '../styles/wp5-lists.css';

// Zones that are always offered, whatever the browser lists: some browsers leave out zones that are only a
// link in the time zone database (Europe/Oslo is one), and one without Intl.supportedValuesOf lists none.
const COMMON = [
  'UTC',
  'Europe/Oslo',
  'Europe/Stockholm',
  'Europe/Copenhagen',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Amsterdam',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Helsinki',
  'Europe/Warsaw',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Sao_Paulo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

function allZones() {
  let listed;
  try {
    listed = Intl.supportedValuesOf('timeZone');
  } catch {
    listed = [];
  }
  return [...new Set([...COMMON, ...listed])].sort((a, b) => {
    if (a === 'UTC') return -1;
    if (b === 'UTC') return 1;
    return a.localeCompare(b);
  });
}

// "America/Argentina/Buenos_Aires" belongs to the group "America"; a zone without a slash (UTC) stands alone.
const region = (zone) => (zone.includes('/') ? zone.slice(0, zone.indexOf('/')) : '');

/**
 * A select of the IANA time zones, grouped by region ("Europe", "America" …). The zone the setting
 * already has is always in the list, even when this browser does not list it, so opening a saved value
 * never changes it. A native select is searchable by typing the start of a name ("Eur…").
 *
 *   <TimeZoneSelect id="ev-zone" value={f.timeZone} onChange={(timeZone) => set({ timeZone })} />
 *
 * `blankLabel` adds an empty choice with that label (for a setting where blank means a default).
 */
export default function TimeZoneSelect({ id, value, onChange, blankLabel, disabled }) {
  const zones = allZones();
  const current = value || '';
  const extra = current && !zones.includes(current) ? current : null;
  const groups = new Map();
  for (const zone of zones) {
    const key = region(zone);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(zone);
  }
  return (
    <select
      id={id}
      className="v2-tz-select"
      value={current}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {blankLabel ? <option value="">{blankLabel}</option> : null}
      {extra ? <option value={extra}>{extra}</option> : null}
      {[...groups].map(([key, list]) =>
        key ? (
          <optgroup key={key} label={key}>
            {list.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </optgroup>
        ) : (
          list.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))
        )
      )}
    </select>
  );
}
