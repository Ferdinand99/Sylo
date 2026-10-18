import { useState } from 'react';
import { getGuildSettings, saveGuildSettings } from '../api.js';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import Field from '../components/Field.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import ChipPicker from '../components/ChipPicker.jsx';
import { notify } from '../notify.js';

const toForm = (data) => ({
  modlogChannelId: data.modlogChannelId,
  embedColor: data.embedColorHex,
  botMasterRoleIds: data.botMasterRoleIds,
});

export default function Settings() {
  const { guildId, data, form, setForm, load, status, error, dirty, saving, save, reset } = useModuleForm(
    'settings',
    {
      load: getGuildSettings,
      save: saveGuildSettings,
      select: (d) => d,
      toForm,
      // The save response isn't the settings shape — keep the form as sent.
      afterSave: () => undefined,
    }
  );
  const [resettingColor, setResettingColor] = useState(false);

  if (status === 'error') return <LoadError error={error} what="settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  // Saves the form as it stands plus the colour reset, then reads back the
  // default colour — so afterwards everything on the page is saved.
  async function onResetColor() {
    setResettingColor(true);
    try {
      await saveGuildSettings(guildId, { ...form, embedColorReset: true });
      const fresh = await getGuildSettings(guildId);
      load({ ...form, embedColor: fresh.embedColorHex });
    } catch (err) {
      notify(err.message);
    } finally {
      setResettingColor(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Settings</h1>

      <form onSubmit={save}>
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

        <Field
          group
          label="Bot master roles"
          hint="Roles with Administrator already have dashboard access and don't need to be added here."
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
      <SaveBar dirty={dirty} saving={saving || resettingColor} onSave={save} onReset={reset} />
    </>
  );
}
