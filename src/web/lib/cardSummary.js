// The one-line summary of a module on the overview, in plain words ("#welcome · Verified role",
// "3 streamers", "Not set up yet"). It is built from the lines the overview already computes for the
// card (overviewSummary.js), so it never needs another query. `lines` keep their label/value shape
// for the apps; this is the wording for the dashboard.

const find = (lines, label) => lines.find((l) => l.label === label);
const value = (lines, label) => find(lines, label)?.value;
const isOn = (lines, label) => find(lines, label)?.state === 'on';
const num = (lines, label) => Number.parseInt(value(lines, label) ?? '0', 10) || 0;
const noun = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const name = (v) => String(v ?? '').replace(/^[#@]/, '');

/** A part for a count line that is on, nothing for zero. */
const count = (lines, label, one, many) =>
  num(lines, label) > 0 ? [noun(num(lines, label), one, many)] : [];

// id -> (lines) => string[]
const FORMAT = {
  general: (l) => [
    isOn(l, 'Mod-log channel') ? `Mod-log in ${value(l, 'Mod-log channel')}` : 'No mod-log channel yet',
  ],
  commands: (l) => {
    const parts = [noun(num(l, 'Available'), 'command')];
    if (num(l, 'Disabled here')) parts.push(`${num(l, 'Disabled here')} turned off`);
    if (num(l, 'Channel / role limited')) parts.push(`${num(l, 'Channel / role limited')} limited`);
    return parts;
  },
  messages: (l) =>
    num(l, 'Saved embeds') ? [noun(num(l, 'Saved embeds'), 'saved embed')] : ['No saved embeds yet'],
  moderation: (l) => [
    isOn(l, 'Warning thresholds') ? `${value(l, 'Warning thresholds')} for warnings` : 'No warning rules yet',
    ...(isOn(l, 'DM on punishment') ? ['DMs members when punished'] : []),
  ],
  logging: (l) => [
    ...(isOn(l, 'Log channel') ? [value(l, 'Log channel')] : ['No log channel yet']),
    ...(isOn(l, 'Events tracked') ? [`${value(l, 'Events tracked')} events`] : []),
  ],
  tickets: (l) => [
    ...(isOn(l, 'Notify channel') ? [`Alerts in ${value(l, 'Notify channel')}`] : []),
    ...(isOn(l, 'Staff roles') ? [noun(num(l, 'Staff roles'), 'staff role')] : ['Admins only']),
    ...(num(l, 'Open tickets') ? [`${num(l, 'Open tickets')} open`] : []),
  ],
  roles: (l) => [
    ...count(l, 'Reaction-role messages', 'reaction-role message'),
    ...count(l, 'Autoroles on join', 'autorole'),
  ],
  verification: (l) => [
    ...(isOn(l, 'Verified role') ? [`${name(value(l, 'Verified role'))} role`] : ['No role yet']),
    ...(isOn(l, 'Channel') ? [value(l, 'Channel')] : []),
  ],
  appeals: (l) => [
    noun(num(l, 'Form questions'), 'question'),
    ...(num(l, 'Open appeals') ? [`${num(l, 'Open appeals')} open`] : []),
    ...(isOn(l, 'Review channel') ? [`reviewed in ${value(l, 'Review channel')}`] : []),
  ],
  'welcome-channel': (l) => [
    ...(isOn(l, 'Channel') ? [value(l, 'Channel')] : ['No channel yet']),
    ...count(l, 'Elements', 'element'),
    ...(isOn(l, 'Published') ? [] : ['not published']),
  ],
  welcome: (l) => {
    const when = value(l, 'Welcome when') ?? '';
    const roles = /^a member gets (.+)$/.exec(when)?.[1];
    return [
      ...(isOn(l, 'Welcome message') ? [value(l, 'Welcome message')] : []),
      ...(roles ? [`${roles} role`] : []),
      ...(isOn(l, 'Leave message') ? [`leave in ${value(l, 'Leave message')}`] : []),
      ...(isOn(l, 'Welcome DM') ? ['DM'] : []),
    ];
  },
  birthdays: (l) => [
    ...(isOn(l, 'Channel') ? [value(l, 'Channel')] : ['No channel yet']),
    ...(isOn(l, 'Birthday role') ? [`${name(value(l, 'Birthday role'))} role`] : []),
  ],
  sticky: (l) => count(l, 'Active sticky messages', 'sticky message'),
  'quote-board': (l) => [
    noun(num(l, 'Saved quotes'), 'saved quote'),
    ...(isOn(l, 'Public page') ? ['public page'] : []),
  ],
  introductions: (l) => [
    ...(isOn(l, 'Channel') ? [value(l, 'Channel')] : ['No channel yet']),
    ...count(l, 'Introductions', 'introduction'),
  ],
  applications: (l) => [
    ...count(l, 'Forms', 'form'),
    ...(num(l, 'Waiting for a decision') ? [`${num(l, 'Waiting for a decision')} waiting`] : []),
  ],
  'auto-threads': (l) => count(l, 'Channels with auto threads', 'channel'),
  counting: (l) => [
    ...(isOn(l, 'Channel') ? [value(l, 'Channel')] : ['No channel yet']),
    `at ${value(l, 'Count') ?? 0}`,
  ],
  'custom-commands': (l) => count(l, 'Commands', 'command'),
  'invite-tracker': (l) => [
    noun(num(l, 'Inviters ranked'), 'inviter'),
    ...(isOn(l, 'Join log') ? [`log in ${value(l, 'Join log')}`] : []),
  ],
  'twitch-alerts': (l) => alerts(l, 'Streamers', 'streamer'),
  'kick-alerts': (l) => alerts(l, 'Streamers', 'streamer'),
  'youtube-alerts': (l) => [
    ...count(l, 'Channels', 'channel'),
    ...(isOn(l, 'Live alerts') ? ['live alerts'] : []),
  ],
  'apple-connect': (l) => [
    ...(isOn(l, 'Channel') ? [value(l, 'Channel')] : ['No channel yet']),
    ...(find(l, 'API')?.state === 'off' ? ['API keys missing'] : []),
  ],
  rss: (l) => count(l, 'Feeds', 'feed'),
  github: (l) => count(l, 'Repositories', 'repository', 'repositories'),
  'channel-cleanup': (l) => count(l, 'Schedules', 'schedule'),
  'game-stats': (l) =>
    num(l, 'Cached lookups') ? [`${noun(num(l, 'Cached lookups'), 'lookup')} cached`] : [],
  giveaways: (l) => [
    ...(num(l, 'Active giveaways') ? [`${num(l, 'Active giveaways')} running`] : []),
    ...(value(l, 'Winner ping') && value(l, 'Winner ping') !== 'none'
      ? [`pings ${value(l, 'Winner ping')}`]
      : []),
  ],
  events: (l) => [
    ...(num(l, 'Upcoming events') ? [`${num(l, 'Upcoming events')} upcoming`] : []),
    ...(isOn(l, 'Event pages') ? ['event pages'] : []),
  ],
  'temp-roles': (l) =>
    num(l, 'Active temporary roles') ? [`${num(l, 'Active temporary roles')} active`] : [],
  suggestions: (l) => [
    ...(num(l, 'Open suggestions') ? [`${num(l, 'Open suggestions')} open`] : []),
    ...(isOn(l, 'Channel') ? [value(l, 'Channel')] : ['No channel yet']),
    ...(isOn(l, 'Log channel') ? [`log in ${value(l, 'Log channel')}`] : []),
  ],
  polls: (l) => (num(l, 'Open polls') ? [`${num(l, 'Open polls')} open`] : []),
  autoresponder: (l) => count(l, 'Responders', 'responder'),
  afk: (l) => [
    ...(isOn(l, 'Nickname tag') ? ['nickname tag'] : []),
    ...(isOn(l, 'Mention reply') ? ['mention reply'] : []),
  ],
  'server-stats': (l) => [
    ...count(l, 'Stat channels', 'channel'),
    ...(value(l, 'Refresh') ? [`refreshes ${value(l, 'Refresh')}`] : []),
  ],
  insights: (l) => [`${value(l, 'Messages (7d)')} messages this week`],
  starboard: (l) => [
    noun(num(l, 'Boards'), 'board'),
    ...(find(l, 'Channels')?.state === 'neutral' ? [value(l, 'Channels')] : []),
  ],
  'temp-voice': (l) => (isOn(l, 'Hub channels') ? [value(l, 'Hub channels')] : []),
  'free-games': (l) => [
    ...(isOn(l, 'Channel') ? [value(l, 'Channel')] : ['No channel yet']),
    ...(isOn(l, 'Ping role') ? [`pings ${value(l, 'Ping role')}`] : []),
  ],
  reminders: (l) => (isOn(l, 'Reminders') ? [`${value(l, 'Reminders')} reminders`.replace(' · ', ', ')] : []),
  leveling: (l) => [
    ...(value(l, 'Announce') ? [`level-ups ${value(l, 'Announce').toLowerCase()}`] : []),
    ...count(l, 'Reward roles', 'reward role'),
  ],
  economy: (l) =>
    [
      value(l, 'Currency'),
      ...(num(l, 'Accounts') ? [noun(num(l, 'Accounts'), 'account')] : []),
      ...(isOn(l, 'Robbing') ? ['robbing on'] : []),
    ].filter(Boolean),
  automod: (l) => [
    ...(isOn(l, 'Active filters') ? [`${value(l, 'Active filters')} filters on`] : []),
    ...count(l, 'Exemptions', 'exemption'),
  ],
  honeypot: (l) => count(l, 'Traps set', 'trap'),
};

function alerts(l, label, one) {
  return [...count(l, label, one), ...(find(l, 'API')?.state === 'off' ? ['API keys missing'] : [])];
}

/**
 * The summary of one card as a list of short parts (the dashboard joins them with " · ", and a phone may
 * show only the first). A module with nothing set yet says "Not set up yet"; one with nothing to say
 * returns an empty list (the dashboard then says "On").
 * @param {string} id  module id or synthetic card id
 * @param {Array<{ label: string, value: string, state: string }>} lines  the card's lines
 * @returns {string[]}
 */
export function summaryParts(id, lines) {
  const list = Array.isArray(lines) ? lines : [];
  if (list.length > 0 && list.every((l) => l.state === 'off')) return ['Not set up yet'];
  const make = FORMAT[id];
  return make ? make(list).filter(Boolean) : [];
}
