// The setup wizard's model: when the overview offers it, what the admin has chosen per item, what is
// still missing before it can be applied, and the request that applies it. Pure functions, so the rules
// are tested without rendering anything. The server (src/web/lib/setupWizard.js) has the last word.
import { cardTone } from './overviewModel.js';

/** A server with fewer modules set up than this is offered the wizard on its overview. */
export const SETUP_OFFER_BELOW = 3;

/** How many modules are on and set up (green on the overview). */
export function configuredModuleCount(groups, problemIds = new Set()) {
  return (groups ?? []).flatMap((g) => g.cards).filter((c) => c.hasToggle && cardTone(c, problemIds) === 'ok')
    .length;
}

export const needsSetupOffer = (groups, problemIds) =>
  configuredModuleCount(groups, problemIds) < SETUP_OFFER_BELOW;

/** The items of a goal. */
export const itemsOfGoal = (data, goalId) => data.items.filter((i) => i.goal === goalId);

/** An item the admin may switch on: not blocked by a missing bot permission for the module. */
export const usable = (item) => item.blocked.length === 0;

/** A goal is done when every usable item of it is already set up. */
export function goalDone(data, goalId) {
  const items = itemsOfGoal(data, goalId).filter(usable);
  return items.length > 0 && items.every((i) => i.configured);
}

/** No goal is ticked at first: the admin picks the goals. */
export const initialGoals = () => new Set();

/**
 * The first choices for every item: what was found by name, nothing created, no permission changed. An item
 * of a goal the admin picks is on, unless it is already set up or cannot run; the admin ticks such an item on
 * to replace it.
 * @returns {Record<string, { on: boolean, fields: Record<string, { mode: 'pick' | 'create', id: string, fix: boolean }> }>}
 */
/**
 * The channel a field's "Change its permissions" tick is about, when the admin has picked it: the one with the
 * wanted name, or the one found by name that others can see, and only when it differs from what the wizard promises.
 */
export function fixableChannel(field, pickId) {
  return [field.create?.existing, field.unsafeMatch].find((c) => c && c.gap && c.id === pickId) ?? null;
}

/**
 * Whether a role that is only for who may see a channel does anything now: Sylo sets who sees a channel when it
 * creates it, or when the admin ticks the change of its permissions. With neither, the field is not used.
 */
export function viewerActive(item, choice) {
  return item.fields.some((f) => {
    const pick = choice?.fields?.[f.key];
    return (
      f.kind === 'channel' &&
      f.create &&
      pick &&
      ((pick.mode === 'create' && !f.create.existing) || (pick.fix && fixableChannel(f, pick.id)))
    );
  });
}

export function initialChoices(data) {
  const out = {};
  for (const item of data.items) {
    out[item.id] = {
      on: !item.configured && usable(item),
      fields: Object.fromEntries(
        item.fields.map((f) => [
          f.key,
          // Only a channel that is what the wizard promises is picked for the admin (not one others can see).
          {
            mode: 'pick',
            id: f.match?.id ?? (f.create?.existing && !f.create.existing.gap ? f.create.existing.id : ''),
            fix: false,
          },
        ])
      ),
    };
  }
  return out;
}

const poolOf = (data, field) => (field.kind === 'channel' ? data.channels : data.roles);

/** What stops one switched-on item from being applied, as sentences. Empty when it is ready. */
export function itemProblems(data, item, choice) {
  if (!choice?.on) return [];
  const problems = [];
  for (const field of item.fields) {
    const pick = choice.fields[field.key] ?? { mode: 'pick', id: '' };
    if (pick.mode === 'create' && field.create && !field.create.existing) continue;
    if (!pick.id) {
      if (!field.optional) problems.push(`${field.label}: pick one, or tick Create.`);
      continue;
    }
    const found = poolOf(data, field).find((p) => p.id === pick.id);
    if (!found) problems.push(`${field.label}: that ${field.kind} is not on this server any more.`);
    // The server flags a channel Sylo cannot post in and a role Sylo cannot give; each only matters for a
    // field where Sylo posts or gives.
    else if (found.problem && (field.kind === 'channel' ? field.post : field.give)) {
      problems.push(`${field.label}: ${found.problem}`);
    }
  }
  return problems;
}

/** Items of the ticked goals that are switched on. */
export const activeItems = (data, goalIds, choices) =>
  data.items.filter((i) => goalIds.has(i.goal) && choices[i.id]?.on);

/** Everything that stops "Apply", and what applying would create. */
export function reviewSummary(data, goalIds, choices) {
  const active = activeItems(data, goalIds, choices);
  const channels = new Map();
  const roles = new Map();
  const changed = [];
  let problems = 0;
  for (const item of active) {
    problems += itemProblems(data, item, choices[item.id]).length;
    const viewerOn = viewerActive(item, choices[item.id]);
    for (const field of item.fields) {
      const pick = choices[item.id].fields[field.key];
      if (field.viewerOnly && !viewerOn) continue;
      const fixing = pick?.fix ? fixableChannel(field, pick.id) : null;
      if (fixing) changed.push(fixing.name);
      if (pick?.mode !== 'create' || !field.create || field.create.existing) continue;
      (field.kind === 'channel' ? channels : roles).set(field.create.name, field.create);
    }
  }
  return {
    items: active.length,
    replaced: active.filter((i) => i.configured).length,
    channels: [...channels.keys()],
    roles: [...roles.keys()],
    changed: [...new Set(changed)],
    problems,
  };
}

/** The "Create" boxes that would fix an item with nothing picked, so one button can tick them all. */
export function missingCreates(data, goalIds, choices) {
  const out = [];
  for (const item of activeItems(data, goalIds, choices)) {
    for (const field of item.fields) {
      const pick = choices[item.id].fields[field.key];
      if (field.create && !field.create.existing && !field.optional && pick?.mode === 'pick' && !pick.id)
        out.push([item.id, field.key]);
    }
  }
  return out;
}

/** The body of POST /setup/apply for the switched-on items of the ticked goals. */
export function toPayload(data, goalIds, choices) {
  return {
    items: activeItems(data, goalIds, choices).map((item) => ({
      id: item.id,
      // Only an item that is already set up is replaced, and only because the admin switched it on.
      replace: item.configured,
      fields: Object.fromEntries(
        item.fields.map((field) => {
          const pick = choices[item.id].fields[field.key] ?? { mode: 'pick', id: '' };
          // A role only for who may see a channel is sent only when it will be used.
          if (field.viewerOnly && !viewerActive(item, choices[item.id])) return [field.key, {}];
          if (pick.mode === 'create' && field.create && !field.create.existing)
            return [field.key, { create: true }];
          if (!pick.id) return [field.key, {}];
          // A channel's permissions change only where the wizard knows how, and only when the admin ticked it.
          const fix = pick.fix && fixableChannel(field, pick.id);
          return [field.key, fix ? { id: pick.id, fix: true } : { id: pick.id }];
        })
      ),
    })),
  };
}

/** How the result of one item reads, and the address of its settings page. */
export const RESULT_LABEL = { applied: 'Set up', skipped: 'Left as it is', failed: 'Not set up' };

/** The dashboard address of an item's settings (the mod-log channel is a server setting). */
export const itemHref = (id, guildId) =>
  id === 'modlog' ? `/guilds/${guildId}/settings` : `/guilds/${guildId}/m/${id}`;
