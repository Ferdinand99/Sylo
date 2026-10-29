// Thread names for the Auto threads module: placeholders, the stripping of mentions and markdown, the
// 100 character cut and the fallbacks. Pure functions, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_MINUTES,
  THREAD_NAME_MAX,
  cut,
  firstWords,
  plainText,
  renderThreadName,
} from '../src/lib/autoThreadName.js';

const DAY = Date.UTC(2026, 9, 29, 23, 59);
const render = (template, post = {}) =>
  renderThreadName(template, { author: 'Alex', createdAt: DAY, content: 'hello world', ...post });

test('{author}, {date} and {words} are filled in; the date is the UTC day', () => {
  assert.equal(render('{author} - {date} - {words}'), 'Alex - 2026-10-29 - hello world');
  assert.equal(render('{AUTHOR}/{Date}/{Words}'), 'Alex/2026-10-29/hello world', 'case does not matter');
  assert.equal(render('{author} {author}'), 'Alex Alex', 'a placeholder may repeat');
});

test('{words} is the first six words only', () => {
  assert.equal(
    render('{words}', { content: 'one two three four five six seven eight' }),
    'one two three four five six'
  );
  assert.equal(render('{words}', { content: 'one two' }), 'one two');
  assert.equal(firstWords('a b c d e f g', 3), 'a b c');
  assert.equal(render('{words}', { content: '  lots \n\n of\t\tspace  here ' }), 'lots of space here');
});

test('an unknown placeholder, {n} included, stays as written', () => {
  assert.equal(render('Post {n} by {author} {nope}'), 'Post {n} by Alex {nope}');
});

test('an empty template means {words}', () => {
  assert.equal(render(''), 'hello world');
  assert.equal(render('   '), 'hello world');
  assert.equal(render(undefined), 'hello world');
});

test('a value that looks like a placeholder is not expanded again', () => {
  assert.equal(render('{author}', { author: '{words}' }), '{words}');
  assert.equal(render('{words}', { content: '{author} {date}' }), '{author} {date}');
});

test('mentions, custom emoji, timestamps and @everyone are removed from the words', () => {
  const content =
    '<@123456789012345678> hi <@!223456789012345678> <@&323456789012345678> <#423456789012345678> <:wave:523456789012345678> <a:dance:623456789012345678> <t:1700000000:R> @everyone @here there';
  assert.equal(render('{words}', { content }), 'hi there');
});

test('markdown is stripped: bold, italic, strikethrough, spoilers, code, quotes, headings, lists, links', () => {
  assert.equal(
    plainText('**bold** *it* ~~gone~~ ||spoiler|| `code`').replace(/\s+/g, ' ').trim(),
    'bold it gone spoiler code'
  );
  assert.equal(firstWords('# Big heading here'), 'Big heading here');
  assert.equal(firstWords('> quoted text'), 'quoted text');
  assert.equal(firstWords('>quoted too'), 'quoted too');
  assert.equal(firstWords('- item one\n- item two'), 'item one item two');
  assert.equal(firstWords('-# small text'), 'small text');
  assert.equal(firstWords('see [the guide](https://example.com/g) now'), 'see the guide now');
  assert.equal(firstWords('read <https://example.com/x> soon'), 'read https://example.com/x soon');
  assert.equal(firstWords('```js\nlet a = 1\n```'), 'let a = 1', 'fence marks go, the code stays');
  assert.equal(firstWords('__under__ and _it_'), 'under and it');
  assert.equal(firstWords('keep snake_case words'), 'keep snake_case words');
});

test('{words} falls back to the author when the post has no words', () => {
  assert.equal(render('{words}', { content: '' }), 'Alex');
  assert.equal(render('{words}', { content: undefined }), 'Alex');
  assert.equal(render('{words}', { content: '<@123456789012345678>' }), 'Alex');
  assert.equal(render('{words}', { content: '**' }), 'Alex');
  assert.equal(render('Pic by {words}', { content: '' }), 'Pic by Alex');
});

test('control and invisible characters and line breaks are removed from names', () => {
  const dirty =
    'Al' + String.fromCharCode(0x200b) + 'ex' + String.fromCharCode(0x202e) + String.fromCharCode(10);
  assert.equal(render('{author}', { author: dirty }), 'Alex');
  assert.equal(render('a\nb\tc'), 'a b c');
});

test('the name is cut at 100 characters, trimmed, and never splits an emoji', () => {
  const long = 'x'.repeat(250);
  assert.equal(render('{words}', { content: long }).length, THREAD_NAME_MAX);
  assert.equal(render(long).length, THREAD_NAME_MAX);
  const spaced = `${'a'.repeat(99)} b`;
  assert.equal(render(spaced), 'a'.repeat(99), 'no trailing space after the cut');
  const emoji = `${'a'.repeat(99)}😀😀`;
  const name = render(emoji);
  assert.equal(Array.from(name).length, 100);
  assert.ok(!/[\uD800-\uDBFF]$/.test(name), 'no lone surrogate at the end');
  assert.equal(cut('😀😀😀', 2), '😀😀');
  assert.equal(cut('abc', 5), 'abc');
});

test('a very long author name is cut with the rest of the name', () => {
  const name = render('{author} {words}', { author: 'n'.repeat(300) });
  assert.equal(name.length, 100);
});

test('the name is never empty', () => {
  assert.equal(
    render('{date}', { createdAt: 'nonsense' }),
    'Alex',
    'an unusable date leaves nothing; the author is used'
  );
  assert.equal(renderThreadName('{words}', { author: '', content: '' }), 'Someone');
  assert.equal(renderThreadName('   {date}   ', { author: 'A', createdAt: DAY }), '2026-10-29');
});

test("the archive choices are Discord's four", () => {
  assert.deepEqual([...ARCHIVE_MINUTES], [60, 1440, 4320, 10080]);
});
