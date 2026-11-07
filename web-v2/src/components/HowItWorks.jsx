/**
 * The technical detail behind a module, folded away under a page's one-sentence intro so the page
 * opens with what it does, not how: <HowItWorks>…paragraphs…</HowItWorks>.
 */
export default function HowItWorks({ title = 'How it works', children }) {
  return (
    <details className="v2-am-params v2-howitworks">
      <summary>{title}</summary>
      <div className="v2-field-hint">{children}</div>
    </details>
  );
}
