import { useState } from 'react';
import PickerHealth from '../components/PickerHealth.jsx';
import { Link } from 'react-router-dom';
import { getGuildSettings, saveGuildSettings, exportGuildConfig } from '../api.js';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import Field from '../components/Field.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import ChipPicker from '../components/ChipPicker.jsx';
import { notify } from '../notify.js';
import Reveal from '../components/Reveal.jsx';

const toForm = (data) => ({
  modlogChannelId: data.modlogChannelId,
  embedColor: data.embedColorHex,
  botMasterRoleIds: data.botMasterRoleIds,
  commandPrefix: data.commandPrefix ?? '',
});

// The same rules the server enforces (it has the last word; see src/lib/commandPrefix.js).
// Empty is fine: it means the default.
function prefixProblem(value, max) {
  const v = value.trim();
  if (/\s/.test(v)) return 'The prefix can not contain spaces.';
  if (v.includes('`')) return 'The prefix can not contain a backtick (`).';
  if (/\p{C}/u.test(v)) return 'The prefix can not contain invisible or control characters.';
  if (v.length > max)
    return `The prefix can be at most ${max} characters. Emoji and some symbols count as two.`;
  return null;
}

// What is sent: the prefix trimmed, and nothing at all when the prefix is not allowed. The
// message is shown as a toast (useModuleForm aborts the save on a throw).
function settingsBody(form, data) {
  const commandPrefix = form.commandPrefix.trim();
  const problem =
    data.platform === 'fluxer' ? prefixProblem(commandPrefix, data.commandPrefixMaxLength) : null;
  if (problem) throw new Error(problem);
  return { ...form, commandPrefix };
}

export default function Settings() {
  const { guildId, data, form, setForm, load, status, error, dirty, saving, save, reset } = useModuleForm(
    'settings',
    {
      load: getGuildSettings,
      save: saveGuildSettings,
      select: (d) => d,
      toForm,
      fromForm: settingsBody,
      // The save response isn't the settings shape — keep the form as sent (the prefix trimmed).
      afterSave: (_result, sent) => sent,
    }
  );
  const [resettingColor, setResettingColor] = useState(false);
  const [exporting, setExporting] = useState(false);

  if (status === 'error') return <LoadError error={error} what="settings" />;
  // Same <Reveal> root as the ready return below, so React keeps it across a
  // server switch (which shows Loading… again) and the entrance doesn't replay.
  if (status === 'loading')
    return (
      <Reveal>
        <p className="v2-state">Loading…</p>
      </Reveal>
    );

  // Saves the form as it stands plus the colour reset, then reads back the
  // default colour — so afterwards everything on the page is saved.
  async function onResetColor() {
    setResettingColor(true);
    try {
      const body = settingsBody(form, data);
      await saveGuildSettings(guildId, { ...body, embedColorReset: true });
      const fresh = await getGuildSettings(guildId);
      load({ ...body, embedColor: fresh.embedColorHex });
    } catch (err) {
      notify(err.message);
    } finally {
      setResettingColor(false);
    }
  }

  // The "Export configuration" download.
  async function onExport() {
    setExporting(true);
    try {
      const data = await exportGuildConfig(guildId);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `sylo-${String(data.guildId).replace(/[^\w.-]/g, '-')}-config.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      notify(err.message);
    } finally {
      setExporting(false);
    }
  }

  return (
    <Reveal>
      <h1 className="v2-section-title">Settings</h1>

      <form onSubmit={save} data-savebar>
        <Field label="Mod-log channel" hint="Every moderation action posts an embed here.">
          <select
            id="modlog"
            value={form.modlogChannelId}
            onChange={(e) => setForm((f) => ({ ...f, modlogChannelId: e.target.value }))}
          >
            <option value="">— off —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </Field>
        <PickerHealth kind="channel" value={form.modlogChannelId} />

        {data.platform === 'fluxer' ? (
          <Field
            label="Command prefix"
            labelNote="— optional"
            hint={
              <>
                Fluxer has no slash commands, so members start a command with this, for example{' '}
                <code>{`${form.commandPrefix.trim() || data.defaultCommandPrefix}help`}</code>. Leave it empty
                to use the default, <code>{data.defaultCommandPrefix}</code>. Mentioning Sylo (@Sylo help)
                always works.
              </>
            }
            error={prefixProblem(form.commandPrefix, data.commandPrefixMaxLength)}
          >
            <input
              type="text"
              className="v2-input-short"
              value={form.commandPrefix}
              maxLength={data.commandPrefixMaxLength}
              placeholder={data.defaultCommandPrefix}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setForm((f) => ({ ...f, commandPrefix: e.target.value }))}
            />
          </Field>
        ) : null}

        <Field
          group
          label="Bot master roles"
          hint="Members with these roles can open this dashboard and change Sylo's settings for the server, like someone with Manage Server. Roles with Administrator already can."
        >
          <ChipPicker
            kind="role"
            items={data.roles}
            value={form.botMasterRoleIds}
            onChange={(botMasterRoleIds) => setForm((f) => ({ ...f, botMasterRoleIds }))}
          />
        </Field>

        <div className="v2-field">
          <label htmlFor="color">Default embed colour</label>
          <div className="v2-field-row">
            <input
              id="color"
              type="color"
              className="v2-color-input"
              value={form.embedColor}
              onChange={(e) => setForm((f) => ({ ...f, embedColor: e.target.value }))}
            />
            <span>{form.embedColor}</span>
            <button
              type="button"
              className="v2-btn-ghost"
              onClick={onResetColor}
              disabled={saving || resettingColor}
            >
              Reset to default
            </button>
          </div>
        </div>
      </form>

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">Server data</h2>
        <div className="v2-list">
          <Link className="v2-row" to={`/guilds/${guildId}/audit`}>
            <div className="v2-row-main">
              <h3>Audit log</h3>
              <p className="is-wrap">Configuration changes made from the dashboard, newest first.</p>
            </div>
            <span className="v2-row-arrow" aria-hidden="true">
              →
            </span>
          </Link>
          <div className="v2-row v2-row-stack">
            <div className="v2-row-main">
              <h3>Export configuration</h3>
              <p className="is-wrap">
                Download this server's module configuration as JSON. Member data (warnings, XP, tickets) is
                not included.
              </p>
            </div>
            <div className="v2-row-actions">
              <button type="button" className="v2-btn-ghost" onClick={onExport} disabled={exporting}>
                {exporting ? 'Exporting…' : 'Download JSON'}
              </button>
            </div>
          </div>
          <Link className="v2-row" to={`/guilds/${guildId}/member-data`}>
            <div className="v2-row-main">
              <h3>Member data</h3>
              <p className="is-wrap">
                Look up and delete the data Sylo stores about a specific member, for data-subject and erasure
                requests. The member is DM'd a confirmation.
              </p>
            </div>
            <span className="v2-row-arrow" aria-hidden="true">
              →
            </span>
          </Link>
        </div>
      </div>
      <SaveBar dirty={dirty} saving={saving || resettingColor} onSave={save} onReset={reset} />
    </Reveal>
  );
}
