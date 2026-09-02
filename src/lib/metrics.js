// In-process metrics for the /metrics scrape endpoint. Counters only: they climb
// monotonically and their names end in `_total`. Everything here is process-local
// and resets to 0 on restart — Prometheus' rate() handles counter resets. Live
// gauges (uptime, guild count, gateway ping, db size) are read straight from
// runtime state by the /metrics route and are never stored here.
//
// No dependencies, and nothing in this module imports another Sylo module, so it
// is safe to pull into the logger and the bot's hot paths.

/** @typedef {{ name: string, labels: Record<string,string>, value: number }} Series */

/** @type {Map<string, Series>} rendered-series string -> counter */
const counters = new Map();

/** Escape a label value per the Prometheus text format. */
function esc(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Stable `name{a="1",b="2"}` key with labels sorted by name. */
function seriesKey(name, labels) {
  const keys = Object.keys(labels);
  if (!keys.length) return name;
  const inner = keys
    .sort()
    .map((k) => `${k}="${esc(labels[k])}"`)
    .join(',');
  return `${name}{${inner}}`;
}

/**
 * Increment a counter.
 * @param {string} name  e.g. "sylo_commands_total"
 * @param {Record<string, string | number>} [labels]
 * @param {number} [by]
 */
export function inc(name, labels = {}, by = 1) {
  const key = seriesKey(name, labels);
  const cur = counters.get(key);
  if (cur) cur.value += by;
  else counters.set(key, { name, labels: { ...labels }, value: by });
}

/** Current value of one series. Mostly for tests and the /health JSON. */
export function peek(name, labels = {}) {
  return counters.get(seriesKey(name, labels))?.value ?? 0;
}

/** Every stored series for one metric name. */
export function byMetric(name) {
  return [...counters.values()].filter((c) => c.name === name);
}

/** Drop every counter. Tests only. */
export function reset() {
  counters.clear();
}

/**
 * Render the stored counters as Prometheus text, one `# TYPE <name> counter`
 * header per metric name, series sorted for stable output. Returns '' when
 * nothing has been counted yet, otherwise a string ending in a newline.
 */
export function renderCounters() {
  if (!counters.size) return '';
  const names = [...new Set([...counters.values()].map((c) => c.name))].sort();
  const out = [];
  for (const name of names) {
    out.push(`# TYPE ${name} counter`);
    const rows = [...counters.values()]
      .filter((c) => c.name === name)
      .map((c) => `${seriesKey(c.name, c.labels)} ${c.value}`)
      .sort();
    out.push(...rows);
  }
  return `${out.join('\n')}\n`;
}
