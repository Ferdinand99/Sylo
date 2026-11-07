import { useEffect, useState } from 'react';
import { getModuleLimits } from '../api.js';

// The setting limits of every module (max lengths, ranges, item counts), from
// GET /api/v2/modules/limits. They live next to each module's normaliser on the server
// (src/modules/<id>.js, `LIMITS`), so a form reads them here instead of keeping its own numbers.
//
// Fetched once per page load. While they load (or if the request fails) a form renders without
// limits rather than waiting: the server still cuts or clamps whatever is saved.

let loaded = null; // the resolved { [moduleId]: { [fieldPath]: Limit } }
let pending = null; // the in-flight request, shared by every form
const NONE = Object.freeze({});

function loadModuleLimits() {
  if (loaded) return Promise.resolve(loaded);
  if (!pending) {
    pending = getModuleLimits()
      .then((all) => {
        loaded = all && typeof all === 'object' ? all : {};
        return loaded;
      })
      .finally(() => {
        // A failed request must not stick for the life of the page.
        pending = null;
      });
  }
  return pending;
}

/** Forget what was fetched (tests only). */
export function resetModuleLimits() {
  loaded = null;
  pending = null;
}

/**
 * The limits of one module, `{ 'field.path': { maxLength?, min?, max?, maxItems? } }`; nested
 * fields use dotted paths and `[]` for array items ('stickies[].content'). An empty object while
 * they load. `_embed` holds the limits of one embed (title, description, fields, …).
 * @returns {Record<string, {maxLength?: number, min?: number, max?: number, maxItems?: number}>}
 */
export function useModuleLimits(moduleId) {
  const [all, setAll] = useState(loaded);
  useEffect(() => {
    if (loaded) {
      setAll(loaded);
      return undefined;
    }
    let live = true;
    loadModuleLimits().then(
      (v) => live && setAll(v),
      () => {}
    );
    return () => {
      live = false;
    };
  }, []);
  return all?.[moduleId] ?? NONE;
}

/**
 * One field's limit, always an object, so `limitOf(limits, 'content').maxLength` is simply
 * undefined (and React leaves the attribute off) while limits are missing or unknown.
 */
export function limitOf(limits, path) {
  return limits?.[path] ?? NONE;
}
