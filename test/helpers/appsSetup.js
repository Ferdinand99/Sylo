// Shared by the Applications tests: the form most tests use, making one in the database, and sending a
// submission without going through a DM.
import { insertForm } from '../../src/db/applications.js';
import { normaliseForm } from '../../src/modules/lib/applicationsForm.js';
import { submitApplication } from '../../src/modules/applications.js';
import { setGuildModule } from '../../src/db/modules.js';
import { APP_ROLE, CH, GID } from './fakeApps.js';

export const QUESTIONS = [
  {
    id: 'q_text',
    type: 'text',
    label: 'Why do you want to join?',
    required: true,
    long: true,
    minLength: 5,
    maxLength: 200,
  },
  {
    id: 'q_pick',
    type: 'choice',
    label: 'Favourite colour',
    required: true,
    options: [
      { id: 'red', label: 'Red' },
      { id: 'blue', label: 'Blue' },
    ],
  },
  {
    id: 'q_multi',
    type: 'choice',
    label: 'Hobbies',
    required: true,
    multiple: true,
    minChoices: 1,
    maxChoices: 2,
    options: [
      { id: 'chess', label: 'Chess' },
      { id: 'go', label: 'Go' },
      { id: 'hike', label: 'Hiking' },
    ],
  },
  {
    id: 'q_team',
    type: 'role',
    label: 'Team',
    grant: 'accept',
    options: [{ id: APP_ROLE.chosenA }, { id: APP_ROLE.chosenB }],
  },
  { id: 'q_yes', type: 'yesno', label: 'Over 18?', required: true },
];

/** Answers in the shape the web form sends them (lists of option ids). */
export const GOOD = {
  q_text: 'I love trains and hedges',
  q_pick: ['red'],
  q_multi: ['chess', 'hike'],
  q_team: [APP_ROLE.chosenB],
  q_yes: 'yes',
};

export const enableApplications = (config = {}) =>
  setGuildModule(GID, 'applications', { enabled: true, config });

/** A form in the database; returns its id. `over` changes any setting. */
export async function makeForm(over = {}) {
  const config = normaliseForm({
    name: 'Staff',
    enabled: true,
    fillMode: 'both',
    pendingChannelId: CH.pending,
    questions: QUESTIONS,
    ...over,
  });
  return insertForm({
    guildId: GID,
    name: config.name,
    enabled: config.enabled,
    fillMode: config.fillMode,
    config,
  });
}

/** Submit as `member` without a DM (the same submitApplication the questionnaire and the web form use). */
export const submitFor = (env, member, formId, { answers = GOOD, source = 'dm', ...rest } = {}) =>
  submitApplication({ guild: env.guild, userId: member.id, formId, answers, source, ...rest });
