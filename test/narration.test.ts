import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { narrate, parseProposal, splitSpeech } from '../src/narration';

test('reads labelled bullets as sentences, not formatting characters', () => {
  const result = narrate('- **Mail:** send the [draft](https://example.com/secret).\n- Keep `userId` unchanged.');
  assert.deepEqual(result.map(item => item.text), ['Mail: send the draft.', 'Keep userId unchanged.']);
  assert.ok(result.every(item => item.kind === 'list'));
});

test('nested lists, continuation paragraphs, task state and ordered starts', () => {
  const result = narrate('3. First\n\n   More detail.\n   - Nested\n4. Last\n\n- [x] Done\n- [ ] Next');
  assert.deepEqual(result.map(item => item.text), [
    '3. First.', 'More detail.', 'Sub-item: Nested.', '4. Last.', 'Completed. Done.', 'Not completed. Next.'
  ]);
});

test('reads every table value with its header, including empty cells and escaped pipes', () => {
  const result = narrate('| Service | State | Detail |\n| --- | --- | --- |\n| Mail | **Ready** | A \\| B |\n| Search | | [Open](https://example.com) |');
  assert.deepEqual(result.map(item => item.text), [
    'Table with 2 rows and 3 columns.',
    'Row 1. Service: Mail. State: Ready. Detail: A | B.',
    'Row 2. Service: Search. State: empty. Detail: Open.'
  ]);
  assert.equal(result[1]!.line, 2);
  assert.equal(result[2]!.line, 3);
});

test('column mode preserves row identity and values', () => {
  const result = narrate('| Name | Count |\n| --- | --- |\n| Ada | 7 |\n| Bo | 9 |', { tableMode: 'columns' });
  assert.deepEqual(result.map(item => item.text), [
    'Table with 2 rows and 2 columns.',
    'Column Name. Row 1: Ada. Row 2: Bo.',
    'Column Count. Row 1, Ada: 7. Row 2, Bo: 9.'
  ]);
});

test('front matter is omitted without corrupting source line numbers', () => {
  const result = narrate('---\r\ntitle: Internal\r\n---\r\n\r\n# Hello\r\n\r\nText.');
  assert.equal(result[0]!.text, 'Hello.');
  assert.equal(result[0]!.line, 4);
  assert.equal(result[1]!.line, 6);
});

test('headings, quotes, images, HTML and code have explicit narration behavior', () => {
  const result = narrate('# Title\n\n> Think carefully.\n\n![A diagram](chart.svg)\n\n<script>alert("unsafe")</script>\n\n```js\nrun();\nstop();\n```');
  assert.deepEqual(result.map(item => item.text), [
    'Title.', 'Quote: Think carefully.', 'Image: A diagram.',
    'HTML block omitted from narration.', 'Code block, js, 2 lines.',
    'Code contents skipped. Use the code block setting to read them.'
  ]);
  assert.ok(narrate('```\nlet x = 1;\n```', { codeBlocks: 'read' }).some(item => item.text === 'let x = 1;'));
});

test('bare autolinks speak the host without query strings', () => {
  assert.equal(narrate('Visit <https://example.com/path?token=abc>.')[0]!.text, 'Visit example.com.');
});

test('speech chunks prefer sentence boundaries, remain bounded, and preserve words', () => {
  assert.deepEqual(splitSpeech('One short sentence. Another short sentence. The final short sentence.', 45), [
    'One short sentence. Another short sentence.', 'The final short sentence.'
  ]);
  const text = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
  const chunks = splitSpeech(text);
  assert.ok(chunks.every(part => part.length <= 650));
  assert.equal(chunks.join(' '), text);
  assert.ok(splitSpeech('x'.repeat(1600)).every(part => part.length <= 650));
  assert.throws(() => splitSpeech('text', 1));
});

test('empty Markdown is empty and the demonstration has no raw formatting', () => {
  assert.deepEqual(narrate(' \n---\n'), []);
  const demo = readFileSync('examples/demo.md', 'utf8');
  const segments = narrate(demo);
  assert.ok(segments.length > 15);
  assert.ok(segments.some(item => item.text.includes('State: Ready')));
  assert.ok(!segments.map(item => item.text).join(' ').includes('https://'));
});

test('AI proposals require valid JSON, preserve passage count and retain source mapping', () => {
  const original = narrate('# Title\n\nText.');
  const proposal = parseProposal('["A title.", "A smoother sentence."]', original);
  assert.deepEqual(proposal.map(item => item.text), ['A title.', 'A smoother sentence.']);
  assert.equal(proposal[1]!.line, 2);
  for (const value of ['not json', '["Only one"]', '["ok", ""]', '["ok", 1]', '{"a":"b"}']) {
    assert.throws(() => parseProposal(value, original));
  }
});
