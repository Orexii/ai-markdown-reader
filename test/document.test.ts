import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { buildDocument, textWords, utteranceText, type DocumentOptions, type ReaderDocument } from '../src/document';

const spoken = (markdown: string, options?: Partial<DocumentOptions>) => buildDocument(markdown, options).utterances.map(utteranceText);

/** Every id the player highlights must exist in the rendered HTML. */
function assertTargetsExist(doc: ReaderDocument): Document {
  const dom = new JSDOM(`<main>${doc.html}</main>`).window.document;
  for (const utterance of doc.utterances) {
    for (const id of utterance.highlight) assert.ok(dom.getElementById(id), `missing highlight ${id}`);
    for (const word of utterance.words) if (word.target) assert.ok(dom.getElementById(word.target), `missing target ${word.target}`);
  }
  for (const block of doc.blocks) assert.ok(dom.getElementById(block.id), `missing block ${block.id}`);
  return dom;
}

test('labelled bullets flow as sentences without Markdown syntax', () => {
  assert.deepEqual(spoken('- **Mail:** send the [draft](https://example.com/secret).\n- Keep `userId` unchanged.'),
    ['Mail: send the draft.', 'Keep userId unchanged.']);
});

test('nested lists, continuation paragraphs, task state and ordered numbering', () => {
  assert.deepEqual(spoken('3. First\n\n   More detail.\n   - Nested\n4. Last\n\n- [x] Done\n- [ ] Next'),
    ['3. First.', 'More detail.', 'Nested.', '4. Last.', 'Completed: Done.', 'Not completed: Next.']);
});

test('tables are read row by row with header cells as targets for column names', () => {
  const doc = buildDocument('| Service | State | Detail |\n| --- | --- | --- |\n| Mail | **Ready** | A \\| B |\n| Search | | [Open](https://example.com) |');
  assert.deepEqual(doc.utterances.map(utteranceText), [
    'Table with 2 rows. Columns: Service, State, Detail.',
    'Mail. State: Ready. Detail: A B.',
    'Search. State: empty. Detail: Open.'
  ]);
  const dom = assertTargetsExist(doc);
  const row = doc.utterances[1]!;
  assert.equal(dom.getElementById(row.highlight[0]!)!.tagName, 'TR');
  const state = row.words.find(word => word.text === 'State')!;
  assert.equal(dom.getElementById(state.target!)!.tagName, 'TH');
  const ready = row.words.find(word => word.text === 'Ready')!;
  assert.equal(dom.getElementById(ready.target!)!.closest('td')!.textContent, 'Ready');
  assert.equal(doc.utterances[2]!.words.find(word => word.text === 'empty')!.target, dom.querySelectorAll('tbody tr')[1]!.children[1]!.id);
  assert.equal(row.line, 2);
  assert.equal(doc.utterances[2]!.line, 3);
  assert.equal(dom.querySelector('tbody td')!.textContent, 'Mail');
});

test('column mode keeps row identity and highlights the column', () => {
  const doc = buildDocument('| Name | Count |\n| --- | --- |\n| Ada | 7 |\n| Bo | 9 |', { tableMode: 'columns' });
  assert.deepEqual(doc.utterances.map(utteranceText), [
    'Table with 2 rows. Columns: Name, Count.',
    'Column Name. Row 1: Ada. Row 2: Bo.',
    'Column Count. Ada: 7. Bo: 9.'
  ]);
  assert.equal(doc.utterances[2]!.highlight.length, 3);
  assertTargetsExist(doc);
});

test('front matter is hidden, line numbers survive and selection offsets apply', () => {
  const doc = buildDocument('---\r\ntitle: Internal\r\n---\r\n\r\n# Hello\r\n\r\nText.');
  assert.deepEqual(doc.utterances.map(utteranceText), ['Hello.', 'Text.']);
  assert.equal(doc.utterances[0]!.line, 4);
  assert.equal(doc.blocks[0]!.heading!.text, 'Hello');
  assert.ok(!doc.html.includes('Internal'));
  assert.equal(buildDocument('Line.', { lineOffset: 40 }).utterances[0]!.line, 40);
});

test('quotes, alerts, images, raw HTML and code blocks', () => {
  const doc = buildDocument('# Title\n\n> Think carefully.\n\n> [!WARNING]\n> Back up first.\n\n![A diagram](chart.svg)\n\n<script>alert("unsafe")</script>\n\n<!-- hidden -->\n\n```js\nrun();\nstop();\n```\n\n```mermaid\ngraph TD\nA-->B\n```');
  assert.deepEqual(doc.utterances.map(utteranceText), [
    'Title.', 'Quote: Think carefully.', 'Warning: Back up first.', 'Image: A diagram.', 'Code block, JavaScript, 2 lines.', 'Diagram, 2 lines.'
  ]);
  const dom = assertTargetsExist(doc);
  assert.equal(dom.querySelector('script'), null);
  assert.match(dom.querySelector('.html-note')!.textContent!, /not shown/);
  assert.equal(dom.getElementById(doc.utterances[2]!.words[0]!.target!)!.className, 'callout-title');
  assert.equal(doc.blocks.filter(block => block.kind === 'html').length, 1);
  assert.deepEqual(spoken('```\na b\n\nc\n```', { codeBlocks: 'read' }), ['a b.', 'c.']);
  assert.deepEqual(spoken('```\nrun();\n```', { codeBlocks: 'skip' }), []);
});

test('document text and attributes are escaped, and only safe links are clickable', () => {
  const doc = buildDocument('Hello <img src=x onerror=alert(1)> **bold** `<b>` [x](javascript:alert(1)) [y](https://ok.example/"onmouseover=")');
  const dom = assertTargetsExist(doc);
  assert.equal(dom.querySelector('img, b, script'), null);
  assert.equal(dom.querySelector('.code')!.textContent, '<b>');
  const links = [...dom.querySelectorAll('[data-href]')].map(link => link.getAttribute('data-href'));
  // markdown-it percent-encodes quotes in link destinations, so attributes cannot be broken out of.
  assert.deepEqual(links, ['https://ok.example/%22onmouseover=%22']);
  // Unsafe link syntax stays visible as inert text and never becomes an attribute.
  assert.ok([...dom.querySelectorAll('*')].every(element => [...element.attributes].every(attribute => !/^\s*javascript:/i.test(attribute.value))));
  assert.match(dom.body.textContent!, /\[x\]\(javascript:alert\(1\)\)/);
});

test('autolinks speak the host; emoji are shown but not spoken', () => {
  assert.deepEqual(spoken('See <https://www.example.com/path?token=abc> ✅ now.'), ['See example.com now.']);
  assert.match(buildDocument('Done ✅.').html, /✅/);
});

test('abbreviations do not end sentences and sentence spans cover the paragraph', () => {
  const doc = buildDocument('Use tools, e.g. linters. Then ship it! Done?');
  assert.deepEqual(doc.utterances.map(utteranceText), ['Use tools, e.g. linters.', 'Then ship it!', 'Done?']);
  const dom = assertTargetsExist(doc);
  assert.equal(dom.querySelectorAll('.s').length, 3);
  assert.equal(dom.querySelector('p')!.textContent, 'Use tools, e.g. linters. Then ship it! Done?');
});

test('long sentences split at clause boundaries within the speech limit', () => {
  const clause = 'the reader keeps every clause in order and never drops a word';
  const markdown = `${Array.from({ length: 12 }, () => clause).join(', ')}.`;
  const doc = buildDocument(markdown);
  const texts = doc.utterances.map(utteranceText);
  assert.ok(texts.length > 2);
  assert.ok(texts.every(text => text.length <= 285), texts.map(t => t.length).join(','));
  assert.equal(texts.join(' ').replace(/[,.]/g, ''), markdown.replace(/[,.]/g, ''));
  assert.ok(doc.utterances.slice(0, -1).every(u => u.pauseAfter === 0.15));
  assert.equal(new Set(doc.utterances.map(u => u.highlight[0])).size, 1);
  const long = buildDocument(`Value \`${'x'.repeat(700)}\` end.`).utterances;
  assert.ok(long.every(u => utteranceText(u).length <= 300));
});

test('approved descriptions replace a block narration and keep the block highlighted', () => {
  const markdown = '# Results\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nAfter.';
  const original = buildDocument(markdown);
  const table = original.blocks.findIndex(block => block.kind === 'table');
  const doc = buildDocument(markdown, { overrides: new Map([[table, 'The table has one row. A is 1, and B is 2.']]) });
  assert.deepEqual(doc.utterances.map(utteranceText), ['Results.', 'The table has one row.', 'A is 1, and B is 2.', 'After.']);
  const id = doc.blocks[table]!.id;
  assert.ok(doc.utterances.slice(1, 3).every(u => u.highlight[0] === id && u.words.every(word => word.target === id)));
  assert.equal(doc.blocks[table]!.first, 1);
  assert.equal(doc.blocks.at(-1)!.first, 3);
  assertTargetsExist(doc);
});

test('multi-word inline code is one highlight target with separately spoken words', () => {
  const doc = buildDocument('Run `npm run build` now.');
  assert.deepEqual(doc.utterances.map(utteranceText), ['Run npm run build now.']);
  const words = doc.utterances[0]!.words;
  assert.equal(new Set(words.slice(1, 4).map(word => word.target)).size, 1);
  const dom = assertTargetsExist(doc);
  assert.equal(dom.querySelectorAll('.code').length, 1);
});

test('free text is split into words with punctuation as separators', () => {
  assert.deepEqual(textWords('Hello, "world" — again!', null).map(w => [w.text, w.sep]),
    [['Hello', ', '], ['world', '"— '], ['again', '!']]);
});

test('the demonstration renders with valid targets and no raw Markdown or URLs spoken', () => {
  const doc = buildDocument(readFileSync('examples/demo.md', 'utf8'));
  assertTargetsExist(doc);
  const text = doc.utterances.map(utteranceText).join(' ');
  assert.ok(doc.utterances.length > 15);
  assert.ok(!/https?:|\*\*|`|\]\(/.test(text));
  assert.ok(text.includes('State: Ready'));
  assert.ok(doc.blocks.some(block => block.heading?.level === 2));
});

test('empty documents produce nothing to read', () => {
  assert.deepEqual(buildDocument(' \n---\n').utterances, []);
});
