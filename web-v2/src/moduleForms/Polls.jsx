import { useCmd } from '../platformContext.jsx';
import ChipPicker from '../components/ChipPicker.jsx';
import EmbedEditor from '../components/EmbedEditor.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';

// Poll/results messages only expose content, title, colour, footer and image
// (src/modules/polls.js's normMsg) — the description is always Sylo's own
// choices/results text, shown as EmbedEditor's greyed fixedBody instead of
// an editable field.
const EMBED_OPTS = {
  content: true,
  author: false,
  description: false,
  fields: false,
  thumb: false,
  footerIcon: false,
  footerKey: 'footer',
  defaultColor: '#5b7cfa',
};

const toVars = (placeholders) => placeholders.map((t) => ({ token: t, label: t.replace(/[{}]/g, '') }));

function PollBodyPreview() {
  return (
    <div className="v2-embed-fixed-body">
      <div className="v2-embed-fixed-q">{'{question}'}</div>
      <div>🇦 First option</div>
      <div>🇧 Second option</div>
      <div>🇨 …</div>
      <p className="v2-field-hint">Sylo fills the question &amp; choices here</p>
    </div>
  );
}

function ResultsBodyPreview() {
  return (
    <div className="v2-embed-fixed-body">
      <div className="v2-embed-fixed-q">{'{question}'}</div>
      <div>
        🇦 <b>First option</b>
        <br />
        ██████░░░░ 60.0% · 6 votes
      </div>
      <div>
        🇧 <b>Second option</b>
        <br />
        ████░░░░░░ 40.0% · 4 votes
      </div>
      <p className="v2-field-hint">Sylo fills the results here</p>
    </div>
  );
}

const pick = (config) => ({
  voteRoleMode: config.voteRoleMode,
  voteRoles: config.voteRoles,
  pollMessage: config.pollMessage,
  resultsMessage: config.resultsMessage,
});

export default function Polls() {
  const cmd = useCmd();
  const {
    data: d,
    form,
    setForm,
    status,
    error,
    dirty,
    saving,
    save,
    reset,
    formKey,
  } = useModuleForm('polls', {
    toForm: pick,
  });

  if (status === 'error') return <LoadError error={error} what="Polls settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  return (
    <>
      <h1 className="v2-section-title">Polls</h1>
      <p className="v2-field-hint">
        Members create polls with <code>{cmd('/poll')}</code> and vote by reacting with the letter of their
        choice. A poll closes on its timer, when it hits its vote cap, or when someone runs{' '}
        <code>{cmd('/poll-end')}</code>.
      </p>

      <form onSubmit={save}>
        <div className="v2-group">
          <h2 className="v2-group-title">Who can vote</h2>
          <div className="v2-field">
            <select
              value={form.voteRoleMode}
              onChange={(e) => setForm((f) => ({ ...f, voteRoleMode: e.target.value }))}
            >
              <option value="allow">Everyone except the roles below</option>
              <option value="deny">Only members with a role below</option>
            </select>
          </div>
          <ChipPicker
            kind="role"
            items={d.roles}
            value={form.voteRoles}
            onChange={(voteRoles) => setForm((f) => ({ ...f, voteRoles }))}
          />
          <p className="v2-field-hint">
            Leave empty to let everyone vote. Disallowed reactions are removed automatically.
          </p>
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title">Polls message</h2>
          <p className="v2-field-hint">How a live poll looks. Sylo fills the greyed-out body.</p>
          <EmbedEditor
            key={`poll-${formKey}`}
            spec={form.pollMessage}
            onChange={(pollMessage) => setForm((f) => ({ ...f, pollMessage }))}
            {...EMBED_OPTS}
            fixedBody={<PollBodyPreview />}
            placeholders={{ title: '📊 {question}', footer: '{ends} · {mode}' }}
            vars={toVars(d.pollPlaceholders)}
          />
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title">Results message</h2>
          <p className="v2-field-hint">Posted when a poll closes.</p>
          <EmbedEditor
            key={`results-${formKey}`}
            spec={form.resultsMessage}
            onChange={(resultsMessage) => setForm((f) => ({ ...f, resultsMessage }))}
            {...EMBED_OPTS}
            fixedBody={<ResultsBodyPreview />}
            placeholders={{
              title: '📊 Results — {question}',
              footer: 'Winner: {winner} · {total} total votes',
            }}
            vars={toVars(d.resultsPlaceholders)}
          />
        </div>
      </form>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
