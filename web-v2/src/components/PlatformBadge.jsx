// A small tag naming a server's platform — shown only once an account spans more than one.
const LABELS = { discord: 'Discord', fluxer: 'Fluxer' };

export default function PlatformBadge({ platform }) {
  return <span className={`v2-platform v2-platform-${platform}`}>{LABELS[platform] ?? platform}</span>;
}
