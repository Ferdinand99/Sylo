import { startWebApp, post } from './helpers/webApp.js';
import { GID, CH } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { localizeTemplate, translate } from '../src/web/lib/i18n.js';
import { setGuildModule, getGuildModule } from '../src/db/modules.js';
import { MODULES } from '../src/modules/registry.js';

let app;
test.before(async () => {
  app = await startWebApp();
});
test.after(() => app.close());
const cookie = { cookie: 'sylo_language=pl' };

test('PL switch sets a persistent cookie; EN switch overrides it', async () => {
  const response = await fetch(`${app.base}/guilds/${GID}/m/tickets?lang=pl`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /sylo_language=pl/);
  const html = await response.text();
  assert.match(html, /<html lang="pl">/);
  assert.match(html, /Zapisz i opublikuj panel/);
  assert.match(html, /Dodaj temat/);
  assert.match(html, /lang=pl[^>]*.*aria-current="true"/);
  const en = await fetch(`${app.base}/guilds/${GID}/m/tickets?lang=en`, { headers: cookie });
  assert.match(await en.text(), /Save and publish panel/);
  assert.match(en.headers.get('set-cookie'), /sylo_language=en/);
});

test('HTMX fragments and saved flash messages use the cookie language', async () => {
  const response = await fetch(`${app.base}/guilds/${GID}/m/logging`, {
    headers: { ...cookie, 'HX-Request': 'true' },
  });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Domyślny kanał logów/);
  assert.match(html, /Dołączenie na kanał głosowy/);
  assert.doesNotMatch(html, /class="sidebar"/);
  const page = await fetch(`${app.base}/guilds/${GID}/m/logging?msg=saved`, { headers: cookie });
  assert.match(await page.text(), /Zapisano/);
});

test('Polish overview translates module cards and preserves Discord names', async () => {
  app.guild.name = 'Save';
  const response = await fetch(`${app.base}/guilds/${GID}/overview`, { headers: cookie });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Logi serwera/);
  assert.match(html, /Skargi i opinie/);
  assert.match(html, /class="page-title">Save</);
});

test('all configurable V1 module pages render in Polish', async () => {
  for (const module of MODULES.filter((m) => m.configurable)) {
    const response = await fetch(`${app.base}/guilds/${GID}/m/${module.id}`, { headers: cookie });
    assert.equal(response.status, 200, module.id);
    const html = await response.text();
    assert.match(html, /<html lang="pl">/, module.id);
    assert.doesNotMatch(html, /Internal server error/, module.id);
    assert.ok(!html.includes(`>${module.description}<`), `Untranslated description: ${module.id}`);
  }
});

test('editable values and Discord publications stay unchanged in Polish', async () => {
  await setGuildModule(GID, 'feedback', {
    enabled: true,
    config: {
      panelChannel: CH.general,
      reviewChannel: CH.bots,
      title: 'Save',
      message: 'Message',
      buttonLabel: 'Open',
    },
  });
  const page = await fetch(`${app.base}/guilds/${GID}/m/feedback`, { headers: cookie });
  const html = await page.text();
  assert.match(html, /value="Save"/);
  assert.match(html, />Message<\/textarea>/);
  assert.match(html, /value="Open"/);
  const result = await post(
    app.base,
    `/guilds/${GID}/m/feedback/config`,
    {
      panelChannel: CH.general,
      reviewChannel: CH.bots,
      title: 'Save',
      message: 'Message',
      buttonLabel: 'Open',
      action: 'publish',
    },
    cookie
  );
  assert.equal(result.status, 302);
  const saved = await getGuildModule(GID, 'feedback');
  assert.equal(saved.config.title, 'Save');
  assert.equal(saved.config.message, 'Message');
});

test('template localization escapes UI and never translates editable content or scripts', () => {
  const source =
    '<label>Save</label><input value="Save" placeholder="Description" /><textarea><%= message %></textarea><p><%= member.name %></p><script>const text="Save";</script>';
  const html = ejs.render(localizeTemplate(source), {
    uiText: (text) => translate(text, 'pl'),
    message: 'Save',
    member: { name: 'Message' },
  });
  assert.match(html, /<label>Zapisz<\/label>/);
  assert.match(html, /value="Save" placeholder="Opis"/);
  assert.match(html, /<textarea>Save<\/textarea>/);
  assert.match(html, /<p>Message<\/p>/);
  assert.match(html, /const text="Save"/);
});

test('every translated template compiles, including EJS inside attributes', () => {
  function check(path) {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const filename = join(path, item.name);
      if (item.isDirectory()) check(filename);
      else if (item.name.endsWith('.ejs'))
        assert.doesNotThrow(
          () => ejs.compile(localizeTemplate(readFileSync(filename, 'utf8')), { filename }),
          filename
        );
    }
  }
  check(new URL('../src/web/views', import.meta.url).pathname);
});

test('localization preserves conditional state comparisons and names', () => {
  const source = "<p><%= status === 'accepted' ? 'Accepted' : 'Denied' %></p><p><%= m.name %></p>";
  const html = ejs.render(localizeTemplate(source), {
    uiText: (text) => translate(text, 'pl'),
    status: 'accepted',
    m: { name: 'Save' },
  });
  assert.equal(html, '<p>Zaakceptowano</p><p>Save</p>');
});

test('browser and server translations agree for toasts and dynamic values', async () => {
  const response = await fetch(`${app.base}/dashboard-translations.js`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  const window = {};
  runInNewContext(await response.text(), { window });
  for (const message of [
    'Saved',
    'Test sent to #Save',
    'Server logging enabled',
    'Request failed (403) — reload the page and try again.',
    '3 selected',
    'Every 5 minutes',
    'Every 2 hours',
    'Every 2 days',
  ]) {
    assert.equal(window.syloTranslate(message, 'pl'), translate(message, 'pl'));
    assert.equal(window.syloTranslate(message, 'en'), message);
  }
  assert.equal(window.syloTranslate('Unknown custom text', 'pl'), 'Unknown custom text');
});

test('all built-in command and option descriptions have Polish dashboard translations', async () => {
  function check(definition) {
    if (definition.description && !/[ąćęłńóśźż]/i.test(definition.description)) {
      assert.notEqual(
        translate(definition.description, 'pl'),
        definition.description,
        definition.description
      );
    }
    for (const option of definition.options || []) check(option);
  }
  const folder = new URL('../src/bot/commands/', import.meta.url);
  for (const filename of readdirSync(folder).filter((name) => name.endsWith('.js'))) {
    const command = await import(new URL(filename, folder));
    if (command.data) check(command.data.toJSON());
  }
});

test('embed hints and static UI metadata translate while editable messages stay intact', () => {
  const html = ejs.render(
    localizeTemplate(
      '<div data-ph="Field name"><%= v.label %></div><p><%= c.description %></p><textarea><%= c.description %></textarea>'
    ),
    {
      uiText: (text) => translate(text, 'pl'),
      v: { label: 'Description' },
      c: { description: "Show a member's moderation history." },
    }
  );
  assert.match(html, /data-ph="Nazwa pola"/);
  assert.match(html, />Opis<\/div>/);
  assert.match(html, /Pokaż historię moderacji użytkownika/);
  assert.match(html, /<textarea>Show a member&#39;s moderation history\.<\/textarea>/);
});

test('invalid language falls back safely and does not set a preference cookie', async () => {
  const response = await fetch(`${app.base}/?lang=xx`);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(await response.text(), /<html lang="pl">/);
});
