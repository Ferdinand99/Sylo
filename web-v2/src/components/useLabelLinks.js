import { useEffect } from 'react';

let counter = 0;

// Many forms have a bare <label> followed by its input in the same field. Link
// each such pair (for / id) so clicking the label focuses the input and screen
// readers announce the label. Labels that already have htmlFor, or that wrap
// their control, are left alone.
function linkLabels(root) {
  for (const label of root.querySelectorAll('label:not([for])')) {
    if (label.querySelector('input, select, textarea')) continue;
    const field = label.parentElement;
    if (!field) continue;
    const control = [...field.querySelectorAll('input:not([type="hidden"]), select, textarea')].find(
      (el) => label.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    if (!control) continue;
    if (!control.id) control.id = `v2-auto-${(counter += 1)}`;
    label.htmlFor = control.id;
  }
}

// A name for a control that still has none: the short text just before it
// ("Max mentions"), else its field's label, else its placeholder, else the
// heading of the row or card it sits in.
function nameFor(el) {
  const clean = (t) =>
    (t ?? '')
      .replace(/\s+/g, ' ')
      .replace(/[—:,\-\s]+$/, '')
      .trim();
  const prev = el.previousElementSibling;
  const candidates = [
    prev && !prev.matches('input, select, textarea, button') ? prev.textContent : '',
    el.closest('.v2-field')?.querySelector(':scope > label')?.textContent,
    el.placeholder,
    el.closest('.v2-row, .v2-rule-card, .v2-am-rule')?.querySelector('h3, strong, .v2-field-hint')
      ?.textContent,
  ];
  return candidates.map(clean).find((t) => t && t.length <= 70) ?? '';
}

function nameControls(root) {
  for (const el of root.querySelectorAll('input:not([type="hidden"]), select, textarea')) {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.title) continue;
    if (el.labels && el.labels.length) continue;
    const name = nameFor(el);
    if (name) el.setAttribute('aria-label', name);
  }
}

export default function useLabelLinks() {
  useEffect(() => {
    let queued = false;
    const run = () => {
      queued = false;
      linkLabels(document.body);
      nameControls(document.body);
    };
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(run);
    });
    run();
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
}
