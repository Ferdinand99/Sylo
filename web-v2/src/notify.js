// Tiny message bus for the toast area (components/Toasts.jsx): any page can
// call notify('...') without prop drilling, and nothing blocks the page the way
// window.alert() does.
const listeners = new Set();

/** Show a message. `kind` is 'error' (default) or 'info'. */
export function notify(message, kind = 'error') {
  for (const fn of listeners) fn({ message: String(message), kind });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
