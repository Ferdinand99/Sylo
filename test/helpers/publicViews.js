// Sample data and checks for the public EJS pages (login, the app's confirm page, error, verify,
// appeal, leaderboard). They are standalone pages in the new dashboard's look: no htmx, Alpine,
// sidebar or inline script/style. Shared by the tests and by anyone rendering the pages to look at them.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ejs from 'ejs';

export const VIEWS = fileURLToPath(new URL('../../src/web/views', import.meta.url));

/** Anything of the classic dashboard's shell. */
export const CLASSIC_CHROME = /htmx|hx-|alpine|x-data|sidebar|classic-retiring|has-js|\/vendor\/|\/app\.js/i;

const dot = (hue) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="hsl(${hue} 55% 50%)"/></svg>`
  );

const members = [
  ['Mira', 18, 62, 41200, 3012, 5200, 190],
  ['a-very-long-member-name-that-should-be-cut-off-with-an-ellipsis', 15, 18, 28700, 2210, 0, 0],
  ['Odd', 12, 95, 17450, 1544, 920, 45],
  ['Pepper', 7, 40, 5200, 410, 0, 0],
  ['Left the server', 4, 5, 1800, 150, 0, 0],
].map(([name, level, pct, xp, messages, voiceXp, voiceMinutes], i) => ({
  rank: i + 1,
  name,
  avatar: i === 3 ? null : dot(250 + i * 30),
  left: i === 4,
  level,
  pct,
  xp,
  messages,
  voiceXp,
  voiceMinutes,
}));

const appeal = (extra) => ({
  state: 'form',
  guildId: '900000000000000201',
  guildName: 'Hedgerow HQ',
  token: 'tok',
  questions: ['Why were you banned?', 'Why should we lift the ban?'],
  serverInvite: 'https://discord.gg/example',
  rejoinInvite: null,
  verdict: null,
  decisionReason: '',
  reappealDays: 0,
  message: '',
  ...extra,
});

const verify = (extra) => ({
  state: 'challenge',
  guildId: '900000000000000201',
  token: 'tok',
  siteKey: '1x00000000000000000000AA',
  message: '',
  ...extra,
});

const board = (extra) => ({
  guild: { name: 'Hedgerow HQ', icon: dot(250) },
  total: 214,
  period: 'all',
  members,
  page: 1,
  pages: 3,
  canonical: '/leaderboard/900000000000000201',
  ...extra,
});

/** name -> { file, data }: every page of the six, in its states. */
export const SAMPLES = {
  login: {
    file: 'login.ejs',
    data: {
      syloVersion: '5.0.0',
      providers: [
        { href: '/auth/discord/login', label: 'Discord' },
        { href: '/auth/fluxer/login', label: 'Fluxer' },
      ],
    },
  },
  'mobile-confirm': {
    file: 'mobile-confirm.ejs',
    data: {
      syloVersion: '5.0.0',
      name: 'ferdi',
      platforms: ['Discord', 'Fluxer'],
      nonce: 'n0nce',
      cancelUrl: 'sylo://auth?error=access_denied',
    },
  },
  error: {
    file: 'error.ejs',
    data: {
      syloVersion: '5.0.0',
      title: 'Forbidden',
      heading: 'Not an admin',
      message:
        'You need Manage Server (or a bot-master role) in this server to manage it here, and Sylo has to be in it.',
    },
  },
  'verify-challenge': { file: 'verify.ejs', data: verify({}) },
  'verify-done': {
    file: 'verify.ejs',
    data: verify({ state: 'done', message: 'You are verified in Hedgerow HQ.' }),
  },
  'verify-error': {
    file: 'verify.ejs',
    data: verify({ state: 'error', message: 'This verification link is invalid or has expired.' }),
  },
  'appeal-form': { file: 'appeal.ejs', data: appeal({}) },
  'appeal-accepted': {
    file: 'appeal.ejs',
    data: appeal({
      state: 'decided',
      verdict: 'accepted',
      decisionReason: 'Thanks for being honest.',
      rejoinInvite: 'https://discord.gg/rejoin',
    }),
  },
  'appeal-denied': {
    file: 'appeal.ejs',
    data: appeal({ state: 'decided', verdict: 'denied', decisionReason: 'Repeated spam.', reappealDays: 14 }),
  },
  leaderboard: { file: 'leaderboard.ejs', data: board({}) },
  'leaderboard-empty': { file: 'leaderboard.ejs', data: board({ members: [], total: 0, pages: 1 }) },
};

export const renderSample = (name) => ejs.renderFile(join(VIEWS, SAMPLES[name].file), SAMPLES[name].data);

/** Render the real `error` view for given locals, the way a caller's res.render would. */
export const renderError = (locals, resLocals = {}) =>
  ejs.renderFile(join(VIEWS, 'error.ejs'), {
    syloVersion: '5.0.0',
    authEnabled: true,
    ...resLocals,
    ...locals,
  });

/**
 * Run a middleware or handler against a stand-in `res` whose render() uses the app's real view
 * engine. Resolves with { status, html } for a rendered page, or { status, json } for JSON.
 * @param {import('express').Express} app
 * @param {(res: object) => unknown} run
 */
export function capture(app, run, resLocals = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      locals: { authEnabled: true, syloVersion: '5.0.0', ...resLocals },
      status(code) {
        this.statusCode = code;
        return this;
      },
      set() {
        return this;
      },
      json(json) {
        resolve({ status: this.statusCode, json });
      },
      end() {
        resolve({ status: this.statusCode });
      },
      render(view, locals) {
        app.render(view, { ...this.locals, ...locals }, (err, html) =>
          err ? reject(err) : resolve({ status: this.statusCode, html })
        );
      },
    };
    Promise.resolve(run(res)).catch(reject);
  });
}

/** Assertions every public page has to meet. */
export function plainProblems(html) {
  const problems = [];
  if (CLASSIC_CHROME.test(html)) problems.push(`classic chrome: ${html.match(CLASSIC_CHROME)[0]}`);
  if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) problems.push('inline <script>');
  if (/<style[\s>]/i.test(html)) problems.push('inline <style>');
  if (/\sstyle\s*=/i.test(html)) problems.push('inline style attribute');
  if (/\son[a-z]+\s*=/i.test(html)) problems.push('inline event handler');
  if (!/<link rel="stylesheet" href="\/public\.css"/.test(html)) problems.push('no /public.css');
  const head = html.slice(0, html.indexOf('</head>'));
  if (!/<script src="\/theme\.js"><\/script>/.test(head)) problems.push('no plain /theme.js in <head>');
  if (/\/styles\.css/.test(html)) problems.push('still links /styles.css');
  return problems;
}
