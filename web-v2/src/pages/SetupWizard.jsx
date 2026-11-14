import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { applySetup, getSetupSuggestion } from '../api.js';
import { useApiData } from '../useApiData.js';
import { useOverview } from '../OverviewContext.jsx';
import { notify } from '../notify.js';
import { plural } from '../components/Meta.jsx';
import LoadError from '../components/LoadError.jsx';
import Breadcrumb from '../components/Breadcrumb.jsx';
import Callout from '../components/Callout.jsx';
import Reveal from '../components/Reveal.jsx';
import {
  RESULT_LABEL,
  goalDone,
  initialChoices,
  initialGoals,
  itemHref,
  itemProblems,
  itemsOfGoal,
  missingCreates,
  reviewSummary,
  toPayload,
  usable,
  viewerActive,
  fixableChannel,
} from '../setupModel.js';
import '../styles/setup-wizard.css';

const STEPS = [
  ['look', 'Look'],
  ['goals', 'Goals'],
  ['review', 'Review'],
  ['done', 'Done'],
];

function Stepper({ step }) {
  const at = STEPS.findIndex(([key]) => key === step);
  return (
    <ol className="v2-setup-steps" aria-label="Setup steps">
      {STEPS.map(([key, label], i) => (
        <li
          key={key}
          className={i < at ? 'is-past' : i === at ? 'is-now' : ''}
          aria-current={i === at ? 'step' : undefined}
        >
          <span className="v2-setup-step-n" aria-hidden="true">
            {i + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}

// What Sylo may do on this server, in words: only the permissions that matter for "Create".
function botCanLine(can, what, permission) {
  if (can === true) return `Sylo can create ${what} here.`;
  if (can === false)
    return `Sylo can't create ${what} here: it needs the ${permission} permission. You can still pick ${what} that already exist.`;
  return `Sylo can't tell whether it may create ${what} here. It only tries when you tick Create.`;
}

function LookStep({ data, guildId, onNext }) {
  const { inspected } = data;
  const usableItems = data.items.filter(usable);
  const done = usableItems.filter((i) => i.configured).length;
  return (
    <section className="v2-group" aria-labelledby="setup-look">
      <h2 id="setup-look" className="v2-group-title" tabIndex={-1}>
        What Sylo found
      </h2>
      <p>
        Sylo looked at this server: {plural(inspected.channels, 'text channel')},{' '}
        {plural(inspected.roles, 'role')} and {plural(inspected.members, 'member')}. It matches channels and
        roles by name, for example <code>welcome</code>, <code>rules</code>, <code>mod-log</code>,{' '}
        <code>logs</code> or <code>tickets</code>.
      </p>
      <ul className="v2-setup-facts">
        <li>{botCanLine(data.botCan.createChannels, 'channels', 'Manage Channels')}</li>
        <li>{botCanLine(data.botCan.createRoles, 'roles', 'Manage Roles')}</li>
        {done ? (
          <li>
            {done} of {usableItems.length} things are already set up. They stay as they are unless you tick
            them.
          </li>
        ) : null}
      </ul>
      <p className="v2-field-hint">
        Nothing is created or changed until you press Apply on the last screen, and a channel or role is only
        created when you tick Create for it.
      </p>
      <div className="v2-setup-actions">
        <button type="button" className="v2-btn-primary" onClick={onNext}>
          Choose goals
        </button>
        <Link className="v2-btn-ghost" to={`/guilds/${guildId}`}>
          Skip, I'll set things up myself
        </Link>
      </div>
    </section>
  );
}

function GoalsStep({ data, goals, setGoals, onBack, onNext }) {
  const toggle = (id) => {
    const next = new Set(goals);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setGoals(next);
  };
  return (
    <section className="v2-group" aria-labelledby="setup-goals">
      <h2 id="setup-goals" className="v2-group-title" tabIndex={-1}>
        What do you want Sylo to do here?
      </h2>
      <p className="v2-field-hint">Pick as many as you like. You review everything before it is applied.</p>
      <div className="v2-setup-goals" role="group" aria-labelledby="setup-goals">
        {data.goals.map((goal) => {
          const done = goalDone(data, goal.id);
          return (
            <label key={goal.id} className={`v2-setup-goal${goals.has(goal.id) ? ' is-on' : ''}`}>
              <input type="checkbox" checked={goals.has(goal.id)} onChange={() => toggle(goal.id)} />
              <span className="v2-setup-goal-text">
                <strong>{goal.label}</strong>
                <span>{goal.description}</span>
                {done ? <span className="v2-setup-done-tag">Already set up</span> : null}
              </span>
            </label>
          );
        })}
      </div>
      <div className="v2-setup-actions">
        <button type="button" className="v2-btn-ghost" onClick={onBack}>
          Back
        </button>
        <button type="button" className="v2-btn-primary" disabled={goals.size === 0} onClick={onNext}>
          Review
        </button>
      </div>
    </section>
  );
}

// What a channel the wizard makes or changes ends up as, in words.
function accessPhrase(create) {
  if (create.private)
    return 'private (only admins and Sylo, and the role below if you pick one; roles that were allowed to see it lose that)';
  if (create.everyoneCanView) return 'readable by everyone and read-only';
  return 'read-only for members';
}

function PickField({ item, field, pick, data, disabled: disabledByItem, viewerUnused, onChange }) {
  // A role only for who may see a channel does nothing unless the channel is created or its permissions change.
  const disabled = disabledByItem || viewerUnused;
  const pool = field.kind === 'channel' ? data.channels : data.roles;
  const prefix = field.kind === 'channel' ? '#' : '';
  const selectId = `setup-${item.id}-${field.key}`;
  const creating = pick.mode === 'create';
  const found = pool.find((p) => p.id === pick.id);
  const flag = found?.problem && (field.kind === 'channel' ? field.post : field.give) ? found.problem : null;
  const existing = field.create?.existing ?? null;
  const access = field.create?.private
    ? ' Only admins and Sylo can see it, and the role below if you pick one.'
    : field.create?.everyoneCanView
      ? ' Everyone can read it, only Sylo can post.'
      : field.create?.readOnly
        ? ' Only Sylo can post. Members see it like your other channels.'
        : field.kind === 'role'
          ? ' It has no permissions.'
          : '';
  // A channel the admin picked that is not what the wizard promises (the one with the name Create would give, or
  // the one found by name that others can see): its permissions are only changed when the admin ticks the box.
  const fixing = pick.id && field.kind === 'channel' ? fixableChannel(field, pick.id) : null;
  const unsafe = field.unsafeMatch && !pick.id && !creating ? field.unsafeMatch : null;
  return (
    <div className="v2-field v2-setup-field">
      <label htmlFor={selectId}>
        {field.label}
        {field.optional ? <span className="v2-field-hint"> (optional)</span> : null}
      </label>
      <select
        id={selectId}
        value={creating ? '' : pick.id}
        disabled={disabled || creating}
        onChange={(e) => onChange({ mode: 'pick', id: e.target.value, fix: false })}
      >
        <option value="">{field.optional ? 'None' : 'Pick one'}</option>
        {pool.map((p) => (
          <option key={p.id} value={p.id}>
            {prefix}
            {p.name}
          </option>
        ))}
      </select>
      {field.create && !existing ? (
        <label className="v2-check v2-setup-create">
          <input
            type="checkbox"
            checked={creating}
            disabled={disabled}
            onChange={(e) => onChange({ mode: e.target.checked ? 'create' : 'pick', id: '', fix: false })}
          />
          <span>
            Create {prefix}
            {field.create.name}.{access}
          </span>
        </label>
      ) : null}
      {viewerUnused && !disabledByItem ? (
        <p className="v2-field-hint">
          Not used now. This role gets access when Sylo creates the channel above, or when you tick the box
          that changes its permissions. Neither is ticked.
        </p>
      ) : null}
      {unsafe ? (
        <p className="v2-row-warn">
          {prefix}
          {unsafe.name} exists, but {unsafe.gap.charAt(0).toLowerCase()}
          {unsafe.gap.slice(1)} Pick it to make it private, or pick another channel.
        </p>
      ) : null}
      {fixing ? (
        <>
          <p className="v2-row-warn">
            {prefix}
            {fixing.name} {existing && fixing.id === existing.id ? 'already exists. ' : 'is not private. '}
            {fixing.gap}
          </p>
          <label className="v2-check v2-setup-create">
            <input
              type="checkbox"
              checked={Boolean(pick.fix)}
              disabled={disabled}
              onChange={(e) => onChange({ ...pick, fix: e.target.checked })}
            />
            <span>
              Change its permissions to {accessPhrase(field.create)}. Leave this unticked to use it as it is.
            </span>
          </label>
        </>
      ) : null}
      {flag && !creating ? <p className="v2-row-warn">{flag}</p> : null}
      {!pick.id && !creating && !field.optional && !disabled && !field.create ? (
        <p className="v2-field-hint">This server has no match. Pick one to set this up.</p>
      ) : null}
    </div>
  );
}

function ItemCard({ data, item, choice, setChoice }) {
  const blocked = !usable(item);
  const problems = itemProblems(data, item, choice);
  const headId = `setup-item-${item.id}`;
  return (
    <section className={`v2-setup-item${choice.on ? ' is-on' : ''}`} aria-labelledby={headId}>
      <label className="v2-check v2-setup-item-head">
        <input
          type="checkbox"
          checked={choice.on}
          disabled={blocked}
          onChange={(e) => setChoice({ ...choice, on: e.target.checked })}
        />
        <strong id={headId}>{item.configured ? `Replace ${item.name}` : `Set up ${item.name}`}</strong>
        {item.configured ? <span className="v2-setup-done-tag">Already set up</span> : null}
      </label>
      <ul className="v2-setup-does">
        {item.does.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {item.configured ? (
        <p className="v2-field-hint">
          This is set up already, so it is left alone. Tick it to let the wizard change its channels and
          switches. Text you wrote is kept.
        </p>
      ) : null}
      {blocked ? (
        <p className="v2-row-warn">
          Sylo can't run this module yet. The bot owner has to allow a permission for it first.
        </p>
      ) : null}
      {item.warnings.map((w) => (
        <p key={w} className="v2-row-warn">
          {w}
        </p>
      ))}
      {item.fields.map((field) => (
        <PickField
          key={field.key}
          item={item}
          field={field}
          data={data}
          pick={choice.fields[field.key]}
          disabled={!choice.on}
          viewerUnused={Boolean(field.viewerOnly) && !viewerActive(item, choice)}
          onChange={(pick) => setChoice({ ...choice, fields: { ...choice.fields, [field.key]: pick } })}
        />
      ))}
      {choice.on && problems.length ? (
        <ul className="v2-setup-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function listNames(names, prefix = '') {
  const items = names.map((n) => `${prefix}${n}`);
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0];
}

function ReviewStep({ data, goals, choices, setChoices, applying, onBack, onApply }) {
  const summary = reviewSummary(data, goals, choices);
  const creates = missingCreates(data, goals, choices);
  const chosenGoals = data.goals.filter((g) => goals.has(g.id));

  const setChoice = (id, next) => setChoices((prev) => ({ ...prev, [id]: next }));
  function tickAllCreates() {
    setChoices((prev) => {
      const next = { ...prev };
      for (const [id, key] of creates) {
        next[id] = {
          ...next[id],
          fields: { ...next[id].fields, [key]: { mode: 'create', id: '', fix: false } },
        };
      }
      return next;
    });
  }

  const parts = [];
  if (summary.channels.length) parts.push(`create ${listNames(summary.channels, '#')}`);
  if (summary.roles.length)
    parts.push(`create the ${plural(summary.roles.length, 'role')} ${listNames(summary.roles)}`);
  if (summary.changed.length) parts.push(`change the permissions of ${listNames(summary.changed, '#')}`);

  return (
    <section className="v2-group" aria-labelledby="setup-review">
      <h2 id="setup-review" className="v2-group-title" tabIndex={-1}>
        Review
      </h2>
      <p className="v2-field-hint">
        Each item is saved on its own, the same way its settings page saves it, and shows up in the audit log.
        Switch off anything you do not want.
      </p>
      {creates.length ? (
        <div className="v2-setup-bulk">
          <p>
            {plural(creates.length, 'thing')} had no match on this server.{' '}
            <button type="button" className="v2-btn-ghost" onClick={tickAllCreates}>
              Tick Create for all of them
            </button>
          </p>
        </div>
      ) : null}
      {chosenGoals.map((goal) => (
        <div key={goal.id} className="v2-setup-goalblock">
          <h3 className="v2-setup-goal-title">{goal.label}</h3>
          {itemsOfGoal(data, goal.id).map((item) => (
            <ItemCard
              key={item.id}
              data={data}
              item={item}
              choice={choices[item.id]}
              setChoice={(next) => setChoice(item.id, next)}
            />
          ))}
        </div>
      ))}
      <div className="v2-setup-summary" role="status">
        {summary.items === 0 ? (
          <p>Nothing is switched on, so nothing would change.</p>
        ) : (
          <p>
            Applying will set up {plural(summary.items, 'item')}
            {summary.replaced ? ` (${summary.replaced} replaced)` : ''}
            {parts.length ? `, and ${parts.join(' and ')}` : ''}.
            {summary.problems ? ` ${plural(summary.problems, 'problem')} to fix first.` : ''}
          </p>
        )}
      </div>
      <div className="v2-setup-actions">
        <button type="button" className="v2-btn-ghost" onClick={onBack} disabled={applying}>
          Back
        </button>
        <button
          type="button"
          className="v2-btn-primary"
          disabled={applying || summary.items === 0 || summary.problems > 0}
          onClick={onApply}
        >
          {applying ? 'Applying…' : 'Apply'}
        </button>
      </div>
    </section>
  );
}

function DoneStep({ guildId, results, onAgain }) {
  const failed = results.filter((r) => r.status === 'failed');
  const applied = results.filter((r) => r.status === 'applied');
  return (
    <section className="v2-group" aria-labelledby="setup-done">
      <h2 id="setup-done" className="v2-group-title" tabIndex={-1}>
        {failed.length ? 'Some things were not set up' : 'Done'}
      </h2>
      <p role="status">
        {plural(applied.length, 'item')} set up
        {failed.length ? `, ${failed.length} not set up` : ''}.
      </p>
      <ul className="v2-setup-results">
        {results.map((r) => (
          <li key={r.id} className={`v2-setup-result is-${r.status}`}>
            <div>
              <strong>{r.name}</strong>
              <span className="v2-setup-result-status">{RESULT_LABEL[r.status]}</span>
            </div>
            <p>{r.message}</p>
            {r.warnings.map((w) => (
              <p key={w} className="v2-row-warn">
                {w}
              </p>
            ))}
            {r.status === 'applied' ? (
              <Link to={itemHref(r.id, guildId)} className="v2-setup-result-link">
                Open its settings
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="v2-setup-actions">
        {failed.length ? (
          <button type="button" className="v2-btn-ghost" onClick={onAgain}>
            Review again
          </button>
        ) : null}
        <Link className="v2-btn-primary" to={`/guilds/${guildId}`}>
          Back to the overview
        </Link>
      </div>
    </section>
  );
}

export default function SetupWizard() {
  const { guildId } = useParams();
  const overview = useOverview();
  // Read again when the wizard is opened or re-run: what is set up changes between visits.
  const { data, error, setData } = useApiData(() => getSetupSuggestion(guildId), [guildId], guildId);
  const [step, setStep] = useState('look');
  const [goals, setGoals] = useState(null);
  const [choices, setChoices] = useState(null);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState([]);
  // A step change moves focus to the new step's heading: the button that was pressed is gone.
  const stepRef = useRef(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    stepRef.current?.querySelector('h2')?.focus();
  }, [step]);

  // The first choices are made from the first read of this server, once.
  const ready = useMemo(
    () => (data ? { goals: goals ?? initialGoals(data), choices: choices ?? initialChoices(data) } : null),
    [data, goals, choices]
  );

  if (error) return <LoadError error={error} what="the setup wizard" />;
  if (!data || !ready) {
    return (
      <Reveal>
        <p className="v2-state">Looking at this server…</p>
      </Reveal>
    );
  }

  async function onApply() {
    setApplying(true);
    try {
      const body = toPayload(data, ready.goals, ready.choices);
      const { results: out } = await applySetup(guildId, body);
      setResults(out);
      setStep('done');
      // What is set up changed: the overview and the next run read it again.
      overview?.reload?.();
      getSetupSuggestion(guildId)
        .then((fresh) => {
          setData(fresh);
          // Switch off what was just set up, and keep what failed on for another try.
          const failed = new Set(out.filter((r) => r.status === 'failed').map((r) => r.id));
          setChoices(
            Object.fromEntries(
              Object.entries(initialChoices(fresh)).map(([id, c]) => [
                id,
                failed.has(id) ? { ...c, on: true } : c,
              ])
            )
          );
        })
        .catch(() => {});
    } catch (err) {
      notify(err.message);
    } finally {
      setApplying(false);
    }
  }

  return (
    <Reveal>
      <Breadcrumb
        parents={[{ label: 'Server settings', to: `/guilds/${guildId}/settings` }]}
        current="Setup wizard"
      />
      <h1 className="v2-section-title">Set up Sylo</h1>
      <p className="v2-field-hint">
        Sylo proposes a starter setup for this server. Every Sylo feature is free, so you can set up as much
        or as little as you like, and run this again whenever you want.
      </p>
      <Stepper step={step} />
      {data.platform === 'fluxer' ? (
        <Callout tone="info">
          On Fluxer the wizard works the same way. Where Discord shows a button in a message, Fluxer members
          use a reaction.
        </Callout>
      ) : null}
      <div ref={stepRef}>
        {step === 'look' ? <LookStep data={data} guildId={guildId} onNext={() => setStep('goals')} /> : null}
        {step === 'goals' ? (
          <GoalsStep
            data={data}
            goals={ready.goals}
            setGoals={setGoals}
            onBack={() => setStep('look')}
            onNext={() => {
              setGoals(ready.goals);
              setChoices(ready.choices);
              setStep('review');
            }}
          />
        ) : null}
        {step === 'review' ? (
          <ReviewStep
            data={data}
            goals={ready.goals}
            choices={ready.choices}
            setChoices={setChoices}
            applying={applying}
            onBack={() => setStep('goals')}
            onApply={onApply}
          />
        ) : null}
        {step === 'done' ? (
          <DoneStep guildId={guildId} results={results} onAgain={() => setStep('review')} />
        ) : null}
      </div>
    </Reveal>
  );
}
