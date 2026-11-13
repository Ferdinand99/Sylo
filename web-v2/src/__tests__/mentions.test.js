import { describe, expect, it } from 'vitest';
import {
  filterChannels,
  filterRoles,
  insertMention,
  mentionLabel,
  mentionsIn,
  parseMentions,
  previewParts,
  sampleValues,
  tokenOf,
  triggerAt,
} from '../mentions.js';

const CH = '100000000000000021';
const ROLE = '200000000000000031';
const USER = '300000000000000041';
const lookup = {
  channels: [{ id: CH, name: 'welcome' }],
  roles: [{ id: ROLE, name: 'Verified' }],
  members: new Map([[USER, 'Mara']]),
};

describe('parseMentions and mentionsIn', () => {
  it('splits the text into plain parts and mentions', () => {
    expect(parseMentions(`Say hi in <#${CH}>, <@&${ROLE}> and <@${USER}> or @everyone`)).toEqual([
      { type: 'text', text: 'Say hi in ' },
      { type: 'channel', id: CH },
      { type: 'text', text: ', ' },
      { type: 'role', id: ROLE },
      { type: 'text', text: ' and ' },
      { type: 'user', id: USER },
      { type: 'text', text: ' or ' },
      { type: 'special', name: 'everyone' },
    ]);
  });

  it('reads the nickname form <@!id> as a member, and leaves a short id as text', () => {
    expect(parseMentions(`<@!${USER}> <#123>`)).toEqual([
      { type: 'user', id: USER },
      { type: 'text', text: ' <#123>' },
    ]);
  });

  it('lists each mention once, in order', () => {
    const found = mentionsIn(`<#${CH}> <@&${ROLE}> <#${CH}> @here`);
    expect(found).toEqual([
      { type: 'channel', id: CH },
      { type: 'role', id: ROLE },
      { type: 'special', name: 'here' },
    ]);
    expect(mentionsIn('no mentions {user}')).toEqual([]);
  });
});

describe('mentionLabel', () => {
  it('shows names, never ids', () => {
    expect(mentionLabel({ type: 'channel', id: CH }, lookup)).toBe('#welcome');
    expect(mentionLabel({ type: 'role', id: ROLE }, lookup)).toBe('@Verified');
    expect(mentionLabel({ type: 'user', id: USER }, lookup)).toBe('@Mara');
    expect(mentionLabel({ type: 'special', name: 'here' }, lookup)).toBe('@here');
  });

  it('marks a deleted channel or role and a member whose name is not known', () => {
    expect(mentionLabel({ type: 'channel', id: '999999999999999999' }, lookup)).toBe('#deleted-channel');
    expect(mentionLabel({ type: 'role', id: '999999999999999999' }, lookup)).toBe('@deleted-role');
    expect(mentionLabel({ type: 'user', id: '999999999999999999' }, lookup)).toBe('@member');
  });
});

describe('triggerAt', () => {
  it('finds a # or @ being typed at the caret', () => {
    expect(triggerAt('Say hi in #wel', 14)).toEqual({ kind: 'channel', start: 10, query: 'wel' });
    expect(triggerAt('@', 1)).toEqual({ kind: 'mention', start: 0, query: '' });
    expect(triggerAt('hello @Ver', 10)).toEqual({ kind: 'mention', start: 6, query: 'Ver' });
    expect(triggerAt('two\nlines #gen', 14)).toEqual({ kind: 'channel', start: 10, query: 'gen' });
  });

  it('ignores a # or @ inside a word, after a space, or past the name', () => {
    expect(triggerAt('mail me@example', 15)).toBeNull();
    expect(triggerAt('issue#12', 8)).toBeNull();
    expect(triggerAt('# not a mention', 5)).toBeNull();
    expect(triggerAt('plain text', 5)).toBeNull();
    expect(triggerAt('@' + 'a'.repeat(40), 41)).toBeNull();
    expect(triggerAt('', 0)).toBeNull();
  });
});

describe('suggestions and insertion', () => {
  it('filters channels and roles by what is typed, names that start with it first', () => {
    const channels = [
      { id: '1', name: 'general' },
      { id: '2', name: 'mod-general' },
      { id: '3', name: 'rules' },
    ];
    expect(filterChannels(channels, 'gen').map((c) => c.name)).toEqual(['general', 'mod-general']);
    expect(filterChannels(channels, '').length).toBe(3);
    const roles = [
      { id: '1', name: 'Moderator' },
      { id: '2', name: 'Member' },
    ];
    expect(filterRoles(roles, 'me').map((r) => r.label)).toEqual(['@Member']);
    expect(filterRoles(roles, 'ev').map((r) => r.label)).toEqual(['@everyone']);
    expect(filterRoles(roles, 'h').map((r) => r.label)).toEqual(['@here']);
  });

  it('writes the token the platform stores', () => {
    expect(tokenOf({ type: 'channel', id: CH })).toBe(`<#${CH}>`);
    expect(tokenOf({ type: 'role', id: ROLE })).toBe(`<@&${ROLE}>`);
    expect(tokenOf({ type: 'user', id: USER })).toBe(`<@${USER}>`);
    expect(tokenOf({ type: 'special', name: 'everyone' })).toBe('@everyone');
  });

  it('replaces what was typed with the token and a space, and puts the caret after it', () => {
    const text = 'Say hi in #wel';
    const trigger = triggerAt(text, text.length);
    const out = insertMention(text, trigger, text.length, `<#${CH}>`);
    expect(out.value).toBe(`Say hi in <#${CH}> `);
    expect(out.caret).toBe(out.value.length);
  });

  it('keeps the text after the caret and adds no second space', () => {
    const text = 'hi #gen there';
    const trigger = triggerAt(text, 7);
    const out = insertMention(text, trigger, 7, `<#${CH}>`);
    expect(out.value).toBe(`hi <#${CH}> there`);
    expect(out.value.slice(out.caret)).toBe(' there');
  });
});

describe('previewParts', () => {
  const plain = (parts) => parts.map((p) => p.text).join('');

  it('fills the placeholders with sample data and turns mentions into names', () => {
    const parts = previewParts(`Welcome {user} to **{server}**! See <#${CH}> and <@&${ROLE}>.`, {
      samples: sampleValues({ server: 'Pixel Harbor' }),
      lookup,
    });
    expect(plain(parts)).toBe('Welcome @Mara to Pixel Harbor! See #welcome and @Verified.');
    expect(parts.filter((p) => p.kind === 'mention').map((p) => p.text)).toEqual([
      '@Mara',
      '#welcome',
      '@Verified',
    ]);
    expect(parts.find((p) => p.kind === 'bold').text).toBe('Pixel Harbor');
  });

  it('leaves a placeholder it does not know as typed, and marks a deleted channel', () => {
    const parts = previewParts(`{nope} <#999999999999999999>`, { lookup });
    expect(plain(parts)).toBe('{nope} #deleted-channel');
    expect(parts.find((p) => p.kind === 'missing').text).toBe('#deleted-channel');
  });

  it("marks inline code and uses a form's own sample values", () => {
    const parts = previewParts('Use `/rank` at level {level}', {
      samples: sampleValues({ extra: { '{level}': '99' } }),
    });
    expect(plain(parts)).toBe('Use /rank at level 99');
    expect(parts.find((p) => p.kind === 'code').text).toBe('/rank');
  });

  it('handles an empty template', () => {
    expect(previewParts('')).toEqual([]);
    expect(previewParts(undefined)).toEqual([]);
  });
});
