import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { loadUpdateStatus } from '../updateModel.js';
import { useOperator } from '../useOperator.js';

// A small pill in the top bar for the people who run this Sylo (operators), when a newer release is out.
// Nobody else asks the server anything: the check is about the whole instance, not one server. A failed
// or disabled check shows nothing at all. It links to the Health page's update section.
export default function UpdateBadge() {
  const operator = useOperator();
  const [latest, setLatest] = useState(null);

  useEffect(() => {
    if (!operator) return undefined;
    let live = true;
    loadUpdateStatus()
      .then((status) => {
        if (live && status?.available) setLatest(status.latest);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [operator]);

  if (!operator || !latest) return null;
  return (
    <Link
      className="v2-status-pill is-warning v2-update-badge"
      to="/health#update"
      title={`Sylo ${latest} is available`}
      aria-label={`Sylo ${latest} is available. Open Health`}
    >
      Update available
    </Link>
  );
}
