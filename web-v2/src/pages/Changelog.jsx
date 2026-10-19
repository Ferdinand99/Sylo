import { useEffect, useMemo, useState } from 'react';
import changelogMd from '../../../CHANGELOG.md?raw';
import { parseChangelog } from '../changelog.js';
import Reveal from '../components/Reveal.jsx';
import { markChangelogSeen, SYLO_VERSION } from '../util.js';

const RELEASES_URL = 'https://github.com/Ferdinand99/Sylo/releases';
const PAGE = 8;

// release-please's section names, in the words the page uses.
const SECTION_TITLES = {
  Features: 'New',
  'Bug Fixes': 'Fixes',
  'Performance Improvements': 'Faster',
  '⚠ BREAKING CHANGES': 'Breaking changes',
};

const formatDate = (iso) =>
  iso
    ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null;

function Segments({ segments }) {
  return segments.map((s, i) => {
    if (s.code) return <code key={i}>{s.code}</code>;
    if (s.href)
      return (
        <a key={i} href={s.href} target="_blank" rel="noopener noreferrer">
          {s.text}
        </a>
      );
    if (s.bold) return <strong key={i}>{s.text}</strong>;
    return <span key={i}>{s.text}</span>;
  });
}

function Release({ release, isRunning }) {
  return (
    <article className="v2-cl-release">
      <header className="v2-cl-head">
        <h2>
          {release.url ? (
            <a href={release.url} target="_blank" rel="noopener noreferrer">
              v{release.version}
            </a>
          ) : (
            `v${release.version}`
          )}
        </h2>
        {isRunning ? <span className="v2-cl-current">This version</span> : null}
        {release.date ? (
          <time className="v2-cl-date" dateTime={release.date}>
            {formatDate(release.date)}
          </time>
        ) : null}
      </header>
      {release.sections.map((section) => (
        <section className="v2-cl-section" key={section.title}>
          <h3 className={section.title.includes('BREAKING') ? 'is-breaking' : undefined}>
            {SECTION_TITLES[section.title] ?? section.title}
          </h3>
          <ul>
            {section.items.map((item, i) => (
              <li key={i}>
                {item.scope ? <span className="v2-cl-scope">{item.scope}</span> : null}
                <span className="v2-cl-text">
                  <Segments segments={item.segments} />
                </span>
                {item.refs.map((ref) => (
                  <a
                    key={ref.label}
                    className="v2-cl-ref"
                    href={ref.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {ref.label}
                  </a>
                ))}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}

// "What's new": every Sylo release, from the CHANGELOG.md this build was made
// from, so a self-hosted instance shows the changes of the version it runs.
export default function Changelog() {
  const releases = useMemo(() => parseChangelog(changelogMd), []);
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    markChangelogSeen();
  }, []);

  return (
    <Reveal>
      <h1 className="v2-section-title">What&apos;s new</h1>
      <p className="v2-field-hint">
        Every Sylo release, newest first{SYLO_VERSION ? `. This dashboard runs v${SYLO_VERSION}` : ''}.
      </p>
      <div className="v2-cl-list">
        {releases.slice(0, shown).map((r) => (
          <Release key={r.version} release={r} isRunning={r.version === SYLO_VERSION} />
        ))}
      </div>
      <p className="v2-cl-more">
        {shown < releases.length ? (
          <button type="button" className="v2-btn-ghost" onClick={() => setShown((n) => n + PAGE)}>
            Show older releases
          </button>
        ) : null}
        <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">
          All releases on GitHub →
        </a>
      </p>
    </Reveal>
  );
}
