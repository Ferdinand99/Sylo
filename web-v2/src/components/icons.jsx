// One small inline icon set (24px, Lucide-style strokes) for the sidebar and the module cards.
// Names are the ones src/web/lib/moduleIcons.js gives each module, plus a few for navigation.
const circle = (cx, cy, r) => <circle cx={cx} cy={cy} r={r} />;

export const ICONS = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  trophy: (
    <>
      <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0Z" />
      <path d="M7 5H4a3 3 0 0 0 3 5M17 5h3a3 3 0 0 1-3 5" />
    </>
  ),
  id: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      {circle(9, 10, 2)}
      <path d="M15 8h3M15 12h3M6 16h12" />
    </>
  ),
  gear: (
    <>
      {circle(12, 12, 3.2)}
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 0 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09A1.7 1.7 0 0 0 21 10.6H21a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
    </>
  ),
  pulse: <path d="M3 12h4l3 8 4-16 3 8h4" />,
  activity: <path d="M3 12h4l3 8 4-16 3 8h4" />,
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  'bar-chart': <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  megaphone: (
    <>
      <path d="m3 11 18-5v12L3 14v-3z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </>
  ),
  shield: <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />,
  'shield-check': (
    <>
      <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13 6 4h12l3 9v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 13h5l1 3h6l1-3h5" />
    </>
  ),
  flag: <path d="M5 21V4M5 4h12l-2 4 2 4H5" />,
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 10 3 2-3 2M13 15h4" />
    </>
  ),
  'file-text': <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6" />,
  filter: <path d="M3 5h18l-7 8v6l-4-2v-4z" />,
  target: (
    <>
      {circle(12, 12, 9)}
      {circle(12, 12, 5)}
      {circle(12, 12, 1)}
    </>
  ),
  gavel: <path d="m14 13-8 8M16 4l5 5M14 6l4 4-6 6-4-4zM3 21h8" />,
  ticket: <path d="M3 8v3a2 2 0 0 1 0 2v3h18v-3a2 2 0 0 1 0-2V8zM14 8v8" />,
  users: (
    <>
      {circle(9, 8, 3.5)}
      <path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6M16 4.5a3.5 3.5 0 0 1 0 7M22 20c0-2.5-1.5-4.5-4-5.5" />
    </>
  ),
  cake: <path d="M4 20h16v-7H4zM4 13c2-2 4 2 8 0s6 2 8 0M12 9V6M12 3.5v.01" />,
  smile: (
    <>
      {circle(12, 12, 9)}
      <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" />
    </>
  ),
  hash: <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />,
  'trending-up': <path d="m3 17 6-6 4 4 8-8M15 7h6v6" />,
  star: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />,
  pin: <path d="M12 17v5M8 3h8l-1 7 3 3v2H6v-2l3-3z" />,
  command: (
    <path d="M9 9V6a3 3 0 1 0-3 3zm0 0h6m-6 0v6m6-6V6a3 3 0 1 1 3 3zm0 0v6m0 0h3a3 3 0 1 1-3 3zm0 0H9m0 0v3a3 3 0 1 1-3-3z" />
  ),
  'user-plus': (
    <>
      {circle(10, 8, 4)}
      <path d="M2 21c0-4 3.5-6 8-6s8 2 8 6M19 8v6M16 11h6" />
    </>
  ),
  'message-circle': <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
  'message-square': <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />,
  zap: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z" />,
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  gamepad: (
    <path d="M6 11h4M8 9v4M15 12h.01M18 10h.01M17.3 5H6.7a4 4 0 0 0-3.9 3.2L2 15a3 3 0 0 0 5.2 2l1.3-2h7l1.3 2A3 3 0 0 0 22 15l-.8-6.8A4 4 0 0 0 17.3 5z" />
  ),
  bell: <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0" />,
  gift: (
    <>
      <rect x="3" y="8" width="18" height="4" />
      <path d="M12 8v13M19 12v9H5v-9M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 11h18" />
    </>
  ),
  lightbulb: (
    <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z" />
  ),
  hourglass: <path d="M6 2h12M6 22h12M7 2c0 5 5 6 5 10s-5 5-5 10M17 2c0 5-5 6-5 10s5 5 5 10" />,
  threads: <path d="M5 4h14M5 9h14M5 14h8M5 19h5" />,
  quote: <path d="M7 7h4v4c0 3-1 5-4 6M15 7h4v4c0 3-1 5-4 6" />,
  'id-card': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      {circle(9, 10, 2)}
      <path d="M15 8h3M15 12h3M6 16h12" />
    </>
  ),
  clipboard: (
    <>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 12h6M9 16h4" />
    </>
  ),
  coins: (
    <>
      {circle(8, 8, 6)}
      <path d="M18.1 10.4A6 6 0 1 1 10.4 18.1M7 6h1v4" />
    </>
  ),
  twitch: <path d="M21 2H3v16h5v4l4-4h5l4-4V2zM11 11V7M16 11V7" />,
  youtube: (
    <path d="M2.5 17a24 24 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49 49 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24 24 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49 49 0 0 1-16.2 0A2 2 0 0 1 2.5 17M10 15l5-3-5-3z" />
  ),
  kick: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M9 8v8M9 12l5-4M10.5 11l4.5 5" />
    </>
  ),
  rss: <path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16M5 19h.01" />,
  'trash-2': <path d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2" />,
  github: (
    <path d="M9 19c-4 1.5-4-2-6-2m12 4v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
  ),
  sliders: <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />,
  users2: (
    <>
      {circle(9, 8, 3.5)}
      <path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6" />
    </>
  ),
  history: <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2" />,
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  search: (
    <>
      {circle(11, 11, 7)}
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  chevron: <path d="m6 9 6 6 6-6" />,
  sparkles: (
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />
  ),
};

/** An inline icon by name; an unknown name draws the sliders icon. */
export function Icon({ name, className = 'v2-sidebar-icon' }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name] ?? ICONS.sliders}
    </svg>
  );
}
