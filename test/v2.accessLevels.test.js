// Dashboard access levels (src/web/middleware/access.js, src/web/lib/routeAccess.js): every /api/v2
// route declares the level it needs, View may only read, Inbox may also act on the inboxes, Edit may
// do everything, and Manage Server, Administrator, the server owner and the bot-master roles keep
// Edit. Checked through the real app for web sessions, app tokens and a Fluxer server.
// Each person sends requests from their own address, so the per-client rate limits do not add up.
import './helpers/trustLoopbackProxy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  D_GUILD,
  F_GUILD,
  OTHER_D_GUILD,
  browser,
  memberFetches,
  profiles,
  setProfiles,
  signIn,
  startOAuthApp,
} from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { findIdentity } = await import('../src/db/accounts.js');
const { createApiToken } = await import('../src/db/apiTokens.js');
const { getDashboardAccessRoles, setBotMasterRoles, setDashboardAccessRoles } =
  await import('../src/db/guildSettings.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { prepare } = await import('../src/db/driver.js');
const { createTicket, addTicketMessage } = await import('../src/db/tickets.js');
const { createAppeal, getAppeal } = await import('../src/db/appeals.js');
const { insertForm, insertSubmission, setSubmissionRoles } = await import('../src/db/applications.js');
const { getSubmission } = await import('../src/modules/applications.js');
const { normaliseForm } = await import('../src/modules/lib/applicationsForm.js');
const { createSuggestion } = await import('../src/db/suggestions.js');
const { createGithubWatch } = await import('../src/db/githubWatches.js');
const { accountMaySeeTickets } = await import('../src/web/middleware/ticketAccess.js');
const access = await import('../src/web/middleware/access.js');
const { ROUTE_ACCESS } = await import('../src/web/lib/routeAccess.js');
// Every router the API is built from (v2Api.js imports the per-server ones).
const { default: v2ApiRouter } = await import('../src/web/routes/v2Api.js');
const { default: v2PublicRouter } = await import('../src/web/routes/v2Public.js');

const dGuild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const fGuild = runtime.clients.fluxer.guilds.cache.get(F_GUILD);
const F_KEY = `fluxer:${F_GUILD}`;

const VIEW = '700000000000000501';
const INBOX = '700000000000000502';
const MASTER = '700000000000000503';
const OTHER_ROLE = '700000000000000504';

function fakeMember(id, { perms = [], roles = [] } = {}) {
  const cache = new Map(roles.map((r) => [r, { id: r }]));
  cache.hasAny = (...ids) => ids.some((r) => cache.has(r));
  cache.some = (fn) => [...cache.values()].some(fn);
  return { id, permissions: { has: (p) => perms.includes(p) }, roles: { highest: { position: 5 }, cache } };
}

/**
 * Someone signed in to the web dashboard who does not manage D_GUILD at sign-in (so only a role, or
 * a live right, lets them in), holding `roles` there. Returns JSON helpers for the session and for
 * an app token of the same account.
 */
let clients = 0;
/** A browser that sends its requests from an address of its own. */
function ownBrowser() {
  const b = browser();
  const ip = `10.9.${Math.floor(++clients / 250)}.${clients % 250}`;
  return {
    ...b,
    get: (path, init = {}) => b.get(path, { ...init, headers: { ...init.headers, 'x-forwarded-for': ip } }),
  };
}

async function person({ roles = [], perms = [], platform = 'discord' } = {}) {
  setProfiles();
  profiles.discord.guilds = [{ id: D_GUILD, owner: false, permissions: '0' }];
  profiles.fluxer.guilds = [{ id: F_GUILD, owner: false, permissions: '0' }];
  const b = ownBrowser();
  await signIn(b, platform);
  const id = profiles[platform].id;
  (platform === 'discord' ? dGuild : fGuild).members.cache.set(id, fakeMember(id, { perms, roles }));
  const csrf = (await (await b.get('/api/v2/csrf')).json()).token;
  const { accountId } = await findIdentity(platform, id);
  const { token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 });
  const json = { accept: 'application/json', 'content-type': 'application/json' };
  const web = {
    get: (p) => b.get(`/api/v2${p}`, { headers: { accept: 'application/json' } }),
    post: (p, body = {}) =>
      b.get(`/api/v2${p}`, {
        method: 'POST',
        headers: { ...json, 'x-csrf-token': csrf },
        body: JSON.stringify(body),
      }),
  };
  const auth = { authorization: `Bearer ${token}` };
  const app = {
    get: (p) => b.get(`/api/v2${p}`, { headers: { ...auth, accept: 'application/json' } }),
    post: (p, body = {}) =>
      ownBrowser().get(`/api/v2${p}`, {
        method: 'POST',
        headers: { ...json, ...auth },
        body: JSON.stringify(body),
      }),
  };
  return { id, accountId, web, app };
}

test.beforeEach(async () => {
  await setBotMasterRoles(D_GUILD, [MASTER]);
  await setDashboardAccessRoles(D_GUILD, { inbox: [INBOX], view: [VIEW] });
  await setDashboardAccessRoles(F_KEY, { inbox: [], view: [VIEW] });
});
test.afterEach(() => {
  dGuild.members.cache.clear();
  fGuild.members.cache.clear();
  dGuild.ownerId = 'x';
});

const g = (path) => `/guilds/${D_GUILD}${path}`;
// Representative routes: reads, inbox actions (unknown ids: the route answers 404 or 400 once the
// level lets the request through), and config writes.
const READS = ['/overview', '/settings', '/access', '/modules/afk/config', '/audit', '/tickets', '/appeals'];
// [path, body, the status the route itself answers once the level lets the request in]: an unknown
// item gives a known status, so a request that never reached the route cannot pass.
const INBOX_ACTIONS = [
  ['/tickets/999999/reply', { content: 'hi' }, 404],
  ['/tickets/999999/close', {}, 404],
  ['/appeals/999999/decide', { decision: 'deny' }, 409],
  ['/applications/submissions/999999/decide', { action: 'deny' }, 404],
  ['/modules/suggestions/999999/decision', { action: 'approve' }, 404],
];
const WRITES = [
  ['/modules/afk', { enabled: true }, 200],
  ['/settings', { botMasterRoleIds: [MASTER], modlogChannelId: '' }, 200],
  ['/modules/afk/config', {}, 200],
  ['/moderation/warnings/clear', { userId: '810000000000000001' }, 404],
  ['/access', { viewRoleIds: [VIEW, OTHER_ROLE] }, 200],
];

async function expectLevel(client, level) {
  for (const p of READS) {
    assert.equal((await client.get(g(p))).status, 200, `${level} reads ${p}`);
  }
  for (const [p, body, reached] of INBOX_ACTIONS) {
    const res = await client.post(g(p), body);
    if (level === 'view') {
      assert.equal(res.status, 403, `view may not ${p}`);
      assert.equal((await res.json()).required, 'inbox');
    } else {
      assert.equal(res.status, reached, `${level} may ${p}`);
    }
  }
  for (const [p, body, reached] of WRITES) {
    const res = await client.post(g(p), body);
    if (level === 'edit') {
      assert.equal(res.status, reached, `edit may ${p}`);
    } else {
      assert.equal(res.status, 403, `${level} may not ${p}`);
      const answer = await res.json();
      assert.equal(answer.access, level);
      assert.equal(answer.required, 'edit');
      assert.match(answer.error, level === 'view' ? /View only/ : /Inbox only/);
    }
  }
}

// --- the route list ------------------------------------------------------------------------------

// The only per-server GETs that need more than view. A new one has to be added here on purpose.
const GETS_ABOVE_VIEW = {
  'GET /guilds/:guildId/tickets/:ticketId': 'inbox',
  'GET /guilds/:guildId/tickets/:ticketId/messages': 'inbox',
  'GET /guilds/:guildId/tickets/:ticketId/transcript': 'inbox',
  'GET /guilds/:guildId/applications/submissions/:id': 'inbox',
  'GET /guilds/:guildId/applications/export': 'inbox',
  'GET /guilds/:guildId/export': 'edit',
};

test('every /api/v2 route declares its access level, and every declaration has a route', () => {
  assert.deepEqual(access.undeclaredRoutes(), [], 'list these in src/web/lib/routeAccess.js');
  assert.deepEqual(access.unusedDeclarations(), [], 'no route has these keys any more');
  for (const [key, level] of access.registeredRoutes()) {
    const perServer = key.split(' ')[1].startsWith('/guilds/:guildId');
    if (perServer) assert.ok(['view', 'inbox', 'edit'].includes(level), `${key}: ${level}`);
    // A GET changes nothing, so it needs view, except the ones named in GETS_ABOVE_VIEW.
    if (perServer && key.startsWith('GET ')) assert.equal(level, GETS_ABOVE_VIEW[key] ?? 'view', key);
  }
  for (const [key, level] of Object.entries(GETS_ABOVE_VIEW)) assert.equal(ROUTE_ACCESS[key], level, key);
  assert.equal(ROUTE_ACCESS[`GET /guilds/:guildId/access`], 'view');
  assert.equal(ROUTE_ACCESS[`POST /guilds/:guildId/access`], 'edit');
});

// A router made with a plain Router() and mounted under the API would give its routes no level
// guard at all (only the "any level" check of requireGuildAccess): every route anywhere in the tree
// must start with an access guard.
test('every route in the API tree starts with its access guard', () => {
  const unguarded = [];
  const walk = (router, where) => {
    for (const layer of router.stack) {
      if (layer.route) {
        const first = layer.route.stack[0]?.handle;
        if (!first?.accessLevel) unguarded.push(`${where} ${layer.route.path}`);
      } else if (Array.isArray(layer.handle?.stack)) {
        walk(layer.handle, `${where} > ${layer.name}`);
      } else if (!layer.handle?.accessMiddleware) {
        // Mounted with use, so it runs without a level guard: only marked middleware may be.
        unguarded.push(`${where} use(${layer.name})`);
      }
    }
  };
  walk(v2ApiRouter, '/api/v2');
  walk(v2PublicRouter, '/api/v2/public');
  assert.deepEqual(unguarded, [], 'build these routers with accessRouter (src/web/middleware/access.js)');
});

test('a route left out of the list needs edit, and an access router refuses what it cannot check', async () => {
  const router = access.accessRouter('/guilds/:guildId', { mergeParams: true });
  router.post('/test-only-undeclared', (_req, res) => res.json({ ok: true }));
  assert.ok(access.undeclaredRoutes().includes('POST /guilds/:guildId/test-only-undeclared'));
  const layer = router.stack.find((l) => l.route?.path === '/test-only-undeclared');
  const guard = layer.route.stack[0].handle;
  assert.equal(guard.accessLevel, 'edit');
  const run = (accessLevel) =>
    new Promise((resolve) => {
      const res = { status: (s) => ({ json: (body) => resolve({ status: s, body }) }) };
      guard({ access: accessLevel }, res, () => resolve({ status: 'next' }));
    });
  assert.equal((await run('edit')).status, 'next');
  assert.equal((await run('inbox')).status, 403);
  assert.equal((await run('view')).status, 403);
  assert.equal((await run(undefined)).status, 403, 'no level worked out: refused, not passed');

  const write = (_req, res) => res.json({ written: true });
  assert.throws(() => router.use('/x', write), /useMiddleware/);
  assert.doesNotThrow(() => router.use(access.useMiddleware((_req, _res, next) => next())));
  assert.throws(() => router.all('/x', () => {}), /not available/);
  assert.throws(() => router.route('/x'), /not available/);
  assert.throws(() => router.get(/x/, () => {}), /must be a string/);
  assert.throws(() => access.accessRouter('').get('/account', () => {}), /registered twice/);
});

// --- the levels -----------------------------------------------------------------------------------

test('View: reads only, on the web and in the app', async () => {
  const { web, app } = await person({ roles: [VIEW] });
  await expectLevel(web, 'view');
  await expectLevel(app, 'view');
  assert.equal((await (await web.get(g('/access'))).json()).level, 'view');
});

test('Inbox: reads and inbox actions, no config writes', async () => {
  const { web, app } = await person({ roles: [INBOX] });
  await expectLevel(web, 'inbox');
  await expectLevel(app, 'inbox');
  assert.equal((await (await app.get(g('/access'))).json()).level, 'inbox');
});

test('Edit through a bot-master role, Manage Server, Administrator or ownership: everything', async () => {
  const master = await person({ roles: [MASTER, VIEW] });
  await expectLevel(master.web, 'edit');
  await expectLevel(master.app, 'edit');
  for (const perms of [['ManageGuild'], ['Administrator']]) {
    const { app } = await person({ perms });
    await expectLevel(app, 'edit');
  }
  const owner = await person({ roles: [VIEW] });
  dGuild.ownerId = owner.id;
  await expectLevel(owner.app, 'edit');
});

test('the highest role wins, and no role means no access', async () => {
  const both = await person({ roles: [VIEW, INBOX] });
  assert.equal((await (await both.web.get(g('/access'))).json()).level, 'inbox');
  const none = await person({ roles: [OTHER_ROLE] });
  assert.equal((await none.web.get(g('/overview'))).status, 403);
  assert.equal((await none.app.get(g('/overview'))).status, 403);
  assert.equal((await none.web.get(g('/tickets'))).status, 403);
});

test('losing the role takes effect at once for the app', async () => {
  const { id, app } = await person({ roles: [INBOX] });
  assert.equal((await app.get(g('/overview'))).status, 200);
  dGuild.members.cache.set(id, fakeMember(id, { roles: [] }));
  assert.equal((await app.get(g('/overview'))).status, 403);
});

test('a role in one server gives nothing in another', async () => {
  const { id, web, app } = await person({ roles: [VIEW, INBOX, MASTER] });
  const other = runtime.clients.discord.guilds.cache.get(OTHER_D_GUILD);
  other.members.cache.set(id, fakeMember(id, { roles: [VIEW, INBOX, MASTER] }));
  try {
    for (const client of [web, app]) {
      assert.equal((await client.get(`/guilds/${OTHER_D_GUILD}/overview`)).status, 403);
      assert.equal((await client.get(`/guilds/${OTHER_D_GUILD}/tickets`)).status, 403);
      assert.equal(
        (await client.post(`/guilds/${OTHER_D_GUILD}/modules/afk`, { enabled: true })).status,
        403
      );
    }
  } finally {
    other.members.cache.clear();
  }
});

test('a token does not make the bot look people up in a server without access roles', async () => {
  const { app } = await person();
  await setBotMasterRoles(OTHER_D_GUILD, []);
  const before = memberFetches.length;
  assert.equal((await app.get(`/guilds/${OTHER_D_GUILD}/overview`)).status, 403);
  assert.equal(memberFetches.length, before);
});

test('Fluxer: the same levels through the platform layer', async () => {
  const { web, app } = await person({ platform: 'fluxer', roles: [VIEW] });
  for (const client of [web, app]) {
    assert.equal((await client.get(`/guilds/${F_KEY}/overview`)).status, 200);
    const write = await client.post(`/guilds/${F_KEY}/modules/afk`, { enabled: true });
    assert.equal(write.status, 403);
    assert.equal((await write.json()).required, 'edit');
  }
  // The Discord server's View role is not a Fluxer role.
  assert.equal((await web.get(g('/overview'))).status, 403);
});

// --- the server list ------------------------------------------------------------------------------

test('the server list offers servers reached through a role, with the level', async () => {
  const view = await person({ roles: [VIEW] });
  for (const client of [view.web, view.app]) {
    const row = (await (await client.get('/guilds')).json()).guilds.find((x) => x.id === D_GUILD);
    assert.equal(row?.access, 'view');
  }
  const none = await person({ roles: [OTHER_ROLE] });
  const ids = (await (await none.web.get('/guilds')).json()).guilds.map((x) => x.id);
  assert.ok(!ids.includes(D_GUILD));
});

// --- the access settings ----------------------------------------------------------------------------

test('only Edit can change the access settings, and only Manage Server the Edit roles', async () => {
  const view = await person({ roles: [VIEW] });
  const inbox = await person({ roles: [INBOX] });
  for (const client of [view.web, view.app, inbox.web, inbox.app]) {
    assert.equal((await client.post(g('/access'), { viewRoleIds: [OTHER_ROLE] })).status, 403);
  }
  assert.deepEqual((await getDashboardAccessRoles(D_GUILD)).view, [VIEW], 'nothing changed');

  const master = await person({ roles: [MASTER] });
  const saved = await master.web.post(g('/access'), { inboxRoleIds: [INBOX, OTHER_ROLE], viewRoleIds: [] });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.deepEqual(body.inboxRoleIds, [INBOX, OTHER_ROLE]);
  assert.deepEqual(body.viewRoleIds, []);
  assert.equal(body.canChangeEditRoles, false);
  const widen = await master.web.post(g('/access'), { editRoleIds: [MASTER, OTHER_ROLE] });
  assert.equal(widen.status, 403, 'a bot master may not choose the bot masters');
  assert.deepEqual((await getDashboardAccessRoles(D_GUILD)).edit, [MASTER]);
  // @everyone (the server's own id) is never an access role, and junk is refused.
  await master.web.post(g('/access'), { viewRoleIds: [D_GUILD, VIEW] });
  assert.deepEqual((await getDashboardAccessRoles(D_GUILD)).view, [VIEW]);
  assert.equal((await master.web.post(g('/access'), { viewRoleIds: 'x' })).status, 400);
  assert.equal((await master.web.post(g('/access'), {})).status, 400);

  const manager = await person({ perms: ['ManageGuild'] });
  const changed = await manager.app.post(g('/access'), { editRoleIds: [MASTER, OTHER_ROLE] });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).canChangeEditRoles, true);
  assert.deepEqual((await getDashboardAccessRoles(D_GUILD)).edit, [MASTER, OTHER_ROLE]);
});

// --- what a lower level reads -------------------------------------------------------------------

test('View does not see GitHub webhook secrets', async () => {
  await createGithubWatch(D_GUILD, { repo: 'o/r', channelId: '900000000000000301', events: ['push'] });
  const view = await person({ roles: [VIEW] });
  const watches = (await (await view.web.get(g('/modules/github/watches'))).json()).watches;
  assert.ok(watches.length > 0);
  assert.ok(watches.every((w) => w.secret === null && w.webhookUrl === null));
  const master = await person({ roles: [MASTER] });
  const full = (await (await master.web.get(g('/modules/github/watches'))).json()).watches;
  assert.ok(full.every((w) => typeof w.secret === 'string' && w.secret.length > 0));
});

test('ticket notifications go to Inbox and Edit, not to View', async () => {
  await setGuildModule(D_GUILD, 'tickets', { enabled: true });
  const view = await person({ roles: [VIEW] });
  const inbox = await person({ roles: [INBOX] });
  const { identitiesOf } = await import('../src/db/accounts.js');
  const live = { live: true };
  const acc = async (p) => ({ id: p.accountId, identities: await identitiesOf(p.accountId) });
  assert.equal(await accountMaySeeTickets(await acc(view), D_GUILD, live), false);
  assert.equal(await accountMaySeeTickets(await acc(inbox), D_GUILD, live), true);
});

// --- inbox content needs Inbox ---------------------------------------------------------------------

test('View sees the inbox lists without their content, and is refused the content itself', async () => {
  const applicant = '810000000000000777';
  const ticket = await createTicket(D_GUILD, applicant);
  await addTicketMessage(ticket.id, {
    authorId: applicant,
    authorKind: 'user',
    content: 'my secret problem',
  });
  const appealId = await createAppeal(D_GUILD, { userId: applicant, answers: [{ q: 'Why?', a: 'sorry' }] });
  const formId = await insertForm({
    guildId: D_GUILD,
    name: 'Staff',
    enabled: true,
    fillMode: 'web',
    config: normaliseForm({ name: 'Staff', fillMode: 'web' }),
  });
  const subId = await insertSubmission({
    guildId: D_GUILD,
    formId,
    formName: 'Staff',
    userId: applicant,
    source: 'web',
    questions: [],
    answers: {},
  });
  await setGuildModule(D_GUILD, 'suggestions', { enabled: true });
  await createSuggestion({
    guildId: D_GUILD,
    channelId: '900000000000000301',
    authorId: applicant,
    anonymous: true,
    body: 'an idea',
  });

  const view = await person({ roles: [VIEW] });
  const inbox = await person({ roles: [INBOX] });
  const CONTENT = [
    `/tickets/${ticket.id}`,
    `/tickets/${ticket.id}/messages`,
    `/tickets/${ticket.id}/transcript`,
    `/applications/submissions/${subId}`,
    `/applications/export?formId=${formId}`,
  ];
  for (const client of [view.web, view.app]) {
    for (const p of CONTENT) {
      const res = await client.get(g(p));
      assert.equal(res.status, 403, `view may not read ${p}`);
      assert.equal((await res.json()).required, 'inbox');
    }
  }
  for (const p of CONTENT) assert.equal((await inbox.web.get(g(p))).status, 200, `inbox reads ${p}`);

  const lists = async (client) => ({
    tickets: await (await client.get(g('/tickets'))).json(),
    appeals: await (await client.get(g('/appeals'))).json(),
    subs: await (await client.get(g('/applications/submissions'))).json(),
    sugs: await (await client.get(g('/modules/suggestions/list'))).json(),
  });
  const hidden = await lists(view.web);
  assert.equal(hidden.tickets.open.find((x) => x.id === ticket.id).preview, null);
  assert.equal(hidden.tickets.contentHidden, true);
  const a = hidden.appeals.appeals.find((x) => x.id === appealId);
  assert.deepEqual(a.answers, []);
  assert.equal(a.decisionReason, null);
  assert.equal(hidden.appeals.contentHidden, true);
  assert.equal(hidden.subs.contentHidden, true);
  const anon = hidden.sugs.suggestions.filter((x) => x.anonymous);
  assert.ok(anon.length > 0);
  assert.ok(anon.every((x) => x.authorId === null && x.author === null));

  const shown = await lists(inbox.web);
  assert.equal(shown.tickets.open.find((x) => x.id === ticket.id).preview, 'my secret problem');
  assert.equal(shown.tickets.contentHidden, false);
  assert.ok(shown.appeals.appeals.find((x) => x.id === appealId).answers.length > 0);
  assert.ok(shown.sugs.suggestions.some((x) => x.anonymous && x.authorId === applicant));
});

test('a ticket staff role reaches the tickets, and nothing else', async () => {
  const STAFF = '700000000000000505';
  await setGuildModule(D_GUILD, 'tickets', { enabled: true, config: { staffRoles: [STAFF] } });
  try {
    const staff = await person({ roles: [STAFF] });
    for (const client of [staff.web, staff.app]) {
      assert.equal((await client.get(g('/tickets'))).status, 200);
      assert.equal((await client.get(g('/overview'))).status, 403);
      assert.equal((await client.get(g('/appeals'))).status, 403);
    }
  } finally {
    await setGuildModule(D_GUILD, 'tickets', { enabled: true, config: { staffRoles: [] } });
  }
});

// --- deciding an application checks the person deciding --------------------------------------------

const HIGH = '700000000000000601';
const LOW = '700000000000000602';
function addRoles() {
  const role = (id, position) => ({
    id,
    name: `role-${position}`,
    position,
    permissions: { has: () => false },
  });
  dGuild.roles.cache.set(HIGH, role(HIGH, 10));
  dGuild.roles.cache.set(LOW, role(LOW, 1));
  dGuild.roles.cache.set(MASTER, role(MASTER, 2));
}
let applicants = 0;
async function pendingApplication(grants, applicant) {
  const config = normaliseForm({ name: 'Mods', fillMode: 'web', acceptAddRoleIds: grants });
  const formId = await insertForm({ guildId: D_GUILD, name: 'Mods', enabled: true, fillMode: 'web', config });
  return insertSubmission({
    guildId: D_GUILD,
    formId,
    formName: 'Mods',
    userId: applicant ?? `8100000000001${String(++applicants).padStart(5, '0')}`,
    source: 'web',
    questions: [],
    answers: {},
  });
}
const decide = (client, id, action) => client.post(g(`/applications/submissions/${id}/decide`), { action });

test('approving needs the right to hand out every role the decision gives', async () => {
  addRoles();
  try {
    const inbox = await person({ roles: [INBOX] });
    const high = await pendingApplication([HIGH]);
    const refused = await decide(inbox.web, high, 'accept');
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /above or equal to your highest role/);
    assert.equal((await getSubmission(D_GUILD, high)).status, 'pending', 'nothing was decided');

    // A role that gives Edit access is refused below Edit, even under the person's own top role.
    const master = await pendingApplication([MASTER]);
    const toEdit = await decide(inbox.app, master, 'accept');
    assert.equal(toEdit.status, 403);
    assert.match((await toEdit.json()).error, /gives Edit access/);
    assert.equal((await getSubmission(D_GUILD, master)).status, 'pending');

    const low = await pendingApplication([LOW]);
    assert.equal((await decide(inbox.web, low, 'accept')).status, 200);
    assert.equal((await getSubmission(D_GUILD, low)).status, 'accepted');
  } finally {
    dGuild.roles.cache.clear();
  }
});

test('retrying the roles follows the same rule, and nobody decides their own application', async () => {
  addRoles();
  try {
    const inbox = await person({ roles: [INBOX] });
    const id = await pendingApplication([]);
    await setSubmissionRoles(D_GUILD, id, [{ op: 'add', roleId: HIGH }], []);
    assert.equal((await inbox.web.post(g(`/applications/submissions/${id}/retry-roles`))).status, 403);
    await setSubmissionRoles(D_GUILD, id, [{ op: 'add', roleId: LOW }], []);
    assert.equal((await inbox.web.post(g(`/applications/submissions/${id}/retry-roles`))).status, 200);

    const own = await pendingApplication([], inbox.id);
    const self = await decide(inbox.web, own, 'accept');
    assert.equal(self.status, 403);
    assert.match((await self.json()).error, /your own application/);
    assert.equal((await getSubmission(D_GUILD, own)).status, 'pending');
    const master = await person({ roles: [MASTER] });
    const mine = await pendingApplication([], master.id);
    assert.equal((await decide(master.web, mine, 'deny')).status, 403, 'not with Edit either');
  } finally {
    dGuild.roles.cache.clear();
  }
});

test('accepting an appeal with Inbox access needs Ban Members', async () => {
  const id = await createAppeal(D_GUILD, { userId: '810000000000000999', answers: [] });
  const inbox = await person({ roles: [INBOX] });
  const res = await inbox.web.post(g(`/appeals/${id}/decide`), { decision: 'accept' });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Ban Members/);
  assert.equal((await getAppeal(D_GUILD, id)).status, 'open');
  // Denying needs no more than Inbox.
  assert.equal((await inbox.web.post(g(`/appeals/${id}/decide`), { decision: 'deny' })).status, 200);
});

// --- a web session past its snapshot window -------------------------------------------------------

test('a web session past its snapshot window is checked live: a removed role counts at once', async () => {
  const { id, web } = await person({ roles: [INBOX] });
  await prepare('UPDATE account_identities SET guilds_fetched_at = 0 WHERE platform_user_id = ?').run(id);
  assert.equal((await web.get(g('/overview'))).status, 200);
  assert.equal((await web.post(g('/modules/afk'), { enabled: true })).status, 403);
  dGuild.members.cache.set(id, fakeMember(id, { roles: [] }));
  assert.equal((await web.get(g('/overview'))).status, 403);
});

test('the server list leaves out a server where the cached member lacks the role, or is no member', async () => {
  const view = await person({ roles: [VIEW] });
  dGuild.members.cache.set(view.id, fakeMember(view.id, { roles: [OTHER_ROLE] }));
  assert.ok(!(await (await view.web.get('/guilds')).json()).guilds.some((x) => x.id === D_GUILD));
  dGuild.members.cache.delete(view.id);
  assert.ok(!(await (await view.app.get('/guilds')).json()).guilds.some((x) => x.id === D_GUILD));
});

// --- settings that hold a secret ----------------------------------------------------------------

test('below Edit: RSS feed URLs show only their origin; no config download, no insights refresh', async () => {
  await setGuildModule(D_GUILD, 'rss', {
    enabled: true,
    config: {
      feeds: [
        { type: 'url', ref: 'https://feeds.example.com/x?token=s3cret', channelId: '900000000000000301' },
      ],
    },
  });
  const view = await person({ roles: [VIEW] });
  const masked = JSON.stringify(await (await view.web.get(g('/modules/rss/config'))).json());
  assert.doesNotMatch(masked, /s3cret/);
  assert.match(masked, /https:\/\/feeds\.example\.com\/…/);
  const master = await person({ roles: [MASTER] });
  assert.match(JSON.stringify(await (await master.web.get(g('/modules/rss/config'))).json()), /s3cret/);
  assert.equal((await view.web.get(g('/export'))).status, 403);
  assert.equal((await master.web.get(g('/export'))).status, 200);
  assert.equal((await view.web.post(g('/insights/refresh'))).status, 403);
});
