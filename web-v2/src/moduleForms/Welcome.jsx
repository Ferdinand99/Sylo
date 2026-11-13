import { Link } from 'react-router-dom';
import { welcomeCardPreviewUrl } from '../api.js';
import ToggleSection from '../components/ToggleSection.jsx';
import ChipPicker from '../components/ChipPicker.jsx';
import Callout from '../components/Callout.jsx';
import PlaceholderHint from '../components/PlaceholderHint.jsx';
import MentionTextarea from '../components/MentionTextarea.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import SendTestButton from '../components/SendTestButton.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { tokensFor } from '../placeholders.js';

export default function Welcome() {
  const { guildId, data, form, setForm, status, error, dirty, saving, save, reset } =
    useModuleForm('welcome');
  const limits = useModuleLimits('welcome');

  if (status === 'error') return <LoadError error={error} what="Welcome settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const tokens = tokensFor('welcome', data.placeholders);
  // {role} only has a value in the welcome itself; the leave message has no role to name.
  const leaveTokens = tokens.filter((tk) => tk.token !== '{role}');
  const joinChannelName = data.channels.find((c) => c.id === form.joinChannel)?.name;
  // A config from before the setting existed has neither field: it welcomes on join.
  const onRole = form.trigger === 'role';
  const triggerRoleIds = form.triggerRoleIds ?? [];
  const maxTriggerRoles = limitOf(limits, 'triggerRoleIds').maxItems;

  return (
    <>
      <h1 className="v2-section-title">Welcome &amp; leave</h1>
      <p className="v2-field-hint">
        Greet new members, say goodbye when they leave, and give them starting roles. Under each message you
        can insert placeholders such as the member's name.
      </p>

      <form onSubmit={save} data-savebar>
        <div className="v2-group">
          <h2 className="v2-group-title">When to welcome</h2>
          <div className="v2-field">
            <label className="v2-check">
              <input
                type="radio"
                name="trigger"
                checked={!onRole}
                onChange={() => set({ trigger: 'join' })}
              />
              When a member joins
            </label>
            <label className="v2-check">
              <input type="radio" name="trigger" checked={onRole} onChange={() => set({ trigger: 'role' })} />
              When a member gets a role
            </label>
          </div>
          {onRole ? (
            <>
              <div className="v2-field">
                <label>Roles that start the welcome</label>
                <ChipPicker
                  kind="role"
                  items={data.roles}
                  value={triggerRoleIds}
                  max={maxTriggerRoles}
                  onChange={(ids) => set({ triggerRoleIds: ids })}
                />
                <p className="v2-field-hint">
                  The welcome is sent the first time a member gets any of these roles, once per member (a
                  member who leaves and comes back can be welcomed again). Joining sends nothing, unless the
                  member already has one of the roles when they join. This suits servers where a member only
                  counts after a step: roles from{' '}
                  <Link to={`/guilds/${guildId}/m/verification`}>Verification</Link> or an accepted{' '}
                  <Link to={`/guilds/${guildId}/m/applications`}>application</Link> are typical.
                </p>
                <p className="v2-field-hint">
                  A member is welcomed once. Members who were welcomed on joining since Sylo 5.2, or who
                  already have one of the roles when you switch from “When a member joins”, are not welcomed
                  by a role: only members who get a role afterwards count. (Someone welcomed on joining before
                  5.2 has no record, so a role they get later can welcome them once.)
                </p>
              </div>
              {triggerRoleIds.length === 0 ? (
                <Callout tone="warning">
                  No role is picked, so no welcome is sent. You can save, but pick at least one role for this
                  to work.
                </Callout>
              ) : null}
            </>
          ) : null}
        </div>

        <ToggleSection
          title={
            onRole
              ? 'Send a welcome message when a member gets the role'
              : 'Send a message when a member joins the server'
          }
          on={form.joinEnabled}
          onToggle={() => set({ joinEnabled: !form.joinEnabled })}
        >
          <div className="v2-field">
            <label htmlFor="joinChannel">Channel</label>
            <select
              id="joinChannel"
              value={form.joinChannel}
              onChange={(e) => set({ joinChannel: e.target.value })}
            >
              <option value="">— select a channel —</option>
              {data.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="v2-field">
            <label htmlFor="joinMessage">Message</label>
            <MentionTextarea
              channels={data.channels}
              roles={data.roles}
              id="joinMessage"
              rows={3}
              maxLength={limitOf(limits, 'joinMessage').maxLength}
              placeholder="Welcome {user} to {server}!"
              value={form.joinMessage}
              onChange={(e) => set({ joinMessage: e.target.value })}
            />
            <PlaceholderHint
              fieldId="joinMessage"
              tokens={tokens}
              value={form.joinMessage}
              onChange={(joinMessage) => set({ joinMessage })}
            />
          </div>
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.useEmbed}
              onChange={(e) => set({ useEmbed: e.target.checked })}
            />
            Send as an embed (uses the server's default embed colour)
          </label>
        </ToggleSection>

        <ToggleSection
          title="Attach a welcome image"
          description="A generated banner with the member's avatar, name and member number, posted with the join message above. Turn on “Send a message when a member joins” for this to show."
          on={form.card}
          onToggle={() => set({ card: !form.card })}
        >
          <div className="v2-field">
            <label htmlFor="cardBackground">
              Background image URL <span className="v2-field-hint">(optional — https, PNG/JPG)</span>
            </label>
            <input
              id="cardBackground"
              type="url"
              maxLength={limitOf(limits, 'cardBackground').maxLength}
              placeholder="https://…/banner.png"
              value={form.cardBackground}
              onChange={(e) => set({ cardBackground: e.target.value })}
            />
          </div>
          <img
            className="v2-card-preview"
            src={welcomeCardPreviewUrl(guildId)}
            alt="Welcome image preview"
            loading="lazy"
          />
          <p className="v2-field-hint">Preview uses a sample member — save to apply a new background.</p>
        </ToggleSection>

        <ToggleSection
          title={
            onRole ? 'Send a private message to welcomed members' : 'Send a private message to new members'
          }
          on={form.dmEnabled}
          onToggle={() => set({ dmEnabled: !form.dmEnabled })}
        >
          <div className="v2-field">
            <label htmlFor="dmMessage">DM text</label>
            <MentionTextarea
              channels={data.channels}
              roles={data.roles}
              id="dmMessage"
              rows={3}
              maxLength={limitOf(limits, 'dmMessage').maxLength}
              placeholder="Hi {user.name}, welcome to {server}!"
              value={form.dmMessage}
              onChange={(e) => set({ dmMessage: e.target.value })}
            />
            <PlaceholderHint
              fieldId="dmMessage"
              tokens={tokens}
              value={form.dmMessage}
              onChange={(dmMessage) => set({ dmMessage })}
            />
          </div>
        </ToggleSection>

        <ToggleSection
          title="Send a message when a member leaves the server"
          on={form.leaveEnabled}
          onToggle={() => set({ leaveEnabled: !form.leaveEnabled })}
        >
          <div className="v2-field">
            <label htmlFor="leaveChannel">Channel</label>
            <select
              id="leaveChannel"
              value={form.leaveChannel}
              onChange={(e) => set({ leaveChannel: e.target.value })}
            >
              <option value="">— select a channel —</option>
              {data.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="v2-field">
            <label htmlFor="leaveMessage">Message</label>
            <MentionTextarea
              channels={data.channels}
              roles={data.roles}
              id="leaveMessage"
              rows={3}
              maxLength={limitOf(limits, 'leaveMessage').maxLength}
              placeholder="{user.tag} left the server."
              value={form.leaveMessage}
              onChange={(e) => set({ leaveMessage: e.target.value })}
            />
            <PlaceholderHint
              fieldId="leaveMessage"
              tokens={leaveTokens}
              value={form.leaveMessage}
              onChange={(leaveMessage) => set({ leaveMessage })}
            />
          </div>
        </ToggleSection>

        <ToggleSection
          title="Give roles to new members"
          description="Assigned automatically on join. Shared with the Reaction roles & autoroles module."
          on={form.autoroleEnabled}
          onToggle={() => set({ autoroleEnabled: !form.autoroleEnabled })}
        >
          <div className="v2-field">
            <label>Roles</label>
            <ChipPicker
              kind="role"
              items={data.roles}
              value={form.autoroles}
              onChange={(autoroles) => set({ autoroles })}
            />
          </div>
        </ToggleSection>
      </form>

      <div className="v2-row v2-section-gap">
        <div className="v2-row-main">
          <h3>Verify new members</h3>
        </div>
        <Link className="v2-row-arrow" to={`/guilds/${guildId}/m/verification`}>
          {data.verificationEnabled
            ? `On (${data.verificationMode === 'captcha' ? 'captcha' : 'button'}) — configure`
            : 'Set up'}{' '}
          →
        </Link>
      </div>
      <SendTestButton
        moduleId="welcome"
        disabled={dirty}
        sample="a sample join message (not your own text)"
        channelName={joinChannelName}
      />
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
