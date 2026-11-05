import { Suspense, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { setModuleEnabled } from '../api.js';
import { useOverview } from '../OverviewContext.jsx';
import { MODULE_FORMS } from '../moduleForms/index.js';
import { notify } from '../notify.js';
import { usePlatformInfo } from '../usePlatformInfo.js';
import BlockedNote from '../components/BlockedNote.jsx';
import { PlatformContext } from '../platformContext.jsx';
import Reveal from '../components/Reveal.jsx';
import Switch from '../components/Switch.jsx';

// The module's on/off state with a switch, so a module can be turned on from
// its own settings page. Reads and patches the same shared overview state the
// Overview page and the sidebar use.
function ModuleStatusBar({ card, onToggle }) {
  // Missing gateway intents: the bot can't run the module, whatever the switch says (card.status 'blocked').
  const blocked = (card.missingIntents ?? []).length > 0;
  return (
    <>
      <div className="v2-module-status">
        <span className="v2-module-status-text">
          <strong>{blocked ? 'Blocked' : card.enabled ? 'On' : 'Off'}</strong>
          <span className="v2-module-status-name">{card.name}</span>
        </span>
        <Switch
          checked={card.enabled}
          onChange={(on) => onToggle(card.id, on)}
          label={card.name}
          disabled={blocked}
        />
      </div>
      {blocked ? (
        <p className="v2-note v2-row-warn">
          <BlockedNote intents={card.missingIntents} />
        </p>
      ) : null}
      {/* Always rendered, so a screen reader announces the notice appearing after a toggle. */}
      <div aria-live="polite">
        {!blocked && !card.enabled ? (
          <p className="v2-note">This module is off. Turn it on for these settings to take effect.</p>
        ) : null}
      </div>
    </>
  );
}

// Generic shell for /guilds/:guildId/m/:moduleId — just looks up the
// module's form component. Reachable directly only if someone bookmarks/
// types the URL for a module without one yet; Overview only ever links
// here for modules that do (see MODULE_FORMS).
export default function ModulePage() {
  const { guildId, moduleId } = useParams();
  const { info, loading } = usePlatformInfo(guildId);
  const { platform, notes } = info;
  const { data, dataGuildId, setData } = useOverview() ?? {};
  // Module ids with a save in flight, and the server the page is on now.
  const toggling = useRef(new Set());
  const currentGuild = useRef(guildId);
  currentGuild.current = guildId;
  const Form = MODULE_FORMS[moduleId];
  if (!Form) {
    return <p className="v2-state">This module doesn't have a V2 settings page yet.</p>;
  }
  // Wait for the platform so a Fluxer server never flashes Discord wording or settings.
  if (loading) return <p className="v2-state">Loading…</p>;
  const note = notes[moduleId];
  // No bar until this server's overview has loaded (not the previous server's, which stays in the
  // shared state while the new one loads), or for a module it doesn't list (or one with no switch).
  const card =
    dataGuildId === guildId ? data?.groups?.flatMap((g) => g.cards).find((c) => c.id === moduleId) : null;

  // Same as Overview: the switch flips at once, and flips back (with the error
  // as a toast) if the save fails.
  async function onToggle(id, enabled) {
    if (toggling.current.has(id)) return;
    toggling.current.add(id);
    const apply = (on) =>
      setData((d) => ({
        ...d,
        groups: d.groups.map((g) => ({
          ...g,
          cards: g.cards.map((c) => (c.id === id ? { ...c, enabled: on } : c)),
        })),
      }));
    apply(enabled);
    try {
      await setModuleEnabled(guildId, id, enabled);
    } catch (err) {
      // Not if the user has switched server since: the same card id there is another server's.
      if (currentGuild.current === guildId) apply(!enabled);
      notify(err.message);
    } finally {
      toggling.current.delete(id);
    }
  }

  return (
    <PlatformContext.Provider value={info}>
      {card?.hasToggle ? <ModuleStatusBar card={card} onToggle={onToggle} /> : null}
      {note ? (
        <p className="v2-note v2-platform-note">
          <span className="v2-platform-note-tag">{platform === 'fluxer' ? 'Fluxer' : 'Discord'}</span> {note}
        </p>
      ) : null}
      {/* The entrance plays once per module: Reveal sits outside the keyed
          form (and is keyed by module), so a server switch that remounts the
          form doesn't play it again. */}
      <Reveal key={moduleId}>
        {/* Keyed by server, so switching server starts the form from scratch
            instead of briefly showing (and saving) the previous server's settings. */}
        <Suspense fallback={<p className="v2-state">Loading…</p>}>
          <Form key={guildId} />
        </Suspense>
      </Reveal>
    </PlatformContext.Provider>
  );
}
