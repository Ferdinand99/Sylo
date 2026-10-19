import { useState } from 'react';

const isEnter = (name) => typeof name === 'string' && name.startsWith('v2-enter');

/**
 * One-time entrance for a page's content (pages.css, `.v2-enter`): its
 * top-level blocks fade and rise in, slightly staggered, the first time they
 * render. Once every block has finished, `is-done` switches the animation off,
 * so blocks that mount later — a search filter, another tab, a refetch, or a
 * form remounted by a server switch — simply appear.
 *
 * Put it where it stays mounted for the whole visit to a page: around the
 * ready content of a page whose data stays on screen while it refetches, or
 * as the root of both the loading and the ready return (same element type in
 * the same place, so React keeps it). A `.v2-state` child (Loading…, empty,
 * error) is never part of the entrance.
 */
export default function Reveal({ className = '', children }) {
  const [done, setDone] = useState(false);

  function onAnimationEnd(e) {
    if (done || !isEnter(e.animationName)) return;
    const running = e.currentTarget.getAnimations?.({ subtree: true }).some((a) => isEnter(a.animationName));
    if (!running) setDone(true);
  }

  return (
    <div
      className={`v2-enter${done ? ' is-done' : ''}${className ? ` ${className}` : ''}`}
      onAnimationEnd={onAnimationEnd}
    >
      {children}
    </div>
  );
}
