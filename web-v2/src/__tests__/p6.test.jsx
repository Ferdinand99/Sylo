import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISCORD,
  discordJsonToSpec,
  messageLimits,
  parseMessageJson,
  specToDiscordJson,
} from '../embedJson.js';
import { TEMPLATES, embedFor, templatesForText } from '../messageTemplates.js';
import { PLACEHOLDER_SETS, tokensFor, unknownTokens } from '../placeholders.js';
import TemplatePicker, { embedTemplates, textTemplates } from '../components/TemplatePicker.jsx';
import ConfigImport from '../components/ConfigImport.jsx';
import EmbedJsonTools from '../components/EmbedJsonTools.jsx';
import ChangeList from '../components/ChangeList.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  previewConfigImport: vi.fn(),
  applyConfigImport: vi.fn(),
  getModuleLimits: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const api = await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');
const { resetModuleLimits } = await import('../components/useModuleLimits.js');

const GUILD = '123456789012345678';

beforeEach(() => {
  vi.resetAllMocks();
  confirmDialog.mockResolvedValue(true);
  resetModuleLimits();
  api.getModuleLimits.mockResolvedValue({
    _embed: { title: { maxLength: 256 }, description: { maxLength: 4096 }, fields: { maxItems: 25 } },
    'welcome-channel': { 'spec.content': { maxLength: 2000 }, 'spec.embeds': { maxItems: 10 } },
  });
});

// --- message JSON -------------------------------------------------------------------------------------

describe('message JSON', () => {
  const spec = {
    content: 'Hello',
    embeds: [
      {
        kind: 'embed',
        color: '#38c8f0',
        authorName: 'Sylo',
        authorIcon: 'https://example.com/a.png',
        title: 'Title',
        description: 'Body',
        image: 'https://example.com/i.png',
        thumbnail: 'https://example.com/t.png',
        footerText: 'Foot',
        footerIcon: 'https://example.com/f.png',
        fields: [
          { name: 'A', value: 'B', inline: true },
          { name: '', value: '' },
        ],
      },
    ],
    rows: [
      {
        type: 'buttons',
        buttons: [{ style: 'link', label: 'Site', url: 'https://example.com', emoji: '👍' }],
      },
      { type: 'roleselect', options: [{ roleId: '1', label: 'x' }] },
    ],
  };

  it('exports the Discord message shape, without empty fields and role menus', () => {
    const json = specToDiscordJson(spec);
    expect(json.content).toBe('Hello');
    expect(json.embeds[0]).toMatchObject({
      title: 'Title',
      description: 'Body',
      color: 0x38c8f0,
      author: { name: 'Sylo', icon_url: 'https://example.com/a.png' },
      thumbnail: { url: 'https://example.com/t.png' },
      image: { url: 'https://example.com/i.png' },
      footer: { text: 'Foot', icon_url: 'https://example.com/f.png' },
      fields: [{ name: 'A', value: 'B', inline: true }],
    });
    expect(json.components).toEqual([
      {
        type: 1,
        components: [{ type: 2, style: 5, label: 'Site', url: 'https://example.com', emoji: { name: '👍' } }],
      },
    ]);
  });

  it('round-trips what it exports', () => {
    const back = discordJsonToSpec(specToDiscordJson(spec));
    expect(back.ok).toBe(true);
    expect(back.spec.content).toBe('Hello');
    expect(back.spec.embeds[0]).toMatchObject({
      color: '#38c8f0',
      title: 'Title',
      authorName: 'Sylo',
      image: 'https://example.com/i.png',
      footerText: 'Foot',
      fields: [{ name: 'A', value: 'B', inline: true }],
    });
    expect(back.spec.rows).toEqual([
      {
        type: 'buttons',
        buttons: [{ style: 'link', label: 'Site', emoji: '👍', url: 'https://example.com' }],
      },
    ]);
  });

  it('reads a Discohook backup, a list of embeds and a single embed', () => {
    const data = { content: 'hi', embeds: [{ title: 'T', color: 255 }] };
    const backup = discordJsonToSpec({ backups: [{ name: 'x', messages: [{ data }, { data }] }] });
    expect(backup.ok).toBe(true);
    expect(backup.spec.embeds[0].color).toBe('#0000ff');
    expect(backup.warnings.join(' ')).toMatch(/only the first was imported/);
    expect(discordJsonToSpec({ messages: [{ data }] }).ok).toBe(true);
    expect(discordJsonToSpec([{ title: 'only' }]).spec.embeds[0].title).toBe('only');
    expect(discordJsonToSpec({ title: 'bare', description: 'embed' }).spec.embeds[0].description).toBe(
      'embed'
    );
  });

  it('refuses what is over the limits, and says which one', () => {
    const limits = messageLimits();
    const tooLong = discordJsonToSpec({ content: 'x'.repeat(DISCORD.content + 1) }, limits);
    expect(tooLong.ok).toBe(false);
    expect(tooLong.errors[0]).toMatch(/message text is 2001 characters; the limit is 2000/);

    const many = discordJsonToSpec({ embeds: Array.from({ length: 11 }, () => ({ title: 'x' })) }, limits);
    expect(many.errors.join(' ')).toMatch(/11 embeds; the limit is 10/);

    const fields = discordJsonToSpec({ embeds: [{ fields: [{ name: 'n', value: '' }] }] }, limits);
    expect(fields.errors[0]).toMatch(/Embed 1, field 1 needs both a name and a value/);

    const title = discordJsonToSpec({ embeds: [{ title: 'x'.repeat(257) }] }, limits);
    expect(title.errors[0]).toMatch(/Embed 1: the title is 257 characters; the limit is 256/);

    const total = discordJsonToSpec(
      { embeds: Array.from({ length: 4 }, () => ({ description: 'x'.repeat(2000) })) },
      limits
    );
    expect(total.errors.join(' ')).toMatch(/8000 characters in all; Discord allows 6000/);
  });

  it('uses the limits the server sends, not only Discord’s', () => {
    const limits = messageLimits({ title: { maxLength: 10 } }, { 'spec.embeds': { maxItems: 1 } });
    expect(discordJsonToSpec({ embeds: [{ title: 'x'.repeat(11) }] }, limits).ok).toBe(false);
    expect(discordJsonToSpec({ embeds: [{ title: 'a' }, { title: 'b' }] }, limits).ok).toBe(false);
  });

  it('names what it cannot carry over instead of dropping it silently', () => {
    const out = discordJsonToSpec({
      content: 'x',
      embeds: [
        {
          title: 'T',
          url: 'https://example.com',
          timestamp: '2026-01-01T00:00:00Z',
          image: { url: 'javascript:alert(1)' },
        },
      ],
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 1, custom_id: 'x', label: 'Click' },
            { type: 2, style: 5, label: 'Site', url: 'https://example.com' },
          ],
        },
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.spec.embeds[0].image).toBe('');
    expect(out.spec.rows[0].buttons).toHaveLength(1);
    const w = out.warnings.join('\n');
    expect(w).toMatch(/not a web address/);
    expect(w).toMatch(/Timestamps are not imported/);
    expect(w).toMatch(/Links on embed titles/);
    expect(w).toMatch(/1 button or menu that need a bot to answer was skipped/);
  });

  it('names the Discohook fields a posted message cannot use', () => {
    const out = discordJsonToSpec({
      content: 'x',
      username: 'Custom bot',
      avatar_url: 'https://example.com/a.png',
      attachments: [{ id: 1 }],
      thread_name: 'A post',
      flags: 4,
    });
    expect(out.ok).toBe(true);
    const w = out.warnings.join(' ');
    expect(w).toMatch(/custom name and avatar/);
    expect(w).toMatch(/Attached files are not imported/);
    expect(w).toMatch(/thread name/);
    expect(w).toMatch(/message flags/);
  });

  it('lists link buttons as not imported for a page that has no buttons', () => {
    const json = {
      content: 'x',
      components: [
        { type: 1, components: [{ type: 2, style: 5, label: 'Site', url: 'https://example.com' }] },
      ],
    };
    const without = discordJsonToSpec(json, messageLimits(), { links: false });
    expect(without.ok).toBe(true);
    expect(without.spec.rows).toEqual([]);
    expect(without.warnings.join(' ')).toMatch(/1 link button was not imported: this page has no buttons/);
    expect(discordJsonToSpec(json).spec.rows).toHaveLength(1);
  });

  it('refuses text that is not JSON, not a message, or empty', () => {
    expect(parseMessageJson('{nope').errors[0]).toMatch(/not valid JSON/);
    expect(discordJsonToSpec('text').ok).toBe(false);
    expect(discordJsonToSpec({}).errors[0]).toMatch(/no message text, embeds or link buttons/);
    expect(discordJsonToSpec({ content: 5 }).ok).toBe(false);
  });
});

// --- templates ----------------------------------------------------------------------------------------

describe('message templates', () => {
  it('has the six built-in templates', () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual([
      'Rules',
      'Welcome card',
      'Announcement',
      'Stream live',
      'Giveaway',
      'Event',
    ]);
  });

  it('every embed template is valid message JSON within the limits', () => {
    for (const t of TEMPLATES) {
      for (const tokens of [true, false]) {
        const json = specToDiscordJson(embedFor(t, { tokens }));
        const back = discordJsonToSpec(json);
        expect(back.ok, `${t.id}: ${back.errors?.join(' ')}`).toBe(true);
      }
    }
  });

  it('writes {server} out in words for a page that has no placeholders', () => {
    const welcome = TEMPLATES.find((t) => t.id === 'welcome-card');
    expect(JSON.stringify(embedFor(welcome, { tokens: false }))).not.toContain('{server}');
    expect(JSON.stringify(embedFor(welcome, { tokens: true }))).toContain('{server}');
    // a copy: changing it never changes the gallery
    embedFor(welcome, { tokens: true }).embeds[0].title = 'changed';
    expect(welcome.embed.embeds[0].title).toContain('Welcome');
  });

  it('every text only uses placeholders its field fills in', () => {
    const sets = {
      welcome: 'welcome',
      welcomeDm: 'welcome',
      stream: 'twitch',
      youtubeVideo: 'youtube',
      youtubeLive: 'youtube',
      rss: 'rss',
    };
    for (const [field, set] of Object.entries(sets)) {
      expect(PLACEHOLDER_SETS[set], set).toBeTruthy();
      for (const t of templatesForText(field)) {
        expect(unknownTokens(t.text[field], tokensFor(set)), `${t.id} in ${field}`).toEqual([]);
      }
    }
    // the kick alerts take the same tokens as twitch
    for (const t of templatesForText('stream')) {
      expect(unknownTokens(t.text.stream, tokensFor('kick'))).toEqual([]);
    }
    expect(Object.keys(sets).every((f) => templatesForText(f).length > 0)).toBe(true);
  });
});

describe('TemplatePicker', () => {
  it('opens a gallery and hands the picked template over', async () => {
    const onPick = vi.fn();
    render(<TemplatePicker templates={textTemplates('welcome')} onPick={onPick} />);
    expect(screen.queryByRole('list', { name: 'Templates' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start from a template' }));
    const list = screen.getByRole('list', { name: 'Templates' });
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.querySelector('.v2-template-name').textContent)
    ).toEqual(['Rules', 'Welcome card']);
    fireEvent.click(within(list).getByRole('button', { name: /Welcome card/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    expect(onPick.mock.calls[0][0].text).toMatch(/^Welcome to \{server\}/);
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(screen.queryByRole('list', { name: 'Templates' })).toBeNull();
  });

  it('asks before it replaces text that is there, and keeps it when the answer is no', async () => {
    confirmDialog.mockResolvedValue(false);
    const onPick = vi.fn();
    render(
      <TemplatePicker
        templates={embedTemplates({ tokens: false })}
        hasContent
        onPick={onPick}
        what="message"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start from a template' }));
    fireEvent.click(screen.getByRole('button', { name: /Giveaway/ }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(confirmDialog.mock.calls[0][0].title).toBe('Replace the message?');
    expect(onPick).not.toHaveBeenCalled();
    // yes
    confirmDialog.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: /Event/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    expect(onPick.mock.calls[0][0].message.embeds[0].title).toMatch(/Event/);
  });

  it('closes on Escape and renders nothing when there is no template', () => {
    const { container } = render(<TemplatePicker templates={[]} onPick={() => {}} />);
    expect(container.textContent).toBe('');
    render(<TemplatePicker templates={textTemplates('rss')} onPick={() => {}} />);
    const button = screen.getByRole('button', { name: 'Start from a template' });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(screen.getByRole('list', { name: 'Templates' }), { key: 'Escape' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('EmbedJsonTools', () => {
  it('says buttons are not imported on a page without them', async () => {
    render(
      <EmbedJsonTools getSpec={() => ({ content: 'Hi', embeds: [] })} onImport={() => {}} links={false} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Message JSON' }));
    expect(
      await screen.findByText(/This message has no buttons, so buttons in the JSON are not imported/)
    ).toBeTruthy();
    expect(screen.queryByText(/Link buttons are included/)).toBeNull();
  });

  it('shows the page as JSON, and loads pasted JSON into the page after the limits check', async () => {
    const onImport = vi.fn();
    render(
      <EmbedJsonTools
        getSpec={() => ({ content: 'Hello', embeds: [], rows: [] })}
        onImport={onImport}
        hasContent
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Message JSON' }));
    const area = await screen.findByLabelText('Message JSON', { selector: 'textarea' });
    expect(JSON.parse(area.value)).toEqual({ content: 'Hello' });

    fireEvent.change(area, { target: { value: JSON.stringify({ content: 'x'.repeat(2001) }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this JSON' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/2001 characters; the limit is 2000/);
    expect(onImport).not.toHaveBeenCalled();

    fireEvent.change(area, {
      target: { value: JSON.stringify({ content: 'new', embeds: [{ title: 'T' }] }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use this JSON' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(confirmDialog.mock.calls[0][0].title).toBe('Replace the message?');
    expect(onImport.mock.calls[0][0].embeds[0].title).toBe('T');
  });
});

// --- import ------------------------------------------------------------------------------------------

describe('ChangeList', () => {
  it('lists the fields, the old and the new value, and how many more there are', () => {
    render(
      <ChangeList
        changes={[{ path: 'a', label: 'Join channel', before: '(empty)', after: '123' }]}
        more={3}
        label="Changes to Welcome"
      />
    );
    const list = screen.getByRole('list', { name: 'Changes to Welcome' });
    expect(list.textContent).toContain('Join channel');
    expect(list.textContent).toContain('and 3 more changes');
  });
});

describe('ConfigImport', () => {
  const plan = {
    source: { guildId: '999', exportedAt: '2026-11-01T00:00:00.000Z', sameServer: false },
    notCarried: 'Not in the file, so not imported: reminders.',
    confirmWord: 'IMPORT',
    items: [
      {
        key: 'module:afk',
        kind: 'module',
        label: 'AFK',
        status: 'change',
        notes: ['1 channel from the file is not in this server and was cleared.'],
        changes: [{ path: 'enabled', label: 'Enabled', before: 'false', after: 'true' }],
        more: 0,
      },
      {
        key: 'module:birthdays',
        kind: 'module',
        label: 'Birthdays',
        status: 'same',
        notes: [],
        changes: [],
        more: 0,
      },
      {
        key: 'module:reminders',
        kind: 'module',
        label: 'Reminders',
        status: 'skip',
        notes: ['Reminders live in their own list.'],
        changes: [],
        more: 0,
      },
    ],
  };
  const file = (obj, name = 'sylo-config.json') =>
    new File([JSON.stringify(obj)], name, { type: 'application/json' });
  const choose = (input, f) => fireEvent.change(input, { target: { files: [f] } });
  const doc = { sylo: 'guild-config-export', version: 1, modules: [] };

  it('previews the file, ticks what changes, and applies only after the typed word', async () => {
    api.previewConfigImport.mockResolvedValue(plan);
    api.applyConfigImport.mockResolvedValue({ results: [{ key: 'module:afk', label: 'AFK', ok: true }] });
    const { container } = render(<ConfigImport guildId={GUILD} />);
    choose(container.querySelector('input[type="file"]'), file(doc));

    expect(await screen.findByText(/Exported from another server \(999\)/)).toBeTruthy();
    expect(api.previewConfigImport).toHaveBeenCalledWith(GUILD, doc);
    // only an item with changes can be ticked, and it starts ticked
    expect(screen.getByRole('checkbox', { name: 'AFK' }).checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Birthdays' }).disabled).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Reminders' }).disabled).toBe(true);
    expect(screen.getByText(/was cleared/)).toBeTruthy();
    expect(screen.getByText('Not imported')).toBeTruthy();
    expect(screen.getByText(/Show what changes \(1\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 item…' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(confirmDialog.mock.calls[0][0]).toMatchObject({ typeToConfirm: 'IMPORT', confirmLabel: 'Import' });
    await waitFor(() =>
      expect(api.applyConfigImport).toHaveBeenCalledWith(GUILD, doc, ['module:afk'], 'IMPORT')
    );
    expect(await screen.findByText('Imported 1 of 1.')).toBeTruthy();
  });

  it('writes nothing when the confirmation is declined', async () => {
    api.previewConfigImport.mockResolvedValue(plan);
    confirmDialog.mockResolvedValue(false);
    const { container } = render(<ConfigImport guildId={GUILD} />);
    choose(container.querySelector('input[type="file"]'), file(doc));
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1 item…' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(api.applyConfigImport).not.toHaveBeenCalled();
  });

  it('disables Import when nothing is ticked', async () => {
    api.previewConfigImport.mockResolvedValue(plan);
    const { container } = render(<ConfigImport guildId={GUILD} />);
    choose(container.querySelector('input[type="file"]'), file(doc));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'AFK' }));
    expect(screen.getByRole('button', { name: 'Import 0 items…' }).disabled).toBe(true);
  });

  it('says so for a file that is not JSON, one that is too large, and one the server refuses', async () => {
    const { container } = render(<ConfigImport guildId={GUILD} />);
    const input = container.querySelector('input[type="file"]');
    choose(input, new File(['{nope'], 'x.json', { type: 'application/json' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not valid JSON/);
    expect(api.previewConfigImport).not.toHaveBeenCalled();

    choose(input, new File(['x'.repeat(300 * 1024)], 'big.json', { type: 'application/json' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/larger than 256 KB/));

    api.previewConfigImport.mockRejectedValue(new Error('This is not a Sylo configuration export.'));
    choose(input, file({ hello: 'world' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/not a Sylo configuration export/)
    );
  });

  it('shows an item that could not be saved with the reason', async () => {
    api.previewConfigImport.mockResolvedValue(plan);
    api.applyConfigImport.mockResolvedValue({
      results: [{ key: 'module:afk', label: 'AFK', ok: false, error: 'Admins is above your highest role.' }],
    });
    const { container } = render(<ConfigImport guildId={GUILD} />);
    choose(container.querySelector('input[type="file"]'), file(doc));
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1 item…' }));
    expect(await screen.findByText('Imported 0 of 1.')).toBeTruthy();
    expect(screen.getByText('Admins is above your highest role.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('Imported 0 of 1.')).toBeNull();
  });
});
