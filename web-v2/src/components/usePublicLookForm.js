import { useCallback, useState } from 'react';
import { getPublicLook, savePublicLook } from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';
import { useAccess } from '../access.jsx';
import { normaliseAccent } from '../publicLook.js';

/**
 * State of the server settings' "Public pages" section, kept by the page so that its edits count towards the page's
 * save bar (Settings.jsx): `dirty` joins the page's own, `save()` and `reset()` are called by the bar.
 *
 * What the person has typed or chosen is a draft on top of what is saved, for this server. It is cleared by a save, a
 * reset and another server. No effect copies the saved values in (a late copy would overwrite an edit), and every
 * change is a functional update that touches only its own fields, so an answer that arrives later (an upload, a
 * removal) never overwrites what was typed meanwhile.
 *
 * Edit level only: below it nothing is asked of the server and `ready` stays false.
 */
export function usePublicLookForm(guildId) {
  const { can } = useAccess();
  const allowed = can('edit');
  const { data, error, setData } = useApiData(
    () => (allowed ? Promise.resolve().then(() => getPublicLook(guildId)) : Promise.resolve(null)),
    [guildId, allowed]
  );
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const mine = draft && draft.for === guildId ? draft : null;
  const accent = mine?.accent ?? data?.accent ?? '';
  const background = mine?.background ?? data?.background ?? 'none';
  const ready = Boolean(allowed && !error && data);

  const change = useCallback(
    (fields) =>
      setDraft((d) => {
        const base =
          d && d.for === guildId ? d : { for: guildId, accent: data.accent, background: data.background };
        return { ...base, ...(typeof fields === 'function' ? fields(base) : fields) };
      }),
    [guildId, data]
  );

  const normalised = normaliseAccent(accent);
  const invalid = normalised === null;
  const dirty = ready && !invalid && (normalised !== data.accent || background !== data.background);

  /** Runs one request (an upload, a removal, a save) with the section's controls off meanwhile. */
  const run = useCallback(
    async (fn, done) => {
      setBusy(true);
      try {
        const out = await fn();
        if (out) setData(out);
        if (done) notify(done, 'info');
        return out;
      } catch (err) {
        notify(err.message);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [setData]
  );

  /** Saves the colour and the background; resolves to true when it was saved (or there was nothing to save). */
  const save = useCallback(async () => {
    if (!dirty) return true;
    const out = await run(
      () => savePublicLook(guildId, { accent: normalised, background }),
      'Public pages saved.'
    );
    if (out) setDraft(null);
    return Boolean(out);
  }, [dirty, run, guildId, normalised, background]);

  const reset = useCallback(() => setDraft(null), []);

  return {
    ready,
    guildId,
    data,
    accent,
    background,
    normalised,
    invalid,
    dirty,
    busy,
    change,
    setAccent: (value) => change({ accent: value }),
    setBackground: (value) => change({ background: value }),
    run,
    save,
    reset,
  };
}
