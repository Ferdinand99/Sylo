/**
 * Where a menu that is drawn at a fixed position goes, so it stays fully inside the window. Pure: the
 * numbers come in, a { left, top } goes out (CSS pixels from the window's top-left corner).
 *
 * Horizontally the menu's right edge lines up with the trigger's right edge (the usual place for a "⋯"
 * button at the end of a row); when that would push it past the left edge of the window, as on a phone
 * where the button is near the left, it is moved right until it has `margin` px of room, and it never
 * crosses the right edge either. Vertically it opens below the trigger, or above it when there is not
 * enough room below and more room above; as a last resort it is kept inside the window.
 *
 * @param {{ top: number, bottom: number, left: number, right: number }} trigger  the trigger's rectangle
 * @param {{ width: number, height: number }} size  the menu's size
 * @param {{ width: number, height: number }} viewport  the window's size
 * @param {{ margin?: number, gap?: number }} [options]
 * @returns {{ left: number, top: number }}
 */
export function menuPlacement(trigger, size, viewport, { margin = 8, gap = 4 } = {}) {
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const left = Math.min(Math.max(trigger.right - size.width, margin), maxLeft);

  const room = size.height + margin;
  const below = viewport.height - trigger.bottom - gap;
  const above = trigger.top - gap;
  let top;
  if (below >= room) top = trigger.bottom + gap;
  else if (above >= room || above > below) top = trigger.top - gap - size.height;
  else top = trigger.bottom + gap;
  const maxTop = Math.max(margin, viewport.height - size.height - margin);
  return { left, top: Math.min(Math.max(top, margin), maxTop) };
}
