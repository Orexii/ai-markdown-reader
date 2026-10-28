import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDocument, textWords, utteranceText, type DocumentOptions, type ReaderDocument, type SourceRange } from '../src/document';
import { KEY_NAMES } from '../src/engine/pronounce';

const spoken = (markdown: string, options?: Partial<DocumentOptions>) => buildDocument(markdown, options).utterances.map(utteranceText);

/** The source text a range points at. */
function slice(markdown: string, range: SourceRange | null): string | null {
  if (!range) return null;
  const lines = markdown.split(/\r?\n/);
  if (range.line === range.endLine) return lines[range.line]!.slice(range.character, range.endCharacter);
  return [lines[range.line]!.slice(range.character), ...lines.slice(range.line + 1, range.endLine), lines[range.endLine]!.slice(0, range.endCharacter)].join('\n');
}

/**
 * Every highlighted word must point at its own text in the source. Spoken forms may differ (an autolink
 * speaks its host, an image says "Image:"), and a table's "Column" cue points at the column's header.
 */
function assertWordsInSource(markdown: string, doc: ReaderDocument): void {
  for (const utterance of doc.utterances) {
    for (const word of utterance.words) {
      if (!word.range) continue;
      // Markdown escapes (\*) are part of the source but not of the spoken word.
      const text = slice(markdown, word.range)!.replace(/\\(?=\S)/g, '');
      const matches = text.includes(word.text) || word.text.includes(text) || text === word.text.replace(/\s/g, '') || word.text === 'Column' ||
        KEY_NAMES[text] === word.text;
      assert.ok(matches, `"${word.text}" points at "${text}"`);
    }
  }
}

test('labelled bullets flow as sentences and highlight their own words', () => {
  const markdown = '- **Mail:** send the [draft](https://example.com/secret).\n- Keep `userId` unchanged.';
  const doc = buildDocument(markdown);
  assert.deepEqual(doc.utterances.map(utteranceText), ['Mail: send the draft.', 'Keep userId unchanged.']);
  assertWordsInSource(markdown, doc);
  assert.equal(slice(markdown, doc.utterances[0]!.range), 'Mail:** send the [draft](https://example.com/secret).');
  assert.equal(slice(markdown, doc.utterances[1]!.words[1]!.range), 'userId');
  assert.equal(doc.utterances[1]!.words.every(word => word.range), true);
});

test('nested lists, continuation paragraphs, task state and ordered numbering', () => {
  const markdown = '3. First\n\n   More detail.\n   - Nested\n4. Last\n\n- [x] Done\n- [ ] Next';
  const doc = buildDocument(markdown);
  assert.deepEqual(doc.utterances.map(utteranceText), ['3. First.', 'More detail.', 'Nested.', '4. Last.', 'Completed: Done.', 'Not completed: Next.']);
  assertWordsInSource(markdown, doc);
  assert.equal(slice(markdown, doc.utterances[1]!.range), 'More detail.');
  assert.equal(slice(markdown, doc.utterances[4]!.range), 'Done');
  assert.equal(doc.utterances[4]!.words[0]!.range, null, 'spoken-only cues are not highlighted');
});

test('table rows highlight the row, each cell value and the header named before it', () => {
  const markdown = '| Service | State | Detail |\n| --- | --- | --- |\n| Mail | **Ready** | A \\| B |\n| Search | | [Open](https://example.com) |';
  const doc = buildDocument(markdown);
  assert.deepEqual(doc.utterances.map(utteranceText), [
    'Table with 2 rows. Columns: Service, State, Detail.',
    'Mail. State: Ready. Detail: A B.',
    'Search. State: empty. Detail: Open.'
  ]);
  assertWordsInSource(markdown, doc);
  const row = doc.utterances[1]!;
  assert.equal(slice(markdown, row.range), '| Mail | **Ready** | A \\| B |');
  const word = (text: string) => row.words.find(w => w.text === text)!;
  assert.equal(slice(markdown, word('State').range), 'State');
  assert.equal(word('State').range!.line, 0, 'the column name points at the header cell');
  assert.equal(slice(markdown, word('Ready').range), 'Ready');
  assert.equal(slice(markdown, word('B').range), 'B', 'escaped pipes keep cell positions');
  const empty = doc.utterances[2]!.words.find(w => w.text === 'empty')!;
  assert.equal(empty.range, null);
  assert.equal(row.line, 2);
  assert.equal(doc.utterances[2]!.line, 3);
});

test('column mode keeps row identity and spans the column', () => {
  const markdown = '| Name | Count |\n| --- | --- |\n| Ada | 7 |\n| Bo | 9 |';
  const doc = buildDocument(markdown, { tableMode: 'columns' });
  assert.deepEqual(doc.utterances.map(utteranceText), [
    'Table with 2 rows. Columns: Name, Count.',
    'Column Name. Row 1: Ada. Row 2: Bo.',
    'Column Count. Ada: 7. Bo: 9.'
  ]);
  assertWordsInSource(markdown, doc);
  const column = doc.utterances[2]!.range!;
  assert.equal(column.line, 0);
  assert.equal(column.endLine, 3);
});

test('front matter is skipped, line numbers survive and selection offsets apply', () => {
  const markdown = '---\r\ntitle: Internal\r\n---\r\n\r\n# Hello\r\n\r\nText.';
  const doc = buildDocument(markdown);
  assert.deepEqual(doc.utterances.map(utteranceText), ['Hello.', 'Text.']);
  assert.equal(doc.utterances[0]!.line, 4);
  assert.equal(slice(markdown, doc.utterances[0]!.range), 'Hello');
  assert.equal(doc.blocks[0]!.heading!.text, 'Hello');

  const full = 'Intro line.\nFirst part. Second **bold** part here.\nThird.';
  const lines = full.split('\n');
  const selected = `${lines[1]!.slice(12)}\n${lines[2]}`;
  const part = buildDocument(selected, { lineOffset: 1, characterOffset: 12 });
  assert.deepEqual(part.utterances.map(utteranceText), ['Second bold part here.', 'Third.']);
  assert.equal(slice(full, part.utterances[0]!.range), 'Second **bold** part here.');
  assert.equal(slice(full, part.utterances[0]!.words[1]!.range), 'bold');
  assert.equal(slice(full, part.utterances[1]!.range), 'Third.');
});

test('quotes, alerts, images, raw HTML and code blocks', () => {
  const markdown = '# Title\n\n> Think carefully.\n\n> [!WARNING]\n> Back up first.\n\n![A diagram](chart.svg)\n\n<script>alert("unsafe")</script>\n\n<!-- hidden -->\n\n```js\nrun();\nstop();\n```\n\n```mermaid\ngraph TD\nA-->B\n```';
  const doc = buildDocument(markdown);
  assert.deepEqual(doc.utterances.map(utteranceText), [
    'Title.', 'Quote: Think carefully.', 'Warning: Back up first.', 'Image: A diagram.', 'Code block, JavaScript, 2 lines.', 'Diagram, 2 lines.'
  ]);
  assertWordsInSource(markdown, doc);
  assert.equal(slice(markdown, doc.utterances[2]!.range), 'Back up first.');
  assert.equal(slice(markdown, doc.utterances[3]!.words[0]!.range), 'A diagram');
  assert.equal(slice(markdown, doc.utterances[4]!.range), '```js\nrun();\nstop();\n```', 'announced code highlights the whole block');
  assert.equal(doc.blocks.filter(block => block.kind === 'html').length, 1);
  const read = buildDocument('```\na b\n\nc\n```', { codeBlocks: 'read' });
  assert.deepEqual(read.utterances.map(utteranceText), ['a b.', 'c.']);
  assert.equal(read.utterances[1]!.range!.line, 3, 'read code highlights each line');
  assert.deepEqual(spoken('```\nrun();\n```', { codeBlocks: 'skip' }), []);
});

test('link targets, HTML tags and URLs are never spoken or highlighted as words', () => {
  const markdown = 'Hello <kbd>Ctrl</kbd> and **bold** `<b>` [link text](https://example.com/link) end.';
  const doc = buildDocument(markdown);
  assert.deepEqual(doc.utterances.map(utteranceText), ['Hello Ctrl and bold <b> link text end.']);
  assertWordsInSource(markdown, doc);
  const words = doc.utterances[0]!.words;
  assert.equal(slice(markdown, words.find(w => w.text === 'Ctrl')!.range), 'Ctrl');
  assert.equal(slice(markdown, words.find(w => w.text === 'link')!.range), 'link');
  assert.ok(words.find(w => w.text === 'end')!.range!.character > markdown.indexOf(')'), 'words after a link map past its target');
});

test('autolinks speak the host; emoji are not spoken', () => {
  const markdown = 'See <https://www.example.com/path?token=abc> ✅ now.';
  const doc = buildDocument(markdown);
  assert.deepEqual(doc.utterances.map(utteranceText), ['See example.com now.']);
  assert.equal(slice(markdown, doc.utterances[0]!.words[1]!.range), 'https://www.example.com/path?token=abc');
});

test('abbreviations do not end sentences, and each sentence highlights its own text', () => {
  const markdown = 'Use tools, e.g. linters. Then ship it! Done?';
  const doc = buildDocument(markdown);
  assert.deepEqual(doc.utterances.map(utteranceText), ['Use tools, e.g. linters.', 'Then ship it!', 'Done?']);
  assert.deepEqual(doc.utterances.map(u => slice(markdown, u.range)), ['Use tools, e.g. linters.', 'Then ship it!', 'Done?']);
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
  // Each piece highlights its own part of the sentence, in order.
  const starts = doc.utterances.map(u => u.range!.character);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.equal(new Set(starts).size, starts.length);
  const long = buildDocument(`Value \`${'x'.repeat(700)}\` end.`).utterances;
  assert.ok(long.every(u => utteranceText(u).length <= 300));
});

test('approved descriptions replace a block narration and highlight the whole block', () => {
  const markdown = '# Results\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nAfter.';
  const original = buildDocument(markdown);
  const table = original.blocks.findIndex(block => block.kind === 'table');
  const doc = buildDocument(markdown, { overrides: new Map([[table, 'The table has one row. A is 1, and B is 2.']]) });
  assert.deepEqual(doc.utterances.map(utteranceText), ['Results.', 'The table has one row.', 'A is 1, and B is 2.', 'After.']);
  assert.ok(doc.utterances.slice(1, 3).every(u => slice(markdown, u.range) === '| A | B |\n| - | - |\n| 1 | 2 |' && u.words.every(word => word.range === null)));
  assert.equal(doc.blocks[table]!.first, 1);
  assert.equal(doc.blocks.at(-1)!.first, 3);
});

test('multi-word inline code is one highlight with separately spoken words', () => {
  const markdown = 'Run `npm run build` now.';
  const words = buildDocument(markdown).utterances[0]!.words;
  assert.deepEqual(words.map(word => word.text), ['Run', 'npm', 'run', 'build', 'now']);
  assert.ok(words.slice(1, 4).every(word => slice(markdown, word.range) === 'npm run build'));
});

test('free text is split into words with punctuation as separators', () => {
  assert.deepEqual(textWords('Hello, "world" — again!').map(w => [w.text, w.sep]),
    [['Hello', ', '], ['world', '"— '], ['again', '!']]);
});

test('the demonstration maps every spoken word to its source with no raw Markdown or URLs spoken', () => {
  const markdown = readFileSync('examples/demo.md', 'utf8');
  const doc = buildDocument(markdown);
  assertWordsInSource(markdown, doc);
  const text = doc.utterances.map(utteranceText).join(' ');
  assert.ok(doc.utterances.length > 15);
  assert.ok(!/https?:|\*\*|`|\]\(/.test(text));
  assert.ok(text.includes('State: Ready'));
  assert.ok(doc.blocks.some(block => block.heading?.level === 2));
  const words = doc.utterances.flatMap(u => u.words);
  const mapped = words.filter(word => word.range).length;
  assert.ok(mapped / words.length > 0.85, `${mapped} of ${words.length} words are highlighted`);
  assert.ok(doc.utterances.every(u => u.range), 'every passage highlights something');
});

test('empty documents produce nothing to read', () => {
  assert.deepEqual(buildDocument(' \n---\n').utterances, []);
});

test('the Wagyu field guide (examples/wagyu.md) exercises every feature and maps every word', () => {
  const markdown = readFileSync('examples/wagyu.md', 'utf8');
  const doc = buildDocument(markdown);
  assertWordsInSource(markdown, doc);
  const texts = doc.utterances.map(utteranceText);
  const all = texts.join(' ');
  const has = (text: string) => assert.ok(texts.includes(text), `missing "${text}"`);
  // Never read: front matter, comments, raw HTML blocks, link targets, Markdown syntax.
  assert.ok(!/purpose|Check:|This comment|treats were|must never run|https?:|\*\*|`|\]\(|\[!/.test(all), all);
  has('The Wagyu Field Guide.');
  has('Image: Wagyu, a red Shiba Inu, reading a Markdown page aloud.');
  has('1. Meet Wagyu.');
  // Line breaks: one phrase per line.
  has('The sunny spot by the window.');
  has('Under the desk, behind the cables.');
  // The table.
  has('Table with 7 rows. Columns: Fact, Wagyu, Typical Shiba Inu.');
  has('Weight. Wagyu: empty. Typical Shiba Inu: 8–11 kg.');
  has('Motto. Wagyu: if (treat) sit();. Typical Shiba Inu: Stubborn independent.');
  // Quotes, alerts, lists and tasks.
  has('Quote: Wagyu preferred a long, theatrical sigh.');
  for (const alert of ['Note:', 'Tip:', 'Important:', 'Warning:', 'Caution:']) assert.ok(texts.some(text => text.startsWith(alert)), alert);
  has('6. Wake up at 6:30 AM and stare at the bed until someone notices.');
  has('Kibble with a spoonful of pumpkin.');
  has('10. Zoomies, at exactly 8:00 PM.');
  has('Completed: Yellow harness.');
  has('Not completed: Empty water bottle, for chewing.');
  has('Sit: reliable, unless a squirrel was involved.');
  // Code blocks are announced.
  for (const code of ['Code block, JavaScript, 4 lines.', 'Code block, Python, 4 lines.', 'Code block, shell, 1 line.', 'Code block, JSON, 1 line.',
    'Code block, Kusto query, 3 lines.', 'Diagram, 2 lines.', 'Code block, 3 lines.', 'Code block, 1 line.']) has(code);
  // Images, links, keys and edge cases.
  has('Image.');
  has('A reference-style image: Image: Wagyu by reference.');
  has('An autolink: akc.org.');
  has('A bare web address: en.wikipedia.org.');
  has('A reference link: Shiba Inu on Wikipedia.');
  has('Press Space to pause, or right arrow to skip to the next paragraph.');
  has('Level six: toe beans.');
  has('Another setext heading.');
  has('Escaped characters stay literal: *not italic*, # not a heading, and 2 * 3 = 6.');
  has('Emoji are shown but not read: Wagyu loved bones and sweet potatoes.');
  has('Wagyu would like a treat now.');
  const long = texts.findIndex(text => text.startsWith('A very long sentence'));
  assert.ok(texts[long + 1]!.startsWith('negotiated') && texts[long + 2]!.startsWith('and then'), 'the long sentence is split at commas');
  // Sections for Shift+↑ / Shift+↓: every heading starts somewhere.
  assert.equal(doc.blocks.filter(block => block.kind === 'heading' && block.first >= 0).length, 19, '19 headings, including two setext ones');
});

test('<kbd> arrows are key names, hard line breaks are phrases, and * between numbers is multiplication', () => {
  assert.deepEqual(spoken('Press <kbd>→</kbd> or <kbd>Shift</kbd>+<kbd>←</kbd>.'), ['Press right arrow or Shift+ left arrow.']);
  assert.deepEqual(spoken('Settings → Extensions.'), ['Settings → Extensions.'], 'outside <kbd> an arrow keeps its meaning');
  assert.deepEqual(spoken('One  \nTwo\\\nThree<br>Four'), ['One.', 'Two.', 'Three.', 'Four.']);
  assert.deepEqual(spoken('| A |\n| - |\n| x<br>y |'), ['Table with 1 row. Columns: A.', 'x, y.']);
  const words = buildDocument('2 * 3 = 6, but *this* is emphasis and a * star alone is not.').utterances[0]!.words.map(word => word.text);
  assert.deepEqual(words.slice(0, 5), ['2', '*', '3', '=', '6']);
  assert.equal(words.filter(word => word === '*').length, 1);
});
