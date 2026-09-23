import test from 'node:test';
import assert from 'node:assert/strict';
import { mdToHtml } from '../src/web/lib/markdown.js';

test('mdToHtml: escapes raw HTML before applying any markdown syntax', () => {
  assert.equal(mdToHtml('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('mdToHtml: bold, italic, inline code', () => {
  assert.equal(
    mdToHtml('**bold** and _italic_ and `code`'),
    '<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>'
  );
});

test('mdToHtml: links only for http/https, javascript: URLs pass through as literal text', () => {
  assert.equal(
    mdToHtml('[click](https://example.com)'),
    '<p><a href="https://example.com" target="_blank" rel="noopener">click</a></p>'
  );
  assert.equal(mdToHtml('[click](javascript:alert(1))'), '<p>[click](javascript:alert(1))</p>');
});

test('mdToHtml: a bullet list becomes a <ul>, separate from surrounding paragraphs', () => {
  assert.equal(
    mdToHtml('intro\n- one\n- two\nafter'),
    '<p>intro</p><ul><li>one</li><li>two</li></ul><p>after</p>'
  );
});

test('mdToHtml: blank lines separate paragraphs', () => {
  assert.equal(mdToHtml('first\n\nsecond'), '<p>first</p><p>second</p>');
});

test('mdToHtml: empty input renders no blocks', () => {
  assert.equal(mdToHtml(''), '');
  assert.equal(mdToHtml(undefined), '');
});
