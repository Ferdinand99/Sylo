import { Link } from 'react-router-dom';

/**
 * "Settings › Audit log": a small trail above a sub-page's title. `parents` are `{ label, to }` links;
 * `current` is the name of this page (not a link, marked as the current page for screen readers).
 */
export default function Breadcrumb({ parents = [], current }) {
  return (
    <nav className="v2-breadcrumb" aria-label="Breadcrumb">
      {parents.map((p) => (
        <span key={p.to}>
          <Link to={p.to}>{p.label}</Link>
          <span className="v2-breadcrumb-sep" aria-hidden="true">
            {' › '}
          </span>
        </span>
      ))}
      <span aria-current="page">{current}</span>
    </nav>
  );
}

/**
 * The parent crumb of the pages the sidebar files under "Members & moderation" (Audit log, Member data):
 * the trail uses the sidebar's group name and leads to the group's first page, the moderation hub.
 */
export const peopleCrumb = (guildId) => ({
  label: 'Members & moderation',
  to: `/guilds/${guildId}/moderation`,
});
