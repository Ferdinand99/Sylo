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

/** The goals ticked at first: the ones that still have something to set up. */
export const initialGoals = (data) =>
  new Set(data.goals.filter((g) => !goalDone(data, g.id)).map((g) => g.id));

/**
 * The first choices for every item: what was found by name, nothing created. An item that is already set up
 * or cannot run is off; the admin ticks it on to replace it.
 * @returns {Record<string, { on: boolean, fields: Record<string, { mode: 'pick' | 'create', id: string }> }>}
 */
export function initialChoices(data) {
  const out = {};
  for (const item of data.items) {
    out[item.id] = {
      on: !item.configured && usable(item),
      fields: Object.fromEntries(
        item.fields.map((f) => [f.key, { mode: 'pick', id: f.match ? f.match.id : '' }])
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
    if (pick.mode === 'create' && field.create) continue;
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
  let problems = 0;
  for (const item of active) {
    problems += itemProblems(data, item, choices[item.id]).length;
    for (const field of item.fields) {
      if (choices[item.id].fields[field.key]?.mode !== 'create' || !field.create) continue;
      (field.kind === 'channel' ? channels : roles).set(field.create.name, field.create);
    }
  }
  return {
    items: active.length,
    replaced: active.filter((i) => i.configured).length,
    channels: [...channels.keys()],
    roles: [...roles.keys()],
    problems,
  };
}

/** The "Create" boxes that would fix an item with nothing picked, so one button can tick them all. */
export function missingCreates(data, goalIds, choices) {
  const out = [];
  for (const item of activeItems(data, goalIds, choices)) {
    for (const field of item.fields) {
      const pick = choices[item.id].fields[field.key];
      if (field.create && !field.optional && pick?.mode === 'pick' && !pick.id)
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
          return [
            field.key,
            pick.mode === 'create' && field.create ? { create: true } : pick.id ? { id: pick.id } : {},
          ];
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
