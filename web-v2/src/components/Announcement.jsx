import { useEffect, useState } from 'react';
import { getAnnouncement } from '../api.js';
import { readDismissedAnnouncement, writeDismissedAnnouncement } from '../util.js';

// Bot-wide notice from Bot Personalizer, shown above every page. 'critical'
// has no dismiss button; info/warning are dismissed per-browser (localStorage),
// keyed by createdAt so publishing a new one un-dismisses it.
export default function Announcement() {
  const [announcement, setAnnouncement] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    getAnnouncement()
      .then(({ announcement: a }) => {
        setAnnouncement(a);
        if (a) setDismissed(readDismissedAnnouncement() === String(a.createdAt));
      })
      .catch(() => {});
  }, []);

  if (!announcement || (dismissed && announcement.severity !== 'critical')) return null;

  return (
    <div className={`v2-announcement v2-ann-${announcement.severity}`}>
      <div className="v2-ann-text">
        <strong>{announcement.title}</strong>
        {announcement.body ? <span>{announcement.body}</span> : null}
      </div>
      {announcement.severity !== 'critical' ? (
        <button
          type="button"
          className="v2-ann-dismiss"
          aria-label="Dismiss announcement"
          onClick={() => {
            writeDismissedAnnouncement(announcement.createdAt);
            setDismissed(true);
          }}
        >
          &times;
        </button>
      ) : null}
    </div>
  );
}
