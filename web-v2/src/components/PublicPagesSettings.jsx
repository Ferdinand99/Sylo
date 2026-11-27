import { useRef } from 'react';
import { deletePublicLookImage, refreshPublicLookSplash, uploadPublicLookImage } from '../api.js';
import { notify } from '../notify.js';
import Callout from './Callout.jsx';
import Field from './Field.jsx';
import { SYLO_ACCENT, accentAdvice, accentOutcome, onAccent } from '../publicLook.js';

const MAX_BYTES = 2 * 1024 * 1024;

/** The theme the dashboard shows now, so the preview matches what the person sees. */
const currentTheme = () =>
  typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light'
    ? 'light'
    : 'dark';

/**
 * Server settings → Public pages: the server's own accent colour and background on the pages its members open
 * without the dashboard (the application form, the web shop, the ban appeal, the quote page and the leaderboards;
 * the event pages carry no server address and take no look). Only
 * these two things change; the layout, the type, the light and dark themes and the "Powered by Sylo" link stay
 * Sylo's. The preview is the application form page. Edit level only (the section is not shown below it).
 *
 * The edits are kept by the page (`look` is usePublicLookForm's result) and saved with its save bar, so leaving the
 * page with unsaved edits here is warned about like any other form. A picture is uploaded or removed at once.
 */
export default function PublicPagesSettings({ look }) {
  const fileInput = useRef(null);
  const { ready, guildId, data, accent, background, normalised, invalid, busy, setAccent, setBackground } =
    look;
  if (!ready) return null;

  const advice = invalid || !normalised ? null : accentAdvice(normalised);
  const theme = currentTheme();
  const outcome = accentOutcome(invalid ? '' : normalised);
  const shown = outcome[theme].color;
  const shownText = outcome[theme].text;

  const splash = data.splash;
  const image =
    background === 'upload' ? data.upload?.url : background === 'discord-splash' ? splash.copied?.url : null;
  const waitingSplash = background === 'discord-splash' && !splash.copied;

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_BYTES) {
      notify('The picture is larger than 2 MB.');
      return;
    }
    const out = await look.run(() => uploadPublicLookImage(guildId, file));
    if (out) {
      setBackground('upload');
      notify('Picture uploaded. Save to use it.', 'info');
    }
  }

  async function onRemove() {
    const out = await look.run(() => deletePublicLookImage(guildId), 'Picture removed.');
    // a picture that is gone cannot stay chosen; whatever else was typed stays
    if (out) look.change((d) => (d.background === 'upload' ? { background: 'none' } : {}));
  }

  const platformName = data.platform === 'fluxer' ? 'Fluxer' : 'Discord';
  const splashHint = !splash.available
    ? `This server has no invite background on ${platformName}. Set one there to use it here.`
    : `Sylo keeps its own copy of the server's ${platformName} invite background and checks it once a day, so visitors never load it from ${platformName}.`;

  let readability = null;
  if (advice?.readable) readability = 'Readable in both themes.';
  else if (advice?.problems.length) readability = `${advice.problems.map((p) => p.label).join('. ')}.`;

  return (
    <div className="v2-group v2-section-gap" id="public-pages">
      <h2 className="v2-group-title">Public pages</h2>
      <p className="v2-field-hint v2-look-intro">
        Give the pages your members open without the dashboard (application forms, the web shop, ban appeals,
        the quote page and the leaderboards) your server&apos;s accent colour and a background. Only these two
        things change: the layout, the type, the light and dark themes and the &quot;Powered by Sylo&quot;
        link stay as they are.
      </p>
      {/* No submit button: the page's save bar saves (Enter in the colour field too). */}
      <form onSubmit={(e) => e.preventDefault()} data-savebar>
        <div className="v2-field">
          <label htmlFor="look-accent">Accent colour</label>
          <div className="v2-field-row">
            <input
              type="color"
              className="v2-color-input"
              aria-label="Pick the accent colour"
              value={invalid || !normalised ? SYLO_ACCENT[theme] : normalised}
              onChange={(e) => setAccent(e.target.value)}
            />
            <input
              id="look-accent"
              type="text"
              className="v2-input-short"
              value={accent}
              placeholder={SYLO_ACCENT[theme]}
              maxLength={7}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={invalid || undefined}
              aria-describedby="look-accent-hint"
              onChange={(e) => setAccent(e.target.value)}
            />
            <button
              type="button"
              className="v2-btn-ghost"
              disabled={!accent || busy}
              onClick={() => setAccent('')}
            >
              Use Sylo&apos;s colour
            </button>
          </div>
          <p id="look-accent-hint" className={invalid ? 'v2-field-error' : 'v2-field-hint'}>
            {invalid
              ? 'Use a colour like #5865f2.'
              : 'Used for buttons, links and highlights. Leave it empty for Sylo’s own colour.'}
          </p>
          {advice?.warning ? (
            <Callout tone="warning" className="v2-look-warning">
              <p>{advice.warning}</p>
            </Callout>
          ) : null}
        </div>

        <Field label="Background" hint={background === 'discord-splash' ? splashHint : undefined}>
          <select value={background} disabled={busy} onChange={(e) => setBackground(e.target.value)}>
            <option value="none">None</option>
            <option value="upload">My own picture</option>
            <option value="discord-splash" disabled={!splash.available && background !== 'discord-splash'}>
              {`Invite background from ${platformName}${splash.available ? '' : ' (not set)'}`}
            </option>
          </select>
        </Field>

        <div className="v2-field">
          <span id="look-upload-label">Your own picture</span>
          <div className="v2-field-row">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              aria-labelledby="look-upload-label"
              onChange={onFile}
            />
            <button
              type="button"
              className="v2-btn-ghost"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {data.upload ? 'Replace picture' : 'Upload a picture'}
            </button>
            {data.upload ? (
              <button type="button" className="v2-btn-danger-ghost" disabled={busy} onClick={onRemove}>
                Remove picture
              </button>
            ) : null}
            {background === 'discord-splash' && splash.available ? (
              <button
                type="button"
                className="v2-btn-ghost"
                disabled={busy}
                onClick={() => look.run(() => refreshPublicLookSplash(guildId), 'Invite background checked.')}
              >
                Check the invite background now
              </button>
            ) : null}
          </div>
          <p className="v2-field-hint">
            PNG, JPEG or WebP, at most 2 MB. Sylo stores a re-encoded copy (metadata removed) and serves it
            itself.
            {!splash.available ? ` ${splashHint}` : ''}
          </p>
        </div>

        <h3 className="v2-look-preview-title">Preview: the application form</h3>
        <div
          className={`v2-look-preview${image ? ' has-image' : ''}`}
          data-testid="look-preview"
          role="img"
          aria-label="Preview of an application form page with this accent colour and background"
          style={{
            '--accent': shown,
            '--accent-text': shownText,
            '--on-accent': onAccent(shown),
            ...(image
              ? { backgroundImage: `linear-gradient(var(--look-dim), var(--look-dim)), url("${image}")` }
              : null),
          }}
        >
          <div className="v2-look-preview-panel">
            <div className="v2-look-preview-card">
              <p className="v2-look-preview-eyebrow">Your server</p>
              <p className="v2-look-preview-heading">Staff application</p>
              <p className="v2-look-preview-text">
                Tell us a little about you. <span className="v2-look-preview-link">Read the rules first</span>
                .
              </p>
              <div className="v2-look-preview-field">Why do you want to join?</div>
              <span className="v2-look-preview-btn">Submit application</span>
            </div>
            <p className="v2-look-preview-foot">Powered by Sylo</p>
          </div>
        </div>
        {waitingSplash ? (
          <p className="v2-field-hint">The invite background is downloaded when you save.</p>
        ) : null}
        <p className="v2-field-hint" title={advice?.detail || undefined}>
          Shown in the {theme} theme.
          {readability ? ` ${readability}` : ''}
        </p>
      </form>
    </div>
  );
}
