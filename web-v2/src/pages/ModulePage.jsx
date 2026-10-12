import { useParams } from 'react-router-dom';
import { MODULE_FORMS } from '../moduleForms/index.js';
import { usePlatformInfo } from '../usePlatformInfo.js';

// Generic shell for /guilds/:guildId/m/:moduleId — just looks up the
// module's form component. Reachable directly only if someone bookmarks/
// types the URL for a module without one yet; Overview only ever links
// here for modules that do (see MODULE_FORMS).
export default function ModulePage() {
  const { guildId, moduleId } = useParams();
  const { platform, notes } = usePlatformInfo(guildId);
  const Form = MODULE_FORMS[moduleId];
  if (!Form) {
    return <p className="v2-state">This module doesn't have a V2 settings page yet.</p>;
  }
  const note = notes[moduleId];
  return (
    <>
      {note ? (
        <p className="v2-note v2-platform-note">
          <span className="v2-platform-note-tag">{platform === 'fluxer' ? 'Fluxer' : 'Discord'}</span> {note}
        </p>
      ) : null}
      <Form />
    </>
  );
}
