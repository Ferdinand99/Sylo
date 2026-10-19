import { Suspense } from 'react';
import { useParams } from 'react-router-dom';
import { MODULE_FORMS } from '../moduleForms/index.js';
import { usePlatformInfo } from '../usePlatformInfo.js';
import { PlatformContext } from '../platformContext.jsx';
import Reveal from '../components/Reveal.jsx';

// Generic shell for /guilds/:guildId/m/:moduleId — just looks up the
// module's form component. Reachable directly only if someone bookmarks/
// types the URL for a module without one yet; Overview only ever links
// here for modules that do (see MODULE_FORMS).
export default function ModulePage() {
  const { guildId, moduleId } = useParams();
  const { info, loading } = usePlatformInfo(guildId);
  const { platform, notes } = info;
  const Form = MODULE_FORMS[moduleId];
  if (!Form) {
    return <p className="v2-state">This module doesn't have a V2 settings page yet.</p>;
  }
  // Wait for the platform so a Fluxer server never flashes Discord wording or settings.
  if (loading) return <p className="v2-state">Loading…</p>;
  const note = notes[moduleId];
  return (
    <PlatformContext.Provider value={info}>
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
