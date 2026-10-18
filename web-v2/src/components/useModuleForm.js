import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig } from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';
import { isDirty } from './formEqual.js';

/**
 * Form state with a saved snapshot to compare against. `load(next)` sets both
 * (a fresh fetch or a successful save); edits only move `form`, so `dirty`
 * is "differs from what the server last had". `reset()` drops the edits.
 *
 * `formKey` changes on reset() and on load(next, { remount: true }) — put it
 * on the `key` of any uncontrolled editor (EmbedEditor keeps its own copy of
 * the spec) so it re-reads the reverted / freshly fetched value.
 */
export function useFormState(initial = null) {
  const [form, setForm] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const [formKey, setFormKey] = useState(0);
  const load = useCallback((next, { remount = false } = {}) => {
    setForm(next);
    setBaseline(next);
    if (remount) setFormKey((k) => k + 1);
  }, []);
  const reset = useCallback(() => {
    setForm(baseline);
    setFormKey((k) => k + 1);
  }, [baseline]);
  const dirty = useMemo(() => isDirty(form, baseline), [form, baseline]);
  // `commit(saved)` moves only the snapshot — after a save whose response
  // doesn't echo the config, so edits typed while it was in flight survive.
  return { form, setForm, baseline, load, commit: setBaseline, reset, dirty, formKey };
}

const identity = (x) => x;

/**
 * Load / edit / save one module's config — the shape nearly every form in
 * moduleForms/ shares.
 *
 *   const m = useModuleForm('afk');
 *   if (m.status === 'error') return <LoadError error={m.error} what="AFK settings" />;
 *   if (m.status === 'loading') return <p className="v2-state">Loading…</p>;
 *   … m.form, m.set({ key: value }) …
 *   <SaveBar dirty={m.dirty} saving={m.saving} onSave={m.save} onReset={m.reset} />
 *
 * Options (all optional):
 * - `toForm(config, data)` — API config → form state (e.g. arrays to textarea text).
 * - `fromForm(form, data)` — form state → POST body. May throw an Error to
 *   abort the save; its message is shown as a toast.
 * - `select(data)` — the part of the response the form is built from
 *   (default `data.config`). The form re-initialises only when this object
 *   changes, so a page patching other parts of `data` with `setData` (a count,
 *   a list) never wipes unsaved edits.
 * - `afterSave(result, sentBody, data)` — form state after a successful save
 *   (default: `toForm(result.config, data)` when the response has a config,
 *   else the form as it was). `onSaved(result)` runs after that.
 * - `load(guildId)` / `save(guildId, body)` — other endpoints than the
 *   standard /modules/:id/config pair. `deps` — extra refetch dependencies.
 *
 * `save()` accepts a submit event (it calls preventDefault) and resolves to
 * true on success, false on failure (already reported with notify()).
 */
export function useModuleForm(moduleId, options = {}) {
  const { guildId } = useParams();
  const {
    toForm = identity,
    fromForm = identity,
    select = (d) => d.config,
    afterSave,
    onSaved,
    load: loadFn,
    save: saveFn,
    deps = [],
  } = options;

  const { data, loading, error, setData } = useApiData(
    () => (loadFn ? loadFn(guildId) : getModuleConfig(guildId, moduleId)),
    [guildId, moduleId, ...deps]
  );
  const state = useFormState(null);
  const { form, load } = state;
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // The server the current form was built from. useApiData keeps the previous
  // server's data on screen while the next one loads, so right after a server
  // switch `form` still holds the old server's config — saving it then would
  // write one server's channels and roles into another.
  const [loadedFor, setLoadedFor] = useState(null);

  // Latest option callbacks without re-running the init effect on every render.
  const opts = useRef(options);
  opts.current = { toForm, fromForm, afterSave, onSaved };

  const source = data ? select(data) : null;
  const lastSource = useRef(undefined);
  useEffect(() => {
    if (!data || source === lastSource.current) return;
    lastSource.current = source;
    load(opts.current.toForm(source, data), { remount: true });
    setLoadedFor(guildId);
    // `source` identity is the trigger; see `select` above.
  }, [data, source, load, guildId]);

  const save = useCallback(
    async (e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      if (!form || savingRef.current || loadedFor !== guildId) return false;
      let body;
      try {
        body = opts.current.fromForm(form, data);
      } catch (err) {
        notify(err.message);
        return false;
      }
      setSaving(true);
      savingRef.current = true;
      try {
        const result = saveFn ? await saveFn(guildId, body) : await saveModuleConfig(guildId, moduleId, body);
        const { afterSave: after, toForm: to, onSaved: saved } = opts.current;
        let next;
        if (after) next = after(result, body, data);
        else if (result && result.config !== undefined) next = to(result.config, data);
        if (next === undefined) state.commit(form);
        else load(next);
        saved?.(result);
        return true;
      } catch (err) {
        notify(err.message || 'Saving failed.');
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [form, data, guildId, loadedFor, moduleId, saveFn, load, state.commit]
  );

  const set = useCallback((patch) => state.setForm((f) => ({ ...f, ...patch })), [state.setForm]);

  let status = 'ready';
  if (error) status = 'error';
  else if ((loading && !data) || !form || loadedFor !== guildId) status = 'loading';

  return {
    guildId,
    data,
    setData,
    form,
    setForm: state.setForm,
    set,
    baseline: state.baseline,
    load,
    status,
    error,
    dirty: state.dirty,
    saving,
    save,
    reset: state.reset,
    formKey: state.formKey,
  };
}
