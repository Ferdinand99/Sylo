/**
 * A jump list for a long page: one pill per section, each scrolling to the heading with that id. Put it
 * above the form and give each section heading an `id`:
 *
 *   <SectionIndex sections={[['eco-currency', 'Currency'], ['eco-chat', 'Earning from chat']]} />
 *   <h2 className="v2-group-title" id="eco-currency">Currency</h2>
 *
 * The scroll is smooth unless the person asked for reduced motion; focus moves to the heading so a
 * keyboard or screen reader user lands in the section.
 */
export default function SectionIndex({ sections, label = 'On this page' }) {
  function jump(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
    el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  }
  return (
    <nav className="v2-section-index" aria-label={label}>
      <span className="v2-section-index-label">Jump to</span>
      <ul>
        {sections.map(([id, text]) => (
          <li key={id}>
            <button type="button" className="v2-section-index-pill" onClick={() => jump(id)}>
              {text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
