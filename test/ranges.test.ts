import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildDocument, type SourceRange } from '../src/document';
import { applyChanges, locate, shiftLine, shiftRange, type TextChange } from '../src/ranges';

const range = (line: number, character: number, endLine: number, endCharacter: number): SourceRange => ({ line, character, endLine, endCharacter });
const change = (line: number, character: number, endLine: number, endCharacter: number, text: string): TextChange =>
  ({ start: { line, character }, end: { line: endLine, character: endCharacter }, text });

test('ranges before an edit stay, ranges after it move, and edited text loses its range', () => {
  const word = range(2, 4, 2, 9);
  assert.deepEqual(shiftRange(word, change(2, 10, 2, 10, 'abc')), word, 'typing after the word');
  assert.deepEqual(shiftRange(word, change(2, 9, 2, 9, 'x')), word, 'typing right after the word');
  assert.deepEqual(shiftRange(word, change(2, 0, 2, 0, 'ab')), range(2, 6, 2, 11), 'typing before it on the same line');
  assert.deepEqual(shiftRange(word, change(2, 4, 2, 4, '>')), range(2, 5, 2, 10), 'typing right before it');
  assert.deepEqual(shiftRange(word, change(0, 0, 0, 0, 'new\nlines\n')), range(4, 4, 4, 9), 'lines added above');
  assert.deepEqual(shiftRange(word, change(1, 3, 2, 1, '')), range(1, 6, 1, 11), 'a line join above it');
  assert.equal(shiftRange(word, change(2, 6, 2, 12, 'zz')), null, 'part of the word replaced');
  assert.deepEqual(shiftRange(range(2, 0, 4, 5), change(3, 1, 3, 2, 'many\nmore')), range(2, 0, 5, 5), 'edit inside a sentence stretches it');
  assert.equal(shiftLine(10, change(2, 0, 4, 0, 'x\n')), 9);
  assert.equal(shiftLine(3, change(2, 0, 4, 0, 'x\n')), 2);
  assert.equal(shiftLine(1, change(2, 0, 4, 0, 'x\n')), 1);
});

test('edits keep highlights on the right words, applied in any order', () => {
  const markdown = '# Title\n\nFirst sentence here. Second one.\n\nLast line.';
  const doc = buildDocument(markdown);
  // Two edits described against the original text, as VS Code reports multi-cursor edits.
  applyChanges(doc, [change(0, 2, 0, 2, 'New '), change(2, 0, 2, 0, 'Intro. ')]);
  const edited = '# New Title\n\nIntro. First sentence here. Second one.\n\nLast line.'.split('\n');
  const text = (r: SourceRange | null) => (r ? edited[r.line]!.slice(r.character, r.endCharacter) : null);
  assert.equal(text(doc.utterances[0]!.range), 'Title');
  assert.equal(text(doc.utterances[1]!.range), 'First sentence here.');
  assert.equal(text(doc.utterances[2]!.words[0]!.range), 'Second');
  applyChanges(doc, [change(1, 0, 1, 0, '\n\n')]);
  assert.equal(doc.utterances[3]!.range!.line, 6);
  assert.equal(doc.blocks[2]!.line, 6);
});

test('a cursor position maps to the passage and word to read from', () => {
  const markdown = 'One two three. Four five.\n\n| Name | State |\n| --- | --- |\n| Mail | Ready |\n\nEnd.';
  const doc = buildDocument(markdown);
  assert.deepEqual(locate(doc, { line: 0, character: 0 }), { index: 0, word: -1 });
  assert.deepEqual(locate(doc, { line: 0, character: 5 }), { index: 0, word: 1 }, 'inside "two"');
  assert.deepEqual(locate(doc, { line: 0, character: 14 }), { index: 1, word: -1 }, 'between sentences');
  const row = doc.utterances.findIndex(u => u.line === 4);
  const ready = doc.utterances[row]!.words.findIndex(w => w.text === 'Ready');
  assert.deepEqual(locate(doc, { line: 4, character: 10 }), { index: row, word: ready }, 'a table cell');
  assert.deepEqual(locate(doc, { line: 4, character: 0 }), { index: row, word: -1 });
  assert.deepEqual(locate(doc, { line: 5, character: 0 }), { index: doc.utterances.length - 1, word: -1 }, 'a blank line reads what follows');
  assert.deepEqual(locate(doc, { line: 99, character: 0 }), { index: doc.utterances.length - 1, word: -1 });
});
