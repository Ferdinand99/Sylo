// The "Beta" mark for a module or page that is new and still settling in. One component for every place it
// shows (page heading, cards, sidebar), so the wording stays the same. The flag itself lives in
// src/modules/registry.js (`beta: true` on a module, BETA_PAGES for a page that is not a module).

const TITLE = 'New — behavior may still change';

/** The small pill after a name. `className` swaps the look (the sidebar uses a smaller one). */
export function BetaTag({ className = 'v2-beta-tag' }) {
  return (
    <span className={className} title={TITLE}>
      Beta
    </span>
  );
}

/** The one-line note at the top of a beta page. `what` is "module" or "feature". */
export function BetaNote({ what = 'module' }) {
  return (
    <p className="v2-beta-note" data-testid="beta-note">
      Beta: this {what} is new and may still have rough edges. Report problems in the Sylo Discord.
    </p>
  );
}
